import type { ResourceIndex } from './indexer.js';

export interface Selector {
  key?: string;
  text?: string;
  description?: string;
  quantity?: string;
  index?: number;
  container?: Selector;
  point?: string;
}

export interface JourneyStep {
  action: 'tap' | 'input' | 'hideKeyboard' | 'scroll' | 'back' | 'assertVisible' | 'assertNotVisible' | 'wait';
  selector?: Selector;
  value?: string;
  previous?: Selector;
  locale?: string;
}

export interface Journey {
  title: string;
  anchor: Selector;
  initialLocale?: string;
  localePreconditions?: Record<string, JourneyStep[]>;
  preconditions?: JourneyStep[];
  steps: JourneyStep[];
}

export interface GenerateInput {
  appId: string;
  journey: Journey | string;
  index: ResourceIndex;
  locales: string[];
  maestroVersion: string;
}

export interface GeneratedFlow {
  locale: string;
  yaml: string;
  findings: string[];
}

function parseSelector(value: string): Selector | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (text.startsWith('key:')) return { key: text.slice(4).trim() };
  if (text.startsWith('description:')) return { description: text.slice(12).trim() };
  if (text.startsWith('point:')) return { point: text.slice(6).trim() };
  if (text.startsWith('text:')) return { text: text.slice(5).trim() };
  return { key: text };
}

/** Parse a command table; prose journeys must first be translated into structured steps. */
export function parseJourney(markdown: string): Journey {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const title = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '').trim();
  const anchorLine = lines.find((line) => /^anchor\s*:/i.test(line));
  const anchor = anchorLine && parseSelector(anchorLine.replace(/^anchor\s*:/i, ''));
  const table = lines.filter((line) => /^\s*\|/.test(line));
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  if (!title || !anchor || table.length < 2) throw new Error('Journey markdown requires a heading, Anchor: selector, and command table');
  const headers = cells(table[0]).map((cell) => cell.toLowerCase());
  if (!headers.includes('action') || !/^\s*\|?\s*:?-+/.test(table[1])) throw new Error('Journey table requires an Action column and separator');
  const steps: JourneyStep[] = [];
  for (const row of table.slice(2)) {
    const values = cells(row);
    const get = (name: string) => values[headers.indexOf(name)]?.trim() || '';
    const action = get('action') as JourneyStep['action'];
    if (!['tap', 'input', 'hideKeyboard', 'scroll', 'back', 'assertVisible', 'assertNotVisible', 'wait'].includes(action)) throw new Error(`Unsupported journey action: ${action}`);
    steps.push({ action, selector: parseSelector(get('selector')), value: get('value') || undefined, previous: parseSelector(get('previous')) });
    const expected = parseSelector(get('expected'));
    if (expected) steps.push({ action: 'assertVisible', selector: expected });
  }
  return { title, anchor, steps };
}

function versionSupported(version: string): boolean {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) === 1 && Number(match[2]) >= 39;
}

function resolve(selector: Selector, locale: string, index: ResourceIndex, findings: string[]): { field: string; value: string; container?: { field: string; value: string } } {
  let field = 'text';
  let value = selector.description;
  let formatted = false;
  if (selector.point !== undefined) {
    if (!/^\d+(?:\.\d+)?%?,\s*\d+(?:\.\d+)?%?$/.test(selector.point)) throw new Error('Invalid coordinate selector');
    findings.push(`Coordinate selector ${selector.point} requires an accessibility review`);
    field = 'point';
    value = selector.point;
  } else if (value !== undefined) {
    field = 'text';
  } else if (selector.key) {
    const candidates = index.resources.filter((entry) => entry.key === selector.key && (!selector.quantity || entry.quantity === selector.quantity) && (selector.index === undefined || entry.index === selector.index));
    const locales = [...new Set([locale, locale.split(/[-_]/)[0], 'default'])];
    const selected = locales.map((name) => candidates.filter((entry) => entry.locale === name)).find((entries) => entries.length);
    if (!selected?.length) throw new Error(`Resource ${selector.key} is unavailable for locale ${locale}`);
    if (selected.length !== 1) throw new Error(`Resource ${selector.key} requires a unique quantity or array item`);
    const resource = selected[0];
    const semantics = index.semantics.find((entry) => entry.resourceKey === selector.key && entry.value);
    value = semantics?.value ?? resource.regex ?? resource.value.replace(/%%/g, '%');
    formatted = !semantics?.value && !!resource.regex;
    if (!semantics?.value && !resource.regex && index.unsupported.some((issue) => issue.key === selector.key)) throw new Error(`Resource ${selector.key} contains an unsupported format`);
  } else {
    value = selector.text;
  }
  if (!value) throw new Error('Selector must contain a resource key, description, text, or point');
  if (field === 'text' && !formatted) value = value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const container = selector.container ? resolve(selector.container, locale, index, findings) : undefined;
  return { field, value, container };
}

function scalar(value: string): string { return JSON.stringify(value); }

function command(name: string, selector: Selector, locale: string, index: ResourceIndex, findings: string[]): string[] {
  const resolved = resolve(selector, locale, index, findings);
  if (resolved.field === 'point' && name !== 'tapOn') throw new Error('Coordinates may only be used for taps');
  if (/^[+-]?(?:\d+[.,]?)+$/.test(resolved.value.trim()) && name.startsWith('assert') && !resolved.container) throw new Error('Numeric assertions require a container or a complete label');
  if (!resolved.container && resolved.field === 'text') return [`- ${name}: ${scalar(resolved.value)}`];
  const lines = [`- ${name}:`, `    ${resolved.field}: ${scalar(resolved.value)}`];
  if (resolved.container) lines.push('    childOf:', `      ${resolved.container.field}: ${scalar(resolved.container.value)}`);
  return lines;
}

export async function generateFlows(input: GenerateInput): Promise<GeneratedFlow[]> {
  if (!versionSupported(input.maestroVersion)) throw new Error(`Unsupported Maestro version: ${input.maestroVersion}; expected >=1.39.0 <2.0.0`);
  if (!input.appId.trim()) throw new Error('appId is required');
  if (!input.locales.length || input.locales.some((locale) => !locale.trim())) throw new Error('At least one locale is required');
  const journey = typeof input.journey === 'string' ? parseJourney(input.journey) : input.journey;
  if (!journey.title?.trim() || !journey.anchor || !Array.isArray(journey.steps)) throw new Error('Journey requires a title, anchor, and steps');
  return [...new Set(input.locales)].map((locale) => {
    const findings: string[] = [];
    const anchor = resolve(journey.anchor, journey.initialLocale ?? locale, input.index, findings);
    if (anchor.field !== 'text' || anchor.container) throw new Error('Launch anchor must be a text selector');
    const lines = [`# Intent: ${journey.title.replace(/[\r\n]+/g, ' ')}`, `# Locale: ${locale.replace(/[\r\n]+/g, ' ')}`, `appId: ${scalar(input.appId)}`, '---', '- clearState', '- retry:', '    maxRetries: 3', '    commands:', '      - launchApp', '- extendedWaitUntil:', `    visible: ${scalar(anchor.value)}`, '    timeout: 10000'];
    const localeSteps = journey.localePreconditions?.[locale] ?? [];
    const targetWait: JourneyStep[] = journey.initialLocale && journey.initialLocale !== locale ? [{ action: 'wait', selector: journey.anchor }] : [];
    for (const step of [...(journey.preconditions ?? []), ...localeSteps, ...targetWait, ...journey.steps]) {
      const stepLocale = step.locale ?? locale;
      if (step.action === 'input') {
        if (step.value === undefined) throw new Error('input requires a value');
        if (step.selector) lines.push(...command('tapOn', step.selector, stepLocale, input.index, findings));
        lines.push(`- inputText: ${scalar(step.value)}`);
      } else if (step.action === 'hideKeyboard') lines.push('- hideKeyboard');
      else if (step.action === 'back') lines.push('- back');
      else if (step.action === 'scroll') lines.push('- scroll');
      else {
        if (!step.selector) throw new Error(`${step.action} requires a selector`);
        if (step.action === 'wait') {
          const target = resolve(step.selector, stepLocale, input.index, findings);
          if (target.field !== 'text' || target.container) throw new Error('Wait target must be a text selector');
          lines.push('- extendedWaitUntil:', `    visible: ${scalar(target.value)}`, '    timeout: 10000');
        } else {
          const name = step.action === 'tap' ? 'tapOn' : step.action;
          if (!['tapOn', 'assertVisible', 'assertNotVisible'].includes(name)) throw new Error(`Unsupported journey action: ${step.action}`);
          lines.push(...command(name, step.selector, stepLocale, input.index, findings));
          if (step.previous) {
            if (step.action !== 'assertVisible') throw new Error('previous is only valid on assertVisible');
            lines.push(...command('assertNotVisible', step.previous, stepLocale, input.index, findings));
          }
        }
      }
    }
    return { locale, yaml: `${lines.join('\n')}\n`, findings };
  });
}
