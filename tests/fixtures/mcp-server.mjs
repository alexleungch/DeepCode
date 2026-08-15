// Minimal MCP stdio server fixture: registers an echo tool
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'echo') {
    const text = args && typeof args.text === 'string' ? args.text : '';
    return { content: [{ type: 'text', text: `echo: ${text}` }] };
  }
  throw new Error(`unknown tool ${name}`);
});

await server.connect(new StdioServerTransport());
