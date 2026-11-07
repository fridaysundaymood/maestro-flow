import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/index.js';
import { executeOperation } from '../src/core/service.js';
import { toolDefinitions } from '../src/tools.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'maestro-usability-'));
  dirs.push(root);
  await writeFile(join(root, 'selectors.json'), JSON.stringify({ version: 1, resources: [], semantics: [], hierarchyInputs: [], unsupported: [] }));
  return root;
}

async function flow(root: string, path: string) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, 'appId: example\n---\n- tapOn: Unknown control\n');
}

describe('lint usability', () => {
  it('recursively discovers default flows and reports relative paths', async () => {
    const root = await project();
    await flow(root, 'e2e/maestro/first.yaml');
    await flow(root, 'e2e/maestro/nested/second.yml');
    const result = await executeOperation('lint', { projectRoot: root });
    expect(result.status).toBe('pass');
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'e2e/maestro/first.yaml' }),
      expect.objectContaining({ file: 'e2e/maestro/nested/second.yml' }),
    ]));
  });

  it('uses configured and explicit directories and preserves explicit flow selection', async () => {
    const root = await project();
    await flow(root, 'custom/one.yaml');
    await flow(root, 'override/two.yaml');
    await writeFile(join(root, 'android-kit.yaml'), 'maestroFlow:\n  flowsDir: custom\n');
    const configured = await executeOperation('lint', { projectRoot: root });
    const tool = toolDefinitions().find(item => item.name === 'maestro_flow_lint')!;
    const overridden = await tool.handler({ projectRoot: root, flowsDir: 'override' });
    const selected = await executeOperation('lint', { projectRoot: root, flow: 'custom/one.yaml', flowsDir: 'override' });
    expect(configured.evidence).toEqual([expect.objectContaining({ file: 'custom/one.yaml' })]);
    expect(overridden.evidence).toEqual([expect.objectContaining({ file: 'override/two.yaml' })]);
    expect(selected.evidence).toEqual([expect.objectContaining({ file: 'custom/one.yaml' })]);
  });

  it('matches project-relative suppression files', async () => {
    const root = await project();
    await flow(root, 'e2e/maestro/one.yaml');
    await writeFile(join(root, 'android-kit.yaml'), 'maestroFlow:\n  suppressions:\n    - ruleId: MF002\n      reason: dynamic\n      file: e2e/maestro/one.yaml\n');
    const result = await executeOperation('lint', { projectRoot: root });
    expect(result.evidence).toEqual([]);
  });

  it.each(['index', 'lint', 'generate', 'run', 'doctor'])('provides %s help without executing', async command => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main([command, '--help'])).toBe(0);
    expect(String(log.mock.calls[0][0])).toContain(`Usage: maestro-flow ${command}`);
  });

  it('provides top-level help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
    expect(String(log.mock.calls[0][0])).toContain('index, lint, generate, run, doctor');
  });
});
