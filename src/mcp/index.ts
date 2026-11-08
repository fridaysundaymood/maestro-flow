import { readFileSync } from 'node:fs';
import type { OperationInput } from '../core/service.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolDefinitions, toolInputSchema } from '../tools.js';

export function createServer(options: Pick<OperationInput, 'projectRoot' | 'config'> = {}): McpServer {
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const server = new McpServer({ name: 'maestro-flow', version });
  for (const tool of toolDefinitions(options)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: toolInputSchema }, async input => {
      const result = await tool.handler(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: result.status === 'error' };
    });
  }
  return server;
}
