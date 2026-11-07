import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export interface ResourceEntry {
  key: string;
  locale: string;
  kind: 'string' | 'plural' | 'array';
  quantity?: string;
  index?: number;
  value: string;
  regex?: string;
}
export interface SemanticsEntry { value?: string; resourceKey?: string; screen?: string; file: string }
export interface IndexIssue { file: string; key: string; message: string }
export interface ResourceIndex {
  version: 1;
  indexerVersion?: string;
  inputHash?: string;
  resources: ResourceEntry[];
  semantics: SemanticsEntry[];
  hierarchyInputs: string[];
  unsupported: IndexIssue[];
}
export const INDEXER_VERSION = '1.0.0';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: false });
const resourceXml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: false, preserveOrder: true, cdataPropName: '#cdata' });
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
function resourceText(nodes: unknown): string {
  let raw = '';
  const visit = (value: unknown): void => {
    for (const node of list(value)) {
      if (typeof node === 'string' || typeof node === 'number') raw += String(node);
      else for (const [key, child] of Object.entries(record(node))) {
        if (key === '#text') raw += String(child);
        else if (key !== ':@') visit(child);
      }
    }
  };
  visit(nodes);
  let result = '';
  let quoted = false;
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '\\' && i + 1 < raw.length) {
      const next = raw[++i];
      if (space && result) result += ' ';
      space = false;
      if (next === 'u' && /^[\da-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
        result += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      } else result += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[next] ?? next;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && /[ \t\r\n]/.test(char)) {
      space = true;
    } else {
      if (space && result) result += ' ';
      space = false;
      result += char;
    }
  }
  return result;
}
const normalized = (path: string) => path.split(sep).join('/');

/** Convert Android printf strings to anchored, bounded regexes; unknown formats are rejected. */
export function formatSelector(value: string): { regex?: string; error?: string } {
  let result = '^';
  let formatted = false;
  const positions = new Map<string, { group: number; type: string }>();
  let groups = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char !== '%') {
      result += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      continue;
    }
    if (value[i + 1] === '%') { result += '%'; formatted = true; i++; continue; }
    const match = /^%(?:([1-9]\d*)\$)?([sdif])/.exec(value.slice(i));
    if (!match) return { error: `Unsupported format at offset ${i}` };
    formatted = true;
    const prior = match[1] ? positions.get(match[1]) : undefined;
    if (prior && prior.type !== match[2]) return { error: `Conflicting formats for argument ${match[1]}` };
    if (prior) result += `\\${prior.group}(?:)`;
    else {
      const pattern = match[2] === 's' ? '.{1,256}?' : match[2] === 'f' ? '-?\\d{1,18}(?:[.,]\\d{1,18})?' : '-?\\d{1,18}';
      result += `(${pattern})`;
      groups++;
      if (match[1]) positions.set(match[1], { group: groups, type: match[2] });
    }
    i += match[0].length - 1;
  }
  return formatted ? { regex: result + '$' } : {};
}

async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!['.git', 'node_modules', 'build', '.gradle', '.android-kit'].includes(entry.name)) await visit(resolve(dir, entry.name));
      } else if (entry.isFile()) found.push(resolve(dir, entry.name));
    }
  }
  await visit(root);
  return found;
}

export async function buildIndex(root: string, options: { hierarchyPaths?: string[] } = {}): Promise<ResourceIndex> {
  root = resolve(root);
  const resources: ResourceEntry[] = [];
  const semantics: SemanticsEntry[] = [];
  const unsupported: IndexIssue[] = [];
  const files = await filesUnder(root);
  const fileName = (file: string) => normalized(relative(root, file));
  const hash = createHash('sha256');
  const hashInput = (kind: string, name: string, content: string) => {
    for (const part of [kind, name, content]) hash.update(`${Buffer.byteLength(part)}:`).update(part);
  };
  const add = (entry: ResourceEntry, file: string) => {
    const formatted = formatSelector(entry.value);
    if (formatted.regex) entry.regex = formatted.regex;
    if (formatted.error) unsupported.push({ file: fileName(file), key: entry.key, message: formatted.error });
    resources.push(entry);
  };
  for (const file of files) {
    const name = fileName(file);
    const match = /(?:^|\/)res\/values(?:-([^/]+))?\/strings[^/]*\.xml$/.exec(name);
    if (match) {
      const source = await readFile(file, 'utf8');
      hashInput('resource', name, source);
      const parsed = list(resourceXml.parse(source));
      const data = parsed.flatMap(node => list(record(node).resources));
      const locale = match[1] ?? 'default';
      for (const value of data) {
        const item = record(value);
        const attrs = record(item[':@']);
        const key = attrs['@_name'];
        if (typeof key !== 'string') continue;
        if ('string' in item) {
          add({ key, locale, kind: 'string', value: resourceText(item.string) }, file);
        } else if ('plurals' in item) {
          for (const partValue of list(item.plurals)) {
            const part = record(partValue);
            const quantity = record(part[':@'])['@_quantity'];
            if (typeof quantity === 'string') add({ key, locale, kind: 'plural', quantity, value: resourceText(part.item) }, file);
          }
        } else if ('string-array' in item) {
          let index = 0;
          for (const partValue of list(item['string-array'])) {
            const part = record(partValue);
            if ('item' in part) add({ key, locale, kind: 'array', index: index++, value: resourceText(part.item) }, file);
          }
        }
      }
    } else if (/\.(?:kt|java)$/.test(name)) {
      const source = await readFile(file, 'utf8');
      hashInput('source', name, source);
      let screen: string | undefined;
      for (const line of source.split(/\r?\n/)) {
        const functionName = /\bfun\s+(\w+)/.exec(line);
        if (functionName) screen = functionName[1];
        for (const found of line.matchAll(/(?:contentDescription\s*=\s*|contentDescription\s*\(\s*)(?:"((?:[^"\\]|\\.)*)"|stringResource\s*\(\s*R\.string\.(\w+))/g)) {
          semantics.push({ ...(found[1] !== undefined ? { value: found[1] } : { resourceKey: found[2] }), ...(screen ? { screen } : {}), file: name });
        }
        for (const found of line.matchAll(/stringResource\s*\(\s*R\.string\.(\w+)/g)) semantics.push({ resourceKey: found[1], ...(screen ? { screen } : {}), file: name });
      }
    }
  }
  const hierarchyInputs = (options.hierarchyPaths ?? []).map(path => fileName(resolve(root, path))).sort();
  for (const path of hierarchyInputs) {
    const source = await readFile(resolve(root, path), 'utf8');
    hashInput('hierarchy', path, source);
    const tree = xml.parse(source);
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === '@_content-desc' || key === '@_text') && typeof value === 'string' && value) semantics.push({ value, file: path });
        else if (typeof value === 'object') for (const child of list(value)) visit(child);
      }
    };
    visit(tree);
  }
  const order = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en');
  resources.sort(order); semantics.sort(order); unsupported.sort(order);
  return { version: 1, indexerVersion: INDEXER_VERSION, inputHash: hash.digest('hex'), resources, semantics, hierarchyInputs, unsupported };
}
