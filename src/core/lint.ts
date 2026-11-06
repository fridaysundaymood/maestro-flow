import { readFile } from 'node:fs/promises';
import { isMap, isNode, isScalar, isSeq, LineCounter, parseAllDocuments } from 'yaml';
import type { ResourceIndex } from './indexer.js';
import { supportedMaestroVersion } from './run.js';

export interface Diagnostic { ruleId: string; severity: 'error' | 'warning'; message: string; file: string; line: number; selector?: string }
export interface Suppression { ruleId: string; reason: string; file?: string; line?: number }
export interface LintOptions { locale?: string; rootScreens?: string[]; suppressions?: Suppression[]; maestroVersion?: string }
export interface LintResult { diagnostics: Diagnostic[]; passed: boolean }
export const RULES = {
  MF001: { severity: 'error', rationale: 'Selector resembles changed resource copy', version: '1.0.0' },
  MF002: { severity: 'warning', rationale: 'Selector cannot be resolved from static evidence', version: '1.0.0' },
  MF003: { severity: 'warning', rationale: 'Back navigation on a root screen is unreliable', version: '1.0.0' },
  MF004: { severity: 'warning', rationale: 'Bare numbers can match unrelated values', version: '1.0.0' },
  MF005: { severity: 'warning', rationale: 'Launch needs a stable visible anchor', version: '1.0.0' },
  MF006: { severity: 'warning', rationale: 'Coordinate taps lack stable accessibility semantics', version: '1.0.0' },
  MF007: { severity: 'error', rationale: 'Suppressions require a known rule and a reason', version: '1.0.0' },
  MF008: { severity: 'warning', rationale: 'Unused suppressions hide future findings', version: '1.0.0' },
} as const;
export const RULESET_VERSION = '1.0.0';

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]; previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[b.length];
}

export async function lintFlow(file: string, index: ResourceIndex, options: LintOptions = {}): Promise<LintResult> {
  if (options.maestroVersion && !supportedMaestroVersion(options.maestroVersion)) throw new Error(`Unsupported Maestro version: ${options.maestroVersion}; expected >=1.39.0 <=2.12.1`);
  const source = await readFile(file, 'utf8');
  const counter = new LineCounter();
  const documents = parseAllDocuments(source, { lineCounter: counter });
  const errors = documents.flatMap(doc => doc.errors);
  if (errors.length) throw new Error(`Invalid flow YAML: ${errors.map(error => error.message).join('; ')}`);
  const diagnostics: Diagnostic[] = [];
  const emit = (ruleId: keyof typeof RULES, message: string, line: number, selector?: string) => diagnostics.push({ ruleId, severity: RULES[ruleId].severity, message, file, line, ...(selector === undefined ? {} : { selector }) });
  const values = index.resources.filter(entry => !options.locale || entry.locale === options.locale || entry.locale === 'default');
  const literals = new Set([...values.filter(entry => !entry.regex).map(entry => entry.value), ...index.semantics.flatMap(entry => entry.value === undefined ? [] : [entry.value])]);
  const patterns = values.flatMap(entry => entry.regex ? [new RegExp(entry.regex)] : []);
  const entered = new Set<string>();
  const suppressions = options.suppressions ?? [];
  let launched = false, anchor = false, currentScreen: string | undefined;
  const lineOf = (node: unknown) => counter.linePos(isNode(node) ? node.range?.[0] ?? 0 : 0).line;
  const scalar = (node: unknown): string | undefined => isScalar(node) && typeof node.value === 'string' ? node.value : undefined;
  const checkSelector = (value: string, line: number, assertion: boolean) => {
    if (assertion && /^[-+]?\d+(?:[.,]\d+)?$/.test(value)) emit('MF004', 'Bare numeric assertion should be scoped or use a complete label', line, value);
    if (literals.has(value) || entered.has(value) || patterns.some(pattern => pattern.test(value))) return;
    const nearby = [...literals].some(candidate => candidate.length >= 4 && value.length >= 4 && (distance(candidate.toLowerCase(), value.toLowerCase()) <= Math.max(2, Math.floor(Math.max(candidate.length, value.length) / 3)) || candidate.toLowerCase().split(/\s+/).some(word => word.length >= 4 && value.toLowerCase().split(/\s+/).includes(word))));
    if (nearby) emit('MF001', 'Selector resembles resource copy but does not match it; confirm the intended control', line, value);
    else emit('MF002', 'Selector is not known from resources, input, or hierarchy evidence', line, value);
  };
  const selectorFrom = (node: unknown): string | undefined => {
    const direct = scalar(node);
    if (direct !== undefined) return direct;
    if (isMap(node)) for (const pair of node.items) if (['text', 'label'].includes(String(isScalar(pair.key) ? pair.key.value : ''))) return scalar(pair.value);
    return undefined;
  };
  const commands = documents.flatMap(doc => isSeq(doc.contents) ? doc.contents.items : []);
  for (const command of commands) {
    if (isScalar(command)) {
      if (command.value === 'launchApp') launched = true;
      if (command.value === 'back' && currentScreen && options.rootScreens?.includes(currentScreen)) emit('MF003', 'Back used on a configured root screen', lineOf(command));
      continue;
    }
    if (!isMap(command)) continue;
    for (const pair of command.items) {
      const name = scalar(pair.key);
      if (!name) continue;
      const line = lineOf(pair.key);
      if (name === 'launchApp') launched = true;
      if (name === 'inputText') { const value = scalar(pair.value); if (value) entered.add(value); }
      if (name === 'back' && currentScreen && options.rootScreens?.includes(currentScreen)) emit('MF003', 'Back used on a configured root screen', line);
      if (name === 'extendedWaitUntil' && launched && isMap(pair.value)) {
        for (const item of pair.value.items) if (scalar(item.key) === 'visible' && selectorFrom(item.value)) anchor = true;
      }
      if (name === 'tapOn' && isMap(pair.value) && pair.value.items.some(item => scalar(item.key) === 'point')) emit('MF006', 'Coordinate tap bypasses accessibility semantics', line);
      if (['tapOn', 'assertVisible', 'assertNotVisible'].includes(name)) {
        const value = selectorFrom(pair.value);
        if (value !== undefined) { checkSelector(value, line, name.startsWith('assert')); if (options.rootScreens?.includes(value)) currentScreen = value; }
      }
      if (name === 'extendedWaitUntil' && isMap(pair.value)) for (const item of pair.value.items) {
        if (['visible', 'notVisible'].includes(scalar(item.key) ?? '')) {
          const value = selectorFrom(item.value);
          if (value !== undefined) { checkSelector(value, lineOf(item.key), false); if (options.rootScreens?.includes(value)) currentScreen = value; }
        }
      }
    }
  }
  if (launched && !anchor) emit('MF005', 'Launch has no visible anchor wait', 1);
  const used = new Set<number>();
  suppressions.forEach((suppression, i) => {
    if (!Object.hasOwn(RULES, suppression.ruleId) || !suppression.reason?.trim()) emit('MF007', `Invalid suppression for ${suppression.ruleId}`, suppression.line ?? 1);
    else if (!suppression.file && suppression.line === undefined) emit('MF007', `Suppression for ${suppression.ruleId} must specify a file or line`, 1);
    else used.add(i);
  });
  const matched = new Set<number>();
  const filtered = diagnostics.filter(diagnostic => {
    if (diagnostic.ruleId === 'MF007' || diagnostic.ruleId === 'MF008') return true;
    const i = suppressions.findIndex((suppression, n) => used.has(n) && suppression.ruleId === diagnostic.ruleId && (!suppression.file || suppression.file === file) && (suppression.line === undefined || suppression.line === diagnostic.line));
    if (i < 0) return true;
    matched.add(i); return false;
  });
  suppressions.forEach((suppression, i) => { if (used.has(i) && !matched.has(i)) filtered.push({ ruleId: 'MF008', severity: 'warning', message: `Unused suppression for ${suppression.ruleId}`, file, line: suppression.line ?? 1 }); });
  return { diagnostics: filtered, passed: !filtered.some(diagnostic => diagnostic.severity === 'error') };
}
