import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createResult, runArtifactDir, writeArtifactIndex, type Result } from '@android-kit/schema';

export interface CommandResult { code: number | null; stdout: string; stderr: string; interrupted?: boolean }
export type CommandRunner = (command: string, args: string[], signal?: AbortSignal) => Promise<CommandResult>;
interface EmuLabScheduler {
  withLease<T>(leaseId: string, serial: string | undefined, callback: (serial: string, signal: AbortSignal) => Promise<T>): Promise<T>;
  close(): void;
}
interface EmuLabModule {
  Scheduler: new (options: { databasePath: string }) => EmuLabScheduler;
}
export interface RunOptions {
  flow: string;
  serial?: string;
  projectRoot?: string;
  runId?: string;
  suite?: boolean;
  signal?: AbortSignal;
  /** Text uniquely identifying the expected screen in a merged accessibility hierarchy. */
  screenAnchor?: string;
  /** An evidenced replacement for an obsolete tap selector, never an assertion. */
  selectorRepair?: { old: string; replacement: string };
  runner?: CommandRunner;
  maestro?: string;
  adb?: string;
  emuLab?: { databasePath: string; leaseId: string; packageName: string };
  emuLabLoader?: () => Promise<EmuLabModule>;
}
export type RunResult = Result;

export const runCommand: CommandRunner = (command, args, signal) => new Promise((resolveResult) => {
  if (signal?.aborted) return resolveResult({ code: null, stdout: '', stderr: '', interrupted: true });
  let executable = command;
  let argv = args;
  if (process.platform === 'win32' && (/(?:\.cmd|\.bat)$/i.test(command) || command.toLowerCase() === 'maestro')) {
    if ([command, ...args].some((part) => /["\r\n%&|<>^]/.test(part))) {
      return resolveResult({ code: null, stdout: '', stderr: 'Unsafe Windows command argument' });
    }
    executable = process.env.ComSpec || 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${[command, ...args].map((part) => `"${part}"`).join(' ')}"`];
  }
  const child = spawn(executable, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const abort = () => { interrupted = true; child.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('error', (error) => { stderr += error.message; });
  child.on('close', (code) => {
    signal?.removeEventListener('abort', abort);
    resolveResult({ code, stdout, stderr, interrupted });
  });
});

export function supportedMaestroVersion(output: string): boolean {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\b/);
  return !!match && Number(match[1]) === 1 && Number(match[2]) >= 39 && !/-/.test(match[0]);
}

function hierarchyHas(xml: string, text: string): boolean {
  const escaped = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;');
  return xml.includes(`text="${escaped}"`) || xml.includes(`content-desc="${escaped}"`);
}

export function classifyFailure(input: { output: string; hierarchy?: string; screenAnchor?: string; selectorRepair?: RunOptions['selectorRepair'] }): 'app' | 'navigation' | 'stale-selector' | 'unknown' {
  if (/\b(crash(?:ed)?|fatal exception|app has stopped)\b/i.test(input.output)) return 'app';
  if (!input.hierarchy || !input.screenAnchor) return 'unknown';
  if (!hierarchyHas(input.hierarchy, input.screenAnchor)) return 'navigation';
  const repair = input.selectorRepair;
  if (repair && input.output.includes(repair.old) && !hierarchyHas(input.hierarchy, repair.old) && hierarchyHas(input.hierarchy, repair.replacement)) return 'stale-selector';
  if (/assert(?:ion|visible|notvisible|true|false)/i.test(input.output)) return 'app';
  return 'unknown';
}

async function repairTap(flow: string, repair: NonNullable<RunOptions['selectorRepair']>): Promise<boolean> {
  const content = await readFile(flow, 'utf8');
  // Restrict edits to a unique, plain scalar tap command; assertions are never modified.
  const matches = [...content.matchAll(/^(\s*-\s*tapOn:\s*)([^\r\n#]+?)(\s*)$/gm)].filter((match) => {
    const value = match[2].trim();
    return value === JSON.stringify(repair.old) || value === `'${repair.old.replace(/'/g, "''")}'`;
  });
  if (matches.length !== 1) return false;
  const match = matches[0];
  const updated = content.slice(0, match.index) + match[1] + JSON.stringify(repair.replacement) + match[3] + content.slice(match.index! + match[0].length);
  const temporary = `${flow}.${randomUUID()}.tmp`;
  await writeFile(temporary, updated, { flag: 'wx' });
  // Refuse to overwrite concurrent edits.
  if (await readFile(flow, 'utf8') !== content) { await unlink(temporary); return false; }
  await rename(temporary, flow);
  return true;
}

export async function runFlow(options: RunOptions): Promise<RunResult> {
  const startedAt = new Date();
  const root = resolve(options.projectRoot || process.cwd());
  const runId = options.runId || randomUUID();
  const runner = options.runner || runCommand;
  const evidence: unknown[] = [];
  const artifacts: string[] = [];
  const result = (status: Result['status'], summary: string, classification?: Result['classification']): Result => createResult({ tool: 'maestro-flow', operation: 'run', run_id: runId, status, summary, ...(classification ? { classification } : {}), evidence, artifacts, startedAt });
  if (!options.flow?.trim() || (!options.emuLab && !options.serial?.trim())) return result('blocked', 'A flow path and either an adb serial or an emu-lab lease are required.', 'config');
  if (options.emuLab) {
    const { databasePath, leaseId, packageName } = options.emuLab;
    if (!databasePath?.trim() || !leaseId?.trim() || !packageName?.trim()) return result('blocked', 'An emu-lab database, lease ID and app package are required.', 'config');
    let scheduler: EmuLabScheduler | undefined;
    try {
      // Optional integration is resolved only when a lease is requested.
      const packageName = '@android-kit/emu-lab';
      const emu = await (options.emuLabLoader ? options.emuLabLoader() : import(packageName) as Promise<EmuLabModule>);
      scheduler = new emu.Scheduler({ databasePath: resolve(root, databasePath) });
      const leased = await scheduler.withLease(leaseId, options.serial, async (serial, leaseSignal) => {
        const signal = options.signal ? AbortSignal.any([options.signal, leaseSignal]) : leaseSignal;
        return runFlow({ ...options, serial, signal, emuLab: undefined, emuLabLoader: undefined });
      });
      leased.evidence.push({ kind: 'emu-lab-lease', lease_id: leaseId });
      return leased;
    } catch {
      return result(options.signal?.aborted ? 'blocked' : 'error', options.signal?.aborted ? 'Run interrupted; device state was not restored.' : 'Could not load emu-lab or authorize the requested lease.', 'environment');
    } finally {
      scheduler?.close();
    }
  }
  const serial = options.serial!;
  let directory: string;
  try { directory = runArtifactDir(root, runId, 'maestro-flow'); } catch { return result('blocked', 'Invalid run ID.', 'config'); }
  const flow = resolve(root, options.flow);
  const flowRef = relative(root, flow);
  if (isAbsolute(flowRef) || flowRef === '..' || flowRef.startsWith(`..${sep}`)) return result('blocked', 'Flow must be inside the project.', 'config');
  const save = async (name: string, data: string) => {
    const path = join(directory, name);
    await writeFile(path, data, { flag: 'wx' });
    artifacts.push(relative(root, path).split(sep).join('/'));
  };
  const collectDebug = async (path: string): Promise<void> => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await collectDebug(child);
      else if (entry.isFile()) artifacts.push(relative(root, child).split(sep).join('/'));
    }
  };
  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await mkdir(join(root, '.android-kit', 'runs', runId), { recursive: true }); await mkdir(directory); }
      catch { return result('error', 'Cannot create a fresh run artifact directory.', 'environment'); }
    } else return result('blocked', 'Run artifact directory already exists or cannot be created.', 'config');
  }
  try { await save('run-state.json', JSON.stringify({ status: 'incomplete', flow: flowRef, serial: options.serial })); }
  catch { return result('error', 'Could not record the run state.', 'environment'); }
  const finish = async (status: Result['status'], summary: string, classification?: Result['classification']) => {
    try {
      const temporary = join(directory, `run-state-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ status, summary, flow: flowRef, serial: options.serial }));
      await rename(temporary, join(directory, 'run-state.json'));
      await writeArtifactIndex(root, runId, 'maestro-flow', artifacts);
    } catch { return result('error', 'Could not write the run state or artifact index.', 'environment'); }
    return result(status, summary, classification);
  };
  try {
    const version = await runner(options.maestro || 'maestro', ['--version'], options.signal);
    if (version.interrupted) return finish('blocked', 'Run interrupted before device execution; device state was not restored.', 'environment');
    if (version.code !== 0) return finish('blocked', 'Maestro CLI is unavailable.', 'environment');
    const versionText = `${version.stdout}\n${version.stderr}`;
    evidence.push({ kind: 'tool-version', tool: 'maestro', version: versionText.trim() });
    if (!supportedMaestroVersion(versionText)) return finish('unsupported', 'Maestro version must be >=1.39.0 and <2.0.0.', 'environment');
    const device = await runner(options.adb || 'adb', ['-s', serial, 'get-state'], options.signal);
    if (device.interrupted) return finish('blocked', 'Run interrupted before device execution; device state was not restored.', 'environment');
    if (device.code !== 0 || device.stdout.trim() !== 'device') return finish('blocked', 'The selected adb device is not online.', 'environment');
    evidence.push({ kind: 'input', flow: flowRef.split(sep).join('/'), serial: options.serial, suite: !!options.suite });
    let repaired = false;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const debugDir = join(directory, `debug-${attempt}`);
      const execution = await runner(options.maestro || 'maestro', ['--device', serial, 'test', '--debug-output', debugDir, flow], options.signal);
      await save(`attempt-${attempt}.log`, `${execution.stdout}\n${execution.stderr}`);
      await collectDebug(debugDir);
      evidence.push({ kind: 'attempt', attempt, exit_code: execution.code });
      if (execution.interrupted || options.signal?.aborted) return finish('blocked', 'Run interrupted; device state was not restored.', 'environment');
      if (execution.code === null) return finish('error', 'Maestro could not be executed; device state was not restored.', 'environment');
      if (execution.code === 0) return finish(attempt === 1 || repaired ? 'pass' : 'flaky', attempt === 1 ? 'Flow passed.' : repaired ? 'Flow passed after an evidenced selector repair.' : 'Flow passed on rerun; timing is suspected.');
      const dump = await runner(options.adb || 'adb', ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], options.signal);
      if (dump.interrupted || options.signal?.aborted) return finish('blocked', 'Run interrupted; device state was not restored.', 'environment');
      const hierarchy = dump.code === 0 && dump.stdout.includes('<hierarchy') ? dump.stdout : undefined;
      if (hierarchy) await save(`hierarchy-${attempt}.xml`, hierarchy);
      const kind = classifyFailure({ output: `${execution.stdout}\n${execution.stderr}`, hierarchy, screenAnchor: options.screenAnchor, selectorRepair: options.selectorRepair });
      evidence.push({ kind: 'failure-classification', attempt, category: kind, hierarchy_captured: !!hierarchy });
      if (kind === 'app') return finish('fail', 'App failure on the expected screen or app crash; expectations were not changed.', 'app');
      if (kind === 'navigation') return finish('fail', 'Navigation failed: expected screen anchor is absent.', 'test');
      if (kind === 'stale-selector' && !repaired && !options.suite && attempt <= 3 && options.selectorRepair && await repairTap(flow, options.selectorRepair)) {
        repaired = true;
        evidence.push({ kind: 'repair', action: 'replace-tap-selector', attempt });
        continue;
      }
      // One unchanged rerun supplies evidence for timing; never claim timing from a single failure.
      if (attempt === 1 && kind === 'unknown') continue;
      return finish('fail', kind === 'stale-selector' ? 'Stale selector detected; no safe automatic tap repair was available.' : 'Failure could not be classified from available evidence.', 'test');
    }
    return finish('fail', 'Iteration limit reached without resolving the flow.', 'test');
  } catch {
    return finish('error', 'Device execution or artifact recording failed; device state was not restored.', 'environment');
  }
}
