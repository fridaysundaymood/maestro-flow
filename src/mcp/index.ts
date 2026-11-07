import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolDefinitions, toolInputSchema } from '../tools.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'maestro-flow', version: '1.0.0' });
  for (const tool of toolDefinitions()) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: toolInputSchema }, async input => {
      const result = await tool.handler(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result }, isError: result.status === 'error' };
    });
  }
  return server;
}
