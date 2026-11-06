import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createResult, loadConfig, newRunId, runArtifactDir, writeArtifactIndex, type Result } from '@android-kit/schema';
import { buildIndex, type ResourceIndex } from './indexer.js';
import { lintFlow } from './lint.js';
import { generateFlows, type Journey } from './generate.js';
import { runFlow } from './run.js';

export type Operation = 'index' | 'lint' | 'generate' | 'run' | 'doctor';
export interface OperationInput {
  projectRoot?: string; config?: string; runId?: string; index?: string; hierarchy?: string[];
  flow?: string; locale?: string[]; appId?: string; journey?: string | Journey; output?: string;
  maestroVersion?: string; serial?: string; suite?: boolean; screenAnchor?: string;
  selectorRepair?: { old: string; replacement: string }; maestro?: string; adb?: string; signal?: AbortSignal;
  emuLab?: { databasePath: string; leaseId: string; packageName: string };
}
interface Config {
  index?: string; hierarchy?: string[]; flow?: string; locale?: string[]; appId?: string;
  output?: string; maestroVersion?: string; serial?: string; rootScreens?: string[];
  emuLab?: { databasePath: string; leaseId: string; packageName: string };
  suppressions?: { ruleId: string; reason: string; file?: string; line?: number }[];
}
const stringArray = { type: 'array', items: { type: 'string' } };
export const maestroFlowSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    index: { type: 'string' }, hierarchy: stringArray, flow: { type: 'string' }, locale: stringArray,
    appId: { type: 'string' }, output: { type: 'string' }, maestroVersion: { type: 'string' },
    serial: { type: 'string' }, rootScreens: stringArray,
    emuLab: { type: 'object', additionalProperties: false, required: ['databasePath', 'leaseId', 'packageName'],
      properties: { databasePath: { type: 'string', minLength: 1 }, leaseId: { type: 'string', minLength: 1 }, packageName: { type: 'string', minLength: 1 } } },
    suppressions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ruleId', 'reason'], properties: { ruleId: { type: 'string' }, reason: { type: 'string', minLength: 1 }, file: { type: 'string' }, line: { type: 'integer', minimum: 1 } } } },
  },
};
const exec = promisify(execFile);
const resolvePath = (root: string, path: string) => isAbsolute(path) ? path : resolve(root, path);
async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${newRunId()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, path);
}
async function readIndex(path: string): Promise<ResourceIndex> {
  return JSON.parse(await readFile(path, 'utf8')) as ResourceIndex;
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
    const configPath = resolvePath(root, input.config ?? 'android-kit.yaml');
    let config: Config = {};
    try { await access(configPath); config = await loadConfig<Config>(configPath, { name: 'maestroFlow', schema: maestroFlowSchema }) ?? {}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || input.config) throw error; }
    const indexPath = resolvePath(root, input.index ?? config.index ?? 'selectors.json');
    if (operation === 'index') {
      const index = await buildIndex(root, { hierarchyPaths: (input.hierarchy ?? config.hierarchy)?.map(path => resolvePath(root, path)) });
      await atomicWrite(indexPath, JSON.stringify(index, null, 2) + '\n');
      return result(index.unsupported.length ? 'unsupported' : 'pass', index.unsupported.length ? 'Index contains unsupported resource formats' : 'Resource index created', [...index.unsupported, { output: indexPath }]);
    }
    if (operation === 'lint') {
      const flow = resolvePath(root, required(input.flow ?? config.flow, 'flow'));
      const lint = await lintFlow(flow, await readIndex(indexPath), { locale: (input.locale ?? config.locale)?.[0], rootScreens: config.rootScreens, suppressions: config.suppressions });
      return result(lint.passed ? 'pass' : 'fail', lint.passed ? 'Flow lint passed' : 'Flow lint failed', lint.diagnostics, [], lint.passed ? undefined : 'test');
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
          const path = generated.length === 1 ? output : output.replace(/(\.ya?ml)?$/i, `-${flow.locale}$1`);
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
      return await runFlow({ flow: resolvePath(root, required(input.flow ?? config.flow, 'flow')), serial: emuLab ? input.serial ?? config.serial : required(input.serial ?? config.serial, 'serial'), projectRoot: root, runId, suite: input.suite, screenAnchor: input.screenAnchor, selectorRepair: input.selectorRepair, maestro: input.maestro, adb: input.adb, signal: input.signal, emuLab: emuLab && { ...emuLab, databasePath: resolvePath(root, emuLab.databasePath) } });
    }
    if (operation === 'doctor') {
      const checks = await Promise.all([version('java', ['-version']), version(input.adb ?? 'adb', ['version']), version(input.maestro ?? 'maestro', ['--version'])]);
      const maestro = checks[2];
      const match = maestro.version?.match(/\b(\d+)\.(\d+)\.(\d+)([-+][\w.-]+)?/);
      const supported = match && Number(match[1]) === 1 && Number(match[2]) >= 39 && !match[4]?.startsWith('-');
      if (!checks.every(check => check.available)) return result('blocked', 'Missing prerequisites', checks, [], 'environment');
      if (!supported) return result('unsupported', 'Maestro must be >=1.39.0 and <2.0.0', checks, [], 'environment');
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
