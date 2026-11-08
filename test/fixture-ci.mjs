import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = resolve('../kit-fixture-app');
const temporary = mkdtempSync(resolve(fixture, '.maestro-fixture-'));
const index = resolve(temporary, 'selectors.json');
const cli = resolve('dist/cli/index.js');
try {
  const run = args => spawnSync(process.execPath, [cli, ...args, '--json', '--project-root', fixture, '--index', index], { encoding: 'utf8' });
  const indexed = run(['index']);
  if (indexed.status !== 0) throw new Error(`Fixture index failed: ${indexed.stdout} ${indexed.stderr}`);
  const lint = run(['lint', '--flow', 'e2e/maestro/stale-add-task.yaml']);
  const result = JSON.parse(lint.stdout);
  if (lint.status !== 1 || result.status !== 'fail' || !result.evidence.some(item => item.ruleId === 'MF001' && item.selector === 'New task')) {
    throw new Error(`Expected stale fixture selector MF001: ${lint.stdout} ${lint.stderr}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
