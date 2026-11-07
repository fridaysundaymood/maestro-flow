import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { buildIndex, formatSelector } from './indexer.js';
import { lintFlow } from './lint.js';

test('format selectors escape literals, bound arguments, and reject unsupported constructs', () => {
  const regex = formatSelector('Cost (%1$d): %2$s + %1$d / 100%%').regex;
  assert.ok(regex);
  assert.match('Cost (12): apples + 12 / 100%', new RegExp(regex));
  assert.doesNotMatch('Cost 12: apples + 12 / 100%', new RegExp(regex));
  assert.ok(formatSelector('Unsupported %1$.2f').error);
});

test('indexes resources and merged hierarchy deterministically and lints flows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-index-'));
  try {
    await mkdir(join(root, 'app/src/main/res/values'), { recursive: true });
    await mkdir(join(root, 'app/src/main/res/values-fr'), { recursive: true });
    await writeFile(join(root, 'app/src/main/res/values/strings.xml'), `<resources><string name="add">Add task</string><string name="boards">Boards</string><string name="bad">%1$.2f</string><plurals name="count"><item quantity="one">%d item</item><item quantity="other">%d items</item></plurals><string-array name="items"><item>First</item><item>Second</item></string-array></resources>`);
    await writeFile(join(root, 'app/src/main/res/values-fr/strings.xml'), '<resources><string name="add">Ajouter</string></resources>');
    await writeFile(join(root, 'hierarchy.xml'), '<hierarchy><node text="Merged label" content-desc="Merged action"/></hierarchy>');
    const index = await buildIndex(root, { hierarchyPaths: ['hierarchy.xml'] });
    assert.deepEqual(index, await buildIndex(root, { hierarchyPaths: ['hierarchy.xml'] }));
    assert.equal(index.resources.filter(entry => entry.kind === 'plural').length, 2);
    assert.equal(index.resources.filter(entry => entry.kind === 'array').length, 2);
    assert.equal(index.unsupported[0].key, 'bad');
    assert.ok(index.semantics.some(entry => entry.value === 'Merged action'));
    const flow = join(root, 'flow.yaml');
    await writeFile(flow, 'appId: fixture\n---\n- launchApp\n- extendedWaitUntil:\n    visible: Boards\n- tapOn: New task\n- tapOn:\n    point: 50%,50%\n- assertVisible: "42"\n');
    const result = await lintFlow(flow, index);
    assert.deepEqual(await lintFlow(flow, index, { maestroVersion: '2.12.1' }), result);
    await assert.rejects(lintFlow(flow, index, { maestroVersion: '2.12.2' }), /Unsupported Maestro version/);
    assert.ok(result.diagnostics.some(item => item.ruleId === 'MF001' && item.selector === 'New task'));
    assert.ok(result.diagnostics.some(item => item.ruleId === 'MF004'));
    assert.ok(result.diagnostics.some(item => item.ruleId === 'MF006'));
    const suppressed = await lintFlow(flow, index, { suppressions: [{ ruleId: 'MF001', reason: 'synthetic case', file: flow }, { ruleId: 'MF005', reason: 'unused', file: flow }, { ruleId: 'NOPE', reason: 'invalid', file: flow }] });
    assert.ok(!suppressed.diagnostics.some(item => item.ruleId === 'MF001'));
    assert.ok(suppressed.diagnostics.some(item => item.ruleId === 'MF007'));
    assert.ok(suppressed.diagnostics.some(item => item.ruleId === 'MF008'));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test('recognizes entered values, interpolations, and Maestro regex selectors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maestro-dynamic-'));
  try {
    const resources = join(root, 'app/src/main/res/values');
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, 'strings.xml'), '<resources><string name="total">Total (IDR)</string><string name="spent">Amount spent</string><string name="count">Count: %1$d</string><string name="add">Add task</string></resources>');
    const flow = join(root, 'flow.yaml');
    await writeFile(flow, `appId: fixture
---
- inputText: Lunch 25
- assertVisible: Lunch 25
- tapOn: Lunch 25
- inputText: \${VAR}
- assertVisible: \${VAR}
- tapOn: \${output.value}
- assertVisible: 'Total \\(IDR\\)'
- assertVisible: '.*spent.*'
- assertVisible: 'Count: [0-9]+'
- assertVisible: 'Rp ?[0-9.]+'
- assertVisible: Unrelated dynamic content
- tapOn: New task
`);
    const result = await lintFlow(flow, await buildIndex(root));
    assert.deepEqual(result.diagnostics.filter(item => item.ruleId === 'MF001').map(item => item.selector), ['New task']);
    assert.ok(result.diagnostics.some(item => item.ruleId === 'MF002' && item.message.includes('not found in resources') && item.selector === 'Unrelated dynamic content'));
    for (const selector of ['Lunch 25', '${VAR}', '${output.value}', 'Total \\(IDR\\)', '.*spent.*', 'Count: [0-9]+', 'Rp ?[0-9.]+']) {
      assert.ok(!result.diagnostics.some(item => item.selector === selector), selector);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test('shared fixture stale copy is flagged', async () => {
  const fixture = resolve('../kit-fixture-app');
  const index = await buildIndex(fixture);
  const flow = join(fixture, 'e2e/maestro/stale-add-task.yaml');
  const result = await lintFlow(flow, index, { locale: 'default' });
  assert.ok(result.diagnostics.some(item => item.selector === 'New task' && item.ruleId === 'MF001'));
}, 30_000);
