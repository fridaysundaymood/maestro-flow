import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeOperation } from '../src/core/service.js';
import { lintFlow } from '../src/core/lint.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function temp() { const path = await mkdtemp(join(tmpdir(), 'maestro-security-')); directories.push(path); return path; }

describe('project path boundary', () => {
  it('rejects outside and symlinked inputs and outputs', async () => {
    const root = await temp(), outside = await temp();
    await symlink(outside, join(root, 'escape'), 'junction');
    for (const input of [{ index: join(outside, 'index.json') }, { hierarchy: ['escape/secret'] }, { index: 'escape/index.json' }, { config: 'escape/config.yaml' }]) {
      const result = await executeOperation('index', { projectRoot: root, ...input });
      expect(result.status).toBe('error');
    }
  });
  it('does not overwrite unrelated files', async () => {
    const root = await temp();
    await writeFile(join(root, 'existing.json'), '{"important":true}');
    const result = await executeOperation('index', { projectRoot: root, index: 'existing.json' });
    expect(result.status).toBe('error');
    expect(await readFile(join(root, 'existing.json'), 'utf8')).toBe('{"important":true}');
  });
  it('rejects hierarchy paths from an untrusted index', async () => {
    const root = await temp(), outside = await temp();
    await mkdir(join(root, 'flows'));
    await writeFile(join(root, 'flows', 'test.yaml'), '- tapOn: test\n');
    await writeFile(join(root, 'selectors.json'), JSON.stringify({ version: 1, resources: [], semantics: [], unsupported: [], hierarchyInputs: [join(outside, 'secret')] }));
    const result = await executeOperation('lint', { projectRoot: root, flowsDir: 'flows' });
    expect(result.status).toBe('error');
  });
});

describe('regex limits', () => {
  it('terminates catastrophic flow selector matching', async () => {
    const root = await temp(), flow = join(root, 'flow.yaml');
    await writeFile(flow, '- tapOn: "(a+)+$"\n');
    const result = await lintFlow(flow, { version: 1, resources: [{ key: 'x', locale: 'default', kind: 'string', value: `${'a'.repeat(80)}!` }], semantics: [], hierarchyInputs: [], unsupported: [] });
    expect(result.diagnostics.some(item => item.ruleId === 'MF002')).toBe(true);
  }, 3000);
});
