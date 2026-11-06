import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/index.js';
import { createServer } from '../src/mcp/index.js';

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
    const server = createServer();
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: `maestro_flow_${operation}`, arguments: { projectRoot: root, runId: 'parity' } });
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
    const server = createServer();
    const client = new Client({ name: 'parity-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: 'maestro_flow_run', arguments: {
        projectRoot: root, runId: 'lease', flow: 'flow.yaml',
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
    } finally {
      await client.close();
      await server.close();
    }
  });
});
