import { describe, expect, it } from 'vitest';
import { generateFlows, parseJourney } from '../src/core/generate.js';
import type { ResourceIndex } from '../src/core/indexer.js';

const index: ResourceIndex = {
  version: 1,
  resources: [
    { key: 'boards', locale: 'default', kind: 'string', value: 'Boards' },
    { key: 'boards', locale: 'id', kind: 'string', value: 'Papan' },
    { key: 'save', locale: 'default', kind: 'string', value: 'Save' },
    { key: 'save', locale: 'id', kind: 'string', value: 'Simpan' },
    { key: 'total', locale: 'default', kind: 'string', value: 'Total: %1$d', regex: '^Total: .+$' },
  ],
  semantics: [], hierarchyInputs: [], unsupported: [],
};

const base = { appId: 'dev.example.synthetic', index, maestroVersion: '1.39.0', locales: ['en', 'id'] };

describe('journey generation', () => {
  it('generates each locale with launch, assertions and an unchanged old value', async () => {
    const flows = await generateFlows({ ...base, journey: {
      title: 'Save a board', anchor: { key: 'boards' }, steps: [
        { action: 'tap', selector: { key: 'save' } },
        { action: 'assertVisible', selector: { text: 'Total: 2' }, previous: { text: 'Total: 1' } },
      ],
    } });
    expect(flows).toHaveLength(2);
    expect(flows[0].yaml).toContain('visible: "Boards"');
    expect(flows[1].yaml).toContain('visible: "Papan"');
    expect(flows[1].yaml).toContain('- tapOn: "Simpan"');
    expect(flows[0].yaml).toContain('- assertNotVisible: "Total: 1"');
    expect(flows[0].yaml).toContain('- clearState');
  });

  it('parses authored markdown tables and uses format-derived regex', async () => {
    const journey = parseJourney('# Total\n\nAnchor: key:boards\n\n| Action | Selector | Expected |\n| --- | --- | --- |\n| tap | key:save | key:total |');
    const [flow] = await generateFlows({ ...base, locales: ['en'], journey });
    expect(flow.yaml).toContain('- assertVisible: "^Total: .+$"');
  });
  it('generates the same flow for Maestro 2.12.1', async () => {
    const journey = { title: 'Boards', anchor: { key: 'boards' }, steps: [] };
    const old = await generateFlows({ ...base, journey });
    const current = await generateFlows({ ...base, journey, maestroVersion: '2.12.1' });
    expect(current).toEqual(old);
  });


  it('rejects unsupported versions, ambiguous resources, and unscoped numeric assertions', async () => {
    const journey = { title: 'Numeric', anchor: { key: 'boards' }, steps: [{ action: 'assertVisible' as const, selector: { text: '12' } }] };
    await expect(generateFlows({ ...base, journey, maestroVersion: '2.12.2' })).rejects.toThrow('Unsupported Maestro version');
    await expect(generateFlows({ ...base, journey })).rejects.toThrow('Numeric assertions');
    await expect(generateFlows({ ...base, journey: { ...journey, anchor: { key: 'missing' } } })).rejects.toThrow('unavailable');
  });

  it('flags coordinate taps and supports explicitly authored preconditions', async () => {
    const [flow] = await generateFlows({ ...base, locales: ['en'], journey: {
      title: 'Set state', anchor: { key: 'boards' }, preconditions: [{ action: 'tap', selector: { point: '50%,50%' } }], steps: [],
    } });
    expect(flow.findings).toHaveLength(1);
    expect(flow.yaml).toContain('point: "50%,50%"');
  });
  it('waits for the initial locale before switching and the target locale afterward', async () => {
    const [flow] = await generateFlows({ ...base, locales: ['id'], journey: {
      title: 'Switch language', anchor: { key: 'boards' }, initialLocale: 'en',
      localePreconditions: { id: [
        { action: 'tap', selector: { text: 'Settings' }, locale: 'en' },
        { action: 'tap', selector: { text: 'Bahasa Indonesia' }, locale: 'en' },
      ] },
      steps: [{ action: 'assertVisible', selector: { key: 'save' } }],
    } });
    expect(flow.yaml.indexOf('visible: "Boards"')).toBeLessThan(flow.yaml.indexOf('- tapOn: "Settings"'));
    expect(flow.yaml.indexOf('- tapOn: "Bahasa Indonesia"')).toBeLessThan(flow.yaml.indexOf('visible: "Papan"'));
    expect(flow.yaml).toContain('- assertVisible: "Simpan"');
  });
});
