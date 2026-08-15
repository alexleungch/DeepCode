// deepcode demo plugin: registers one example tool plus an embedded skill
// Install: copy this directory to ~/.deepcode/plugins/demo/
export default {
  id: 'demo',
  name: 'Demo plugin',
  version: '0.1.0',
  description: 'Demo plugin: provides an echo tool and an embedded skill',
  tools: [
    {
      name: 'echo_text',
      description: 'Echoes text back verbatim (demo tool).',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to echo' } },
        required: ['text'],
      },
      permission: 'read',
      async execute(input) {
        const text = input && typeof input.text === 'string' ? input.text : '';
        return { content: `echo: ${text}` };
      },
    },
  ],
  skills: ['demo-skill'],
  mcpServers: {},
  hooks: {},
};
