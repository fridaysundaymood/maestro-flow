import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createResult, loadConfig, newRunId, runArtifactDir, writeArtifactIndex, type Result } from '@budaknyenyel/kit-schema';
import { buildIndex, type ResourceIndex } from './indexer.js';
import { lintFlow } from './lint.js';
import { generateFlows, type Journey } from './generate.js';
import { runFlow, supportedMaestroVersion } from './run.js';

export type Operation = 'index' | 'lint' | 'generate' | 'run' | 'doctor';
export interface OperationInput {
  projectRoot?: string; config?: string; runId?: string; index?: string; hierarchy?: string[];
  flow?: string; flowsDir?: string; locale?: string[]; appId?: string; journey?: string | Journey; output?: string;
  maestroVersion?: string; serial?: string; suite?: boolean; screenAnchor?: string;
  selectorRepair?: { old: string; replacement: string }; signal?: AbortSignal;
  emuLab?: { databasePath: string; leaseId: string; packageName: string };
}
interface Config {
  index?: string; hierarchy?: string[]; flow?: string; flowsDir?: string; locale?: string[]; appId?: string;
  output?: string; maestroVersion?: string; serial?: string; rootScreens?: string[]; maestro?: string; adb?: string;
  emuLab?: { databasePath: string; leaseId: string; packageName: string };
  suppressions?: { ruleId: string; reason: string; file?: string; line?: number }[];
}
const stringArray = { type: 'array', items: { type: 'string' } };
export const maestroFlowSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    index: { type: 'string' }, hierarchy: stringArray, flow: { type: 'string' }, flowsDir: { type: 'string' }, locale: stringArray,
    appId: { type: 'string' }, output: { type: 'string' }, maestroVersion: { type: 'string' },
    maestro: { type: 'string' }, adb: { type: 'string' },
    serial: { type: 'string' }, rootScreens: stringArray,
    emuLab: { type: 'object', additionalProperties: false, required: ['databasePath', 'leaseId', 'packageName'],
      properties: { databasePath: { type: 'string', minLength: 1 }, leaseId: { type: 'string', minLength: 1 }, packageName: { type: 'string', minLength: 1 } } },
    suppressions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ruleId', 'reason'], properties: { ruleId: { type: 'string' }, reason: { type: 'string', minLength: 1 }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 } } } },
  },
};
const exec = promisify(execFile);
const resolvePath = (root: string, path: string): string => {
  const target = resolve(root, path);
  const inside = (base: string, candidate: string) => {
    const rel = relative(base, candidate);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  if (!inside(root, target)) throw new Error(`Path must be inside project root: ${path}`);
  let existing = target;
  while (true) {
    try { existing = realpathSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  if (!inside(realpathSync(root), existing)) throw new Error(`Path must be inside project root: ${path}`);
  return target;
};
async function writeIndex(path: string, content: string): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Partial<ResourceIndex>;
    if (existing.version !== 1 || !Array.isArray(existing.resources) || !Array.isArray(existing.semantics) || !Array.isArray(existing.hierarchyInputs) || !Array.isArray(existing.unsupported)) throw new Error('Refusing to overwrite a file that is not a maestro-flow index');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWrite(path, content);
}
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${newRunId()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, path);
}
async function readIndex(path: string): Promise<ResourceIndex> {
  return JSON.parse(await readFile(path, 'utf8')) as ResourceIndex;
}
async function findFlows(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findFlows(path) : Promise.resolve(entry.isFile() && /\.ya?ml$/i.test(entry.name) ? [path] : []);
  }));
  return files.flat().sort();
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}
async function version(command: string, args: string[]): Promise<{ command: string; available: boolean; version?: string; fix?: string }> {
  try {
    const executable = process.platform === 'win32' && command === 'maestro' ? 'maestro.bat' : command;
    const { stdout, stderr } = await exec(executable, args, { timeout: 10000, ...(process.platform === 'win32' && command === 'maestro' ? { shell: true } : {}) });
    return { command, available: true, version: (stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch {
    return { command, available: false, fix: `Install ${command} and make it available on PATH.` };
  }
}
async function performOperation(operation: Operation, input: OperationInput = {}): Promise<Result> {
  const startedAt = new Date();
  const runId = input.runId ?? newRunId();
  const root = resolve(input.projectRoot ?? process.cwd());
  const result = (status: Result['status'], summary: string, evidence: unknown[] = [], artifacts: string[] = [], classification?: Result['classification']) =>
    createResult({ tool: 'maestro-flow', operation, run_id: runId, status, summary, evidence, artifacts, startedAt, ...(classification ? { classification } : {}) });
  try {
    resolvePath(root, runArtifactDir(root, runId, 'maestro-flow'));
    const configPath = resolvePath(root, input.config ?? 'android-kit.yaml');
    let config: Config = {};
    try { await access(configPath); config = await loadConfig<Config>(configPath, { name: 'maestroFlow', schema: maestroFlowSchema }) ?? {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || input.config) throw error; }
    const indexPath = resolvePath(root, input.index ?? config.index ?? 'selectors.json');
    if (operation === 'index') {
      const index = await buildIndex(root, { hierarchyPaths: (input.hierarchy ?? config.hierarchy)?.map(path => resolvePath(root, path)) });
      await writeIndex(indexPath, JSON.stringify(index, null, 2) + '\n');
      return result(index.unsupported.length ? 'unsupported' : 'pass', index.unsupported.length ? 'Index contains unsupported resource formats' : 'Resource index created', [...index.unsupported, { output: indexPath }]);
    }
    if (operation === 'lint') {
      const selected = input.flow ?? config.flow;
      const flows = selected ? [resolvePath(root, selected)] : await findFlows(resolvePath(root, input.flowsDir ?? config.flowsDir ?? 'e2e/maestro'));
      if (!flows.length) throw new Error('No flow YAML files found');
      let previous: ResourceIndex | undefined;
      try { previous = await readIndex(indexPath); }
      catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const hierarchyPaths = (input.hierarchy ?? config.hierarchy ?? previous?.hierarchyInputs)?.map(path => resolvePath(root, path));
      const current = await buildIndex(root, { hierarchyPaths });
      const refreshed = !previous || previous.indexerVersion !== current.indexerVersion || previous.inputHash !== current.inputHash;
      const index = refreshed ? current : previous ?? current;
      if (refreshed) await writeIndex(indexPath, JSON.stringify(index, null, 2) + '\n');
      const diagnostics: unknown[] = refreshed ? [{ kind: 'index-refresh', reason: !previous ? 'missing or invalid' : previous.indexerVersion !== current.indexerVersion ? 'indexer version changed' : 'inputs changed' }] : [];
      let passed = true;
      for (const flow of flows) {
        const suppressions = config.suppressions?.filter(item => !item.file || resolvePath(root, item.file) === flow)
          .map(item => item.file ? { ...item, file: flow } : item);
        const lint = await lintFlow(flow, index, { locale: (input.locale ?? config.locale)?.[0], rootScreens: config.rootScreens, suppressions, maestroVersion: input.maestroVersion ?? config.maestroVersion });
        passed &&= lint.passed;
        diagnostics.push(...lint.diagnostics.map(diagnostic => ({ ...diagnostic, file: relative(root, diagnostic.file).split(sep).join('/') })));
      }
      return result(passed ? 'pass' : 'fail', passed ? 'Flow lint passed' : 'Flow lint failed', diagnostics, [], passed ? undefined : 'test');
    }
    if (operation === 'generate') {
      const journeyInput = input.journey;
      if (!journeyInput) throw new Error('Missing required journey');
      let journey: string | Journey = journeyInput;
      if (typeof journeyInput === 'string') {
        const source = await readFile(resolvePath(root, journeyInput), 'utf8');
        journey = /\.json$/i.test(journeyInput) ? JSON.parse(source) as Journey : source;
      }
      const generated = await generateFlows({ appId: required(input.appId ?? config.appId, 'appId'), journey, index: await readIndex(indexPath), locales: input.locale ?? config.locale ?? ['default'], maestroVersion: required(input.maestroVersion ?? config.maestroVersion, 'maestroVersion') });
      const output = resolvePath(root, required(input.output ?? config.output, 'output'));
      const paths: string[] = [];
      try {
        for (const flow of generated) {
          if (!/^[A-Za-z0-9_-]+$/.test(flow.locale)) throw new Error(`Invalid locale: ${flow.locale}`);
          const path = resolvePath(root, generated.length === 1 ? output : output.replace(/(\.ya?ml)?$/i, `-${flow.locale}$1`));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, flow.yaml, { flag: 'wx' });
          paths.push(path);
        }
      } catch (error) {
        await Promise.all(paths.map(path => unlink(path)));
        throw error;
      }
      return result('pass', 'Flows generated', [...generated.flatMap(flow => flow.findings), ...paths.map(path => ({ output: path }))]);
    }
    if (operation === 'run') {
      const emuLab = input.emuLab ?? config.emuLab;
      return await runFlow({ flow: resolvePath(root, required(input.flow ?? config.flow, 'flow')), serial: emuLab ? input.serial ?? config.serial : required(input.serial ?? config.serial, 'serial'), projectRoot: root, runId, suite: input.suite, screenAnchor: input.screenAnchor, selectorRepair: input.selectorRepair, maestro: config.maestro, adb: config.adb, signal: input.signal, emuLab: emuLab && { ...emuLab, databasePath: resolvePath(root, emuLab.databasePath) } });
    }
    if (operation === 'doctor') {
      const checks = await Promise.all([version('java', ['-version']), version(config.adb ?? 'adb', ['version']), version(config.maestro ?? 'maestro', ['--version'])]);
      const maestro = checks[2];
      const supported = !!maestro.version && supportedMaestroVersion(maestro.version);
      if (!checks.every(check => check.available)) return result('blocked', 'Missing prerequisites', checks, [], 'environment');
      if (!supported) return result('unsupported', 'Maestro must be >=1.39.0 and <=2.12.1', checks, [], 'environment');
      return result('pass', 'Prerequisites are available', checks);
    }
    return result('unsupported', `Unknown operation: ${operation}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(message.startsWith('Unsupported Maestro version:') ? 'unsupported' : message.startsWith('Missing required') ? 'blocked' : 'error', message, [], [], 'config');
  }
}

export async function executeOperation(operation: Operation, input: OperationInput = {}): Promise<Result> {
  const runId = input.runId ?? newRunId();
  const root = resolve(input.projectRoot ?? process.cwd());
  const outcome = await performOperation(operation, { ...input, runId });
  if (operation === 'run' && outcome.artifacts.length) return outcome;
  try {
    resolvePath(root, runArtifactDir(root, runId, 'maestro-flow'));
    const directory = runArtifactDir(root, runId, 'maestro-flow');
    const report = join(directory, `${operation}-result.json`);
    await atomicWrite(report, JSON.stringify({ operation, status: outcome.status, summary: outcome.summary, evidence: outcome.evidence }, null, 2) + '\n');
    const reportPath = relative(root, report).split(sep).join('/');
    const indexPath = await writeArtifactIndex(root, runId, 'maestro-flow', [reportPath]);
    return { ...outcome, artifacts: [reportPath, indexPath] };
  } catch (error) {
    return { ...outcome, status: 'error', classification: 'environment', summary: `Could not write run artifacts: ${error instanceof Error ? error.message : String(error)}`, artifacts: [] };
  }
}
