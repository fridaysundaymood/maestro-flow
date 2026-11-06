#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeOperation, type Operation, type OperationInput } from '../core/service.js';

const selector = z.object({ key: z.string().optional(), text: z.string().optional(), description: z.string().optional(), quantity: z.string().optional(), index: z.number().int().optional(), point: z.string().optional(), container: z.any().optional() });
const step = z.object({ action: z.enum(['tap', 'input', 'hideKeyboard', 'scroll', 'back', 'assertVisible', 'assertNotVisible', 'wait']), selector: selector.optional(), value: z.string().optional(), previous: selector.optional(), locale: z.string().optional() });
const journey = z.object({ title: z.string(), anchor: selector, initialLocale: z.string().optional(), localePreconditions: z.record(z.string(), z.array(step)).optional(), preconditions: z.array(step).optional(), steps: z.array(step) });
const schema = {
  projectRoot: z.string().optional(), config: z.string().optional(), runId: z.string().optional(),
  index: z.string().optional(), hierarchy: z.array(z.string()).optional(), flow: z.string().optional(),
  locale: z.array(z.string()).optional(), appId: z.string().optional(), journey: z.union([z.string(), journey]).optional(),
  output: z.string().optional(), maestroVersion: z.string().optional(), serial: z.string().optional(), suite: z.boolean().optional(),
  screenAnchor: z.string().optional(), selectorRepair: z.object({ old: z.string(), replacement: z.string() }).optional(), maestro: z.string().optional(), adb: z.string().optional(),
  emuLab: z.object({ databasePath: z.string(), leaseId: z.string(), packageName: z.string() }).optional(),
};
export function createServer(): McpServer {
  const server = new McpServer({ name: 'maestro-flow', version: '1.0.0' });
  for (const operation of ['index', 'lint', 'generate', 'run', 'doctor'] as Operation[]) {
    server.registerTool(`maestro_flow_${operation}`, { description: `${operation} Maestro flows`, inputSchema: schema }, async (input) => {
      const result = await executeOperation(operation, input as OperationInput);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: result.status === 'error' };
    });
  }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer().connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 2; });
}
