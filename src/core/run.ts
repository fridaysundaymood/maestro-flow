import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createResult, runArtifactDir, writeArtifactIndex, type Result } from '@budaknyenyel/kit-schema';

export interface CommandResult { code: number | null; stdout: string; stderr: string; interrupted?: boolean }
export type CommandRunner = (command: string, args: string[], signal?: AbortSignal) => Promise<CommandResult>;
interface EmuLabScheduler {
  probe(leaseId: string, serial?: string): Promise<{ serial: string; profile: string }>;
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

export function windowsBatchArguments(command: string, args: string[]): string[] {
  if ([command, ...args].some((part) => /["\r\n%&|<>^]/.test(part))) throw new Error('Unsafe Windows command argument');
  return ['/d', '/s', '/c', `"${[command, ...args].map((part) => `"${part}"`).join(' ')}"`];
}

export const runCommand: CommandRunner = (command, args, signal, timeoutMs = 900_000) => {
  const { promise, resolve } = Promise.withResolvers<CommandResult>();
  if (signal?.aborted) return Promise.resolve({ code: null, stdout: '', stderr: '', interrupted: true });
  let executable = command;
  let argv = args;
  const batch = process.platform === 'win32' && (/(?:\.cmd|\.bat)$/i.test(command) || command.toLowerCase() === 'maestro');
  if (batch) {
    try { argv = windowsBatchArguments(command, args); }
    catch { return Promise.resolve({ code: null, stdout: '', stderr: 'Unsafe Windows command argument' }); }
    executable = process.env.ComSpec || 'cmd.exe';
  }
  const child = spawn(executable, argv, { windowsHide: true, windowsVerbatimArguments: batch, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let interrupted = false;
  let timedOut = false;
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  // cmd.exe is the direct child on Windows; kill the whole tree or the JVM survives.
  const kill = () => {
    if (batch && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
    else child.kill();
  };
  const abort = () => { interrupted = true; kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  child.on('error', (error) => { stderr += error.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    resolve({ code: timedOut ? null : code, stdout, stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms` : stderr, interrupted });
  });
  return promise;
};

export function supportedMaestroVersion(output: string): boolean {
  const match = output.match(/(?:^|[^a-z0-9])v?(\d+)\.(\d+)\.(\d+)([-+][\w.-]+)?\b/i);
  return !!match && !match[4]?.startsWith('-') && (Number(match[1]) === 1 && Number(match[2]) >= 39 || Number(match[1]) === 2 && (Number(match[2]) < 12 || Number(match[2]) === 12 && Number(match[3]) <= 1));
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
      const packageName = '@budaknyenyel/emu-lab';
      const emu = await (options.emuLabLoader ? options.emuLabLoader() : import(packageName) as Promise<EmuLabModule>);
      scheduler = new emu.Scheduler({ databasePath: resolve(root, databasePath) });
      await scheduler.probe(leaseId, options.serial);
      const leased = await scheduler.withLease(leaseId, options.serial, async (serial, leaseSignal) => {
        const signal = options.signal ? AbortSignal.any([options.signal, leaseSignal]) : leaseSignal;
        return runFlow({ ...options, serial, signal, emuLab: undefined, emuLabLoader: undefined });
      });
      if (leased.status !== 'pass' && leased.status !== 'flaky' && !options.signal?.aborted) {
        evidence.push(...leased.evidence);
        artifacts.push(...leased.artifacts);
        await scheduler.probe(leaseId, options.serial);
      }
      leased.evidence.push({ kind: 'emu-lab-lease', lease_id: leaseId });
      return leased;
    } catch (error) {
      if (error instanceof Error && error.name === 'DeviceUnresponsiveError' && 'freed' in error && typeof error.freed === 'boolean') {
        evidence.push({ kind: 'emu-lab-quarantine', reason: error.message, freed: error.freed });
        return result('blocked', 'The leased device failed liveness and was quarantined.', 'environment');
      }
      if (scheduler && error instanceof Error && [
        'lease is not active or does not contain the requested device',
        'lease does not authorize this device or ownership cannot be verified',
        'lease does not authorize this device',
        'lease released',
      ].includes(error.message)) {
        evidence.push({ kind: 'emu-lab-lease-unavailable', reason: error.message });
        return result('blocked', 'The requested lease is unavailable or cannot be verified.', 'environment');
      }
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
    if (!supportedMaestroVersion(versionText)) return finish('unsupported', 'Maestro version must be >=1.39.0 and <=2.12.1.', 'environment');
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
      if (hierarchy && /(?:system ui|com\.android\.systemui)/i.test(hierarchy) && /(?:isn.t responding|not responding)/i.test(hierarchy)) {
        // Dismiss the dialog by its Wait control, then rerun the unchanged flow once.
        const wait = /text="(Wait|Close app)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(hierarchy);
        if (wait) await runner(options.adb || 'adb', ['-s', serial, 'shell', 'input', 'tap', String((+wait[2] + +wait[4]) / 2), String((+wait[3] + +wait[5]) / 2)], options.signal);
        else await runner(options.adb || 'adb', ['-s', serial, 'shell', 'input', 'keyevent', '4'], options.signal);
        evidence.push({ kind: 'failure-classification', attempt, category: 'environment', reason: 'system-ui-anr', hierarchy_captured: true, dismissed_with: wait ? 'wait-button' : 'back' });
        if (attempt === 1) continue;
        return finish('blocked', 'System UI is not responding; device environment prevented the run. Expectations were not changed.', 'environment');
      }
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
      return kind === 'stale-selector'
        ? finish('fail', 'Stale selector detected; no safe automatic tap repair was available.', 'test')
        : finish('fail', 'Failure could not be classified from available evidence.');
    }
    return finish('fail', 'Iteration limit reached without resolving the flow.');
  } catch {
    return finish('error', 'Device execution or artifact recording failed; device state was not restored.', 'environment');
  }
}
