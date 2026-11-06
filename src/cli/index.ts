#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createResult, exitCodeFor, newRunId } from '@android-kit/schema';
import { executeOperation, type Operation, type OperationInput } from '../core/service.js';

const operations: Record<string, true> = { index: true, lint: true, generate: true, run: true, doctor: true };
const options: Record<string, keyof OperationInput> = {
  'project-root': 'projectRoot', config: 'config', 'run-id': 'runId', index: 'index', hierarchy: 'hierarchy',
  flow: 'flow', locale: 'locale', 'app-id': 'appId', journey: 'journey', output: 'output',
  'maestro-version': 'maestroVersion', serial: 'serial', suite: 'suite', 'screen-anchor': 'screenAnchor',
  maestro: 'maestro', adb: 'adb',
};
export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  let error: string | undefined;
  const input: OperationInput = {};
  let json = false;
  let repairOld: string | undefined, repairReplacement: string | undefined;
  let databasePath: string | undefined, leaseId: string | undefined, packageName: string | undefined;
  if (!command || !operations[command]) error = 'Expected operation: index, lint, generate, run, or doctor';
  for (let i = 0; i < args.length && !error; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--suite') { input.suite = true; continue; }
    if (arg === '--emu-lab-database' || arg === '--lease-id' || arg === '--package-name') {
      const value = args[++i];
      if (!value || value.startsWith('--')) { error = `Missing value for ${arg}`; break; }
      if (arg === '--emu-lab-database') databasePath = value;
      else if (arg === '--lease-id') leaseId = value;
      else packageName = value;
      continue;
    }
    if (arg === '--repair-old' || arg === '--repair-replacement') {
      const value = args[++i];
      if (!value || value.startsWith('--')) { error = `Missing value for ${arg}`; break; }
      if (arg === '--repair-old') repairOld = value; else repairReplacement = value;
      continue;
    }
    const split = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [];
    const key = options[split[0]];
    if (!key || key === 'suite') { error = `Unknown option: ${arg}`; break; }
    const value = split.length === 2 ? split[1] : args[++i];
    if (!value || value.startsWith('--')) { error = `Missing value for ${arg}`; break; }
    if (key === 'hierarchy' || key === 'locale') (input[key] ??= []).push(value);
    else (input as Record<string, unknown>)[key] = value;
  }
  if (repairOld && repairReplacement) input.selectorRepair = { old: repairOld, replacement: repairReplacement };
  else if (repairOld || repairReplacement) error = 'Both --repair-old and --repair-replacement are required';
  if (databasePath && leaseId && packageName) input.emuLab = { databasePath, leaseId, packageName };
  else if (databasePath || leaseId || packageName) error = 'All of --emu-lab-database, --lease-id, and --package-name are required';
  if (error) {
    const result = createResult({ tool: 'maestro-flow', operation: command ?? 'unknown', run_id: newRunId(), status: 'error', classification: 'config', summary: error, evidence: [], artifacts: [], startedAt: new Date() });
    console.log(JSON.stringify(result));
    return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let result;
  try { result = await executeOperation(command as Operation, { ...input, signal: controller.signal }); }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  console.log(json ? JSON.stringify(result) : `${result.status.toUpperCase()}: ${result.summary}\n${JSON.stringify({ evidence: result.evidence, artifacts: result.artifacts }, null, 2)}`);
  return exitCodeFor(result.status);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 2; });
}
