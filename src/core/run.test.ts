import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFailure, runCommand, runFlow, supportedMaestroVersion, windowsBatchArguments, type CommandResult, type CommandRunner } from './run.js';

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'maestro-run-'));
  roots.push(root);
  await writeFile(join(root, 'flow.yaml'), '- tapOn: "New task"\n- assertVisible: "Expected value"\n');
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const failed = (stdout = ''): CommandResult => ({ code: 1, stdout, stderr: '' });
const hierarchy = '<hierarchy><node text="Tasks" content-desc=""/><node text="Add task" content-desc=""/></hierarchy>';
function commands(attempts: CommandResult[], xml = hierarchy) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') return ok('1.39.0');
    if (args.includes('get-state')) return ok('device\n');
    if (args.includes('uiautomator')) return ok(xml);
    return attempts.shift() ?? failed();
  };
  return { runner, calls };
}

describe('device execution', () => {
  it('quotes Windows batch commands with spaces and rejects shell metacharacters', () => {
    expect(windowsBatchArguments('C:\\Program Files\\Maestro\\maestro.bat', ['--version'])).toEqual([
      '/d', '/s', '/c', '""C:\\Program Files\\Maestro\\maestro.bat" "--version""',
    ]);
    expect(() => windowsBatchArguments('maestro.bat', ['bad&command'])).toThrow();
  });
  it.skipIf(process.platform !== 'win32')('runs a Windows batch launcher in a path with spaces', async () => {
    const root = await project();
    const folder = join(root, 'launcher with spaces');
    await mkdir(folder);
    const launcher = join(folder, 'maestro.bat');
    await writeFile(launcher, '@echo off\r\necho Maestro 1.40.0\r\n');
    const result = await runCommand(launcher, ['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('1.40.0');
  });
  it('checks the supported Maestro range', () => {
    expect(supportedMaestroVersion('Maestro 1.39.0')).toBe(true);
    expect(supportedMaestroVersion('2.12.1')).toBe(true);
    expect(supportedMaestroVersion('2.12.2')).toBe(false);
    expect(supportedMaestroVersion('1.38.9')).toBe(false);
    expect(supportedMaestroVersion('1.39.0-beta')).toBe(false);
  });
  it('uses the selected serial and preserves evidence in the run directory', async () => {
    const root = await project();
    const { runner, calls } = commands([ok()]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'emulator-5554', runId: 'pass', runner });
    expect(result.status).toBe('pass');
    expect(calls.some((call) => call.includes('--device') && call.includes('emulator-5554'))).toBe(true);
    expect(calls.some((call) => call.includes('-s') && call.includes('emulator-5554'))).toBe(true);
    expect(result.artifacts).toContain('.android-kit/runs/pass/maestro-flow/attempt-1.log');
  });
  it('indexes Maestro debug files', async () => {
    const root = await project();
    const original = commands([ok()]).runner;
    const runner: CommandRunner = async (command, args, signal) => {
      if (args.includes('--debug-output')) {
        const debug = args[args.indexOf('--debug-output') + 1];
        await mkdir(join(debug, 'nested'), { recursive: true });
        await writeFile(join(debug, 'nested', 'failure.txt'), 'synthetic');
      }
      return original(command, args, signal);
    };
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', runId: 'debug', runner });
    expect(result.artifacts).toContain('.android-kit/runs/debug/maestro-flow/debug-1/nested/failure.txt');
  });
  it('uses an existing emu-lab lease and closes the scheduler', async () => {
    const root = await project();
    const { runner, calls } = commands([ok()]);
    let closed = false;
    class Scheduler {
      constructor(_options: { databasePath: string }) {}
      async withLease<T>(id: string, serial: string | undefined, callback: (serial: string, signal: AbortSignal) => Promise<T>): Promise<T> {
        expect(id).toBe('lease-1');
        expect(serial).toBeUndefined();
        return callback('emulator-5558', new AbortController().signal);
      }
      close() { closed = true; }
    }
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', emuLab: { databasePath: 'leases.db', leaseId: 'lease-1', packageName: 'dev.fixture' }, emuLabLoader: async () => ({ Scheduler }), runner });
    expect(result.status).toBe('pass');
    expect(calls.some((call) => call.includes('--device') && call.includes('emulator-5558'))).toBe(true);
    expect(closed).toBe(true);
  });
  it('reports missing emu-lab without falling back to an unleased device', async () => {
    const root = await project();
    const { runner, calls } = commands([ok()]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', emuLab: { databasePath: 'leases.db', leaseId: 'lease-1', packageName: 'dev.fixture' }, emuLabLoader: async () => { throw new Error('unavailable'); }, runner });
    expect(result.status).toBe('error');
    expect(calls).toHaveLength(0);
  });
  it('reports a successful unchanged rerun as flaky', async () => {
    const root = await project();
    const { runner } = commands([failed('Element not found'), ok()]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', runner });
    expect(result.status).toBe('flaky');
  });
  it('retries an evidenced System UI ANR without changing the flow', async () => {
    const root = await project();
    const xml = '<hierarchy><node package="com.android.systemui" text="System UI isn\'t responding"/></hierarchy>';
    const { runner, calls } = commands([failed('assertVisible failed'), ok()], xml);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: 'Tasks', runner });
    expect(result.status).toBe('flaky');
    expect(result.evidence).toContainEqual(expect.objectContaining({ category: 'environment', reason: 'system-ui-anr' }));
    expect(calls.filter((call) => call.includes('test'))).toHaveLength(2);
    expect(await readFile(join(root, 'flow.yaml'), 'utf8')).toContain('assertVisible: "Expected value"');
  });
  it('blocks when System UI remains unresponsive', async () => {
    const root = await project();
    const xml = '<hierarchy><node package="com.android.systemui" text="System UI isn\'t responding"/></hierarchy>';
    const { runner, calls } = commands([failed(), failed()], xml);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: 'Tasks', runner });
    expect(result.status).toBe('blocked');
    expect(result.classification).toBe('environment');
    expect(calls.filter((call) => call.includes('test'))).toHaveLength(2);
  });
  it('repairs only a uniquely evidenced tap selector, not assertions', async () => {
    const root = await project();
    const { runner } = commands([failed('Element not found: New task'), ok()]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: 'Tasks', selectorRepair: { old: 'New task', replacement: 'Add task' }, runner });
    expect(result.status).toBe('pass');
    const flow = await readFile(join(root, 'flow.yaml'), 'utf8');
    expect(flow).toContain('tapOn: "Add task"');
    expect(flow).toContain('assertVisible: "Expected value"');
  });
  it('stops on a wrong screen or app crash without changing the flow', async () => {
    for (const [output, anchor, classification] of [['not found', 'Settings', 'test'], ['FATAL EXCEPTION', 'Tasks', 'app']] as const) {
      const root = await project();
      const { runner, calls } = commands([failed(output)]);
      const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: anchor, runner });
      expect(result.classification).toBe(classification);
      expect(calls.filter((call) => call.includes('test'))).toHaveLength(1);
      expect(await readFile(join(root, 'flow.yaml'), 'utf8')).toContain('Expected value');
    }
  });
  it('does not attempt an assertion repair', async () => {
    const root = await project();
    await writeFile(join(root, 'flow.yaml'), '- assertVisible: "New task"\n');
    const { runner } = commands([failed('Element not found: New task')]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: 'Tasks', selectorRepair: { old: 'New task', replacement: 'Add task' }, runner });
    expect(result.status).toBe('fail');
    expect(await readFile(join(root, 'flow.yaml'), 'utf8')).toContain('New task');
  });
  it('stops on a wrong value assertion without changing expectations', async () => {
    const root = await project();
    const { runner, calls } = commands([failed('assertVisible failed: Expected value')]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', screenAnchor: 'Tasks', runner });
    expect(result.classification).toBe('app');
    expect(calls.filter((call) => call.includes('test'))).toHaveLength(1);
    expect(await readFile(join(root, 'flow.yaml'), 'utf8')).toContain('assertVisible: "Expected value"');
  });
  it('reports interruption without claiming device restoration', async () => {
    const root = await project();
    const { runner } = commands([{ code: null, stdout: '', stderr: '', interrupted: true }]);
    const result = await runFlow({ projectRoot: root, flow: 'flow.yaml', serial: 'device', runner });
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('not restored');
  });
  it('distinguishes missing evidence and navigation', () => {
    expect(classifyFailure({ output: '', screenAnchor: 'Tasks' })).toBe('unknown');
    expect(classifyFailure({ output: '', hierarchy, screenAnchor: 'Settings' })).toBe('navigation');
  });
});
