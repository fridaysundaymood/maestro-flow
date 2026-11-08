import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/index.js';
import { createServer } from '../src/mcp/index.js';
import { toolDefinitions } from '../src/tools.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('CLI and MCP parity', () => {
  it.each(['lint', 'generate', 'run'] as const)('returns the same result for invalid %s input', async operation => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-flow-parity-'));
    dirs.push(root);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main([operation, '--json', '--project-root', root, '--run-id', 'parity']);
    const cli = JSON.parse(String(output.mock.calls[0][0]));
    const server = createServer({ projectRoot: root });
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: `maestro_flow_${operation}`, arguments: { runId: 'parity' } });
      const mcp = response.structuredContent as typeof cli;
      expect(code).toBe(2);
      for (const field of ['schema_version', 'tool', 'operation', 'run_id', 'status', 'classification', 'summary', 'evidence', 'artifacts']) {
        expect(mcp[field]).toEqual(cli[field]);
      }
      expect(JSON.parse((response.content as { type: string; text: string }[])[0].text)).toEqual(mcp);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('passes lease options equivalently through CLI and MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maestro-flow-lease-'));
    dirs.push(root);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['run', '--json', '--project-root', root, '--run-id', 'lease',
      '--flow', 'flow.yaml', '--emu-lab-database', 'leases.sqlite', '--lease-id', 'synthetic',
      '--package-name', 'dev.example.synthetic']);
    const cli = JSON.parse(String(output.mock.calls[0][0]));
    const server = createServer({ projectRoot: root });
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: 'maestro_flow_run', arguments: {
        runId: 'lease', flow: 'flow.yaml',
        emuLab: { databasePath: 'leases.sqlite', leaseId: 'synthetic', packageName: 'dev.example.synthetic' },
      } });
      const mcp = response.structuredContent as typeof cli;
      expect(code).toBe(2);
      for (const field of ['schema_version', 'tool', 'operation', 'run_id', 'status', 'classification', 'summary']) {
        expect(mcp[field]).toEqual(cli[field]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists all operations over MCP', async () => {
    const server = createServer();
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name).sort()).toEqual(['maestro_flow_doctor', 'maestro_flow_generate', 'maestro_flow_index', 'maestro_flow_lint', 'maestro_flow_run']);
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      expect(client.getServerVersion()?.version).toBe(metadata.version);
      for (const tool of tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        for (const key of ['projectRoot', 'config', 'maestro', 'adb']) expect(tool.inputSchema.properties).not.toHaveProperty(key);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('public tool API', () => {
  it('imports the package root without starting a transport', async () => {
    const connect = vi.spyOn(StdioServerTransport.prototype, 'start');
    // Import after spying to exercise the package-loading boundary.
    const api = await import('../src/index.js');
    expect(connect).not.toHaveBeenCalled();
    expect(api.configSection).toBe('maestroFlow');
    expect(api.configSectionSchema).toEqual(api.maestroFlowSchema);
    expect(api.supportedSchemaMajors).toEqual([1]);
    expect(typeof api.doctor).toBe('function');
  });

  it('exposes the MCP operations and their JSON schemas', async () => {
    const definitions = toolDefinitions();
    const server = createServer();
    const client = new Client({ name: 'public-api-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(definitions.map(tool => tool.name)).toEqual(tools.map(tool => tool.name));
      for (const definition of definitions) {
        expect(definition.inputSchema.type).toBe('object');
        expect(typeof definition.handler).toBe('function');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects untrusted launch options and nested unknown fields', () => {
    const tool = toolDefinitions({ projectRoot: '/trusted' }).find(item => item.name === 'maestro_flow_generate')!;
    for (const input of [
      { projectRoot: '/untrusted' }, { config: 'other.yaml' }, { maestro: 'evil' }, { adb: 'evil' },
      { selectorRepair: { old: 'a', replacement: 'b', extra: true } },
      { emuLab: { databasePath: 'db', leaseId: 'id', packageName: 'pkg', extra: true } },
      { journey: { title: 'x', anchor: { container: { extra: true } }, steps: [] } },
      { journey: { title: 'x', anchor: {}, steps: [{ action: 'tap', extra: true }] } },
    ]) expect(() => tool.handler(input)).toThrow();
  });

  it('runs the CLI through a symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maestro-flow-link-'));
    dirs.push(dir);
    const link = join(dir, 'cli.ts');
    try { await symlink(new URL('../src/cli/index.ts', import.meta.url), link, 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const argv = process.argv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.argv = [process.execPath, link, '--help'];
      vi.resetModules();
      // Re-import after changing argv to exercise the entry-point guard.
      await import('../src/cli/index.js');
      expect(String(log.mock.calls[0]?.[0])).toContain('Usage: maestro-flow');
    } finally {
      process.argv = argv;
    }
  });
});
