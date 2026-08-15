# Skills / Plugins / MCP

## Skills (SKILL.md instruction packs)

DSH-style skills: a directory + `SKILL.md` (YAML frontmatter `name`/`description` + markdown body + attached files).

```
~/.deepcode/skills/code-review/SKILL.md      # user-level
<project>/.deepcode/skills/code-review/SKILL.md # project-level (overrides user-level)
<repo>/skills/structured-codegen/SKILL.md    # built-in (ships with the package)
```

Mechanism:
1. The system prompt injects the skill catalog (name + description + size, up to 30 entries)
2. The model loads the full text on demand via the `skill` tool (`skill list` / `skill load <name>`)
3. Tasks matching a skill load its instructions first, then execute (e.g. the built-in structured-codegen template for structured code generation)

## Plugins (pure JS ESM)

`~/.deepcode/plugins/<name>/plugin.js` (or plugin.mjs / index.js), exports:

```js
export default {
  id: 'my-plugin',
  name: 'My plugin',
  tools: [
    {
      name: 'my_tool',
      description: '…',
      inputSchema: { type: 'object', properties: {} },
      permission: 'read',
      async execute(input, ctx) {
        return { content: 'result' };
      },
    },
  ],
  skills: ['skill-name'],                      // embedded skill dir <plugin>/skills/<name>/SKILL.md
  mcpServers: { 'my-server': { command: 'npx', args: ['-y', 'server'] } },
  hooks: { onToolResult(result, { toolName }) { return result; } },
};
```

zod validation failures are skipped automatically with a warning; conflicting tool names are rejected at registration.

## MCP (Model Context Protocol)

### Configuration

```jsonc
// ~/.deepcode/mcp.json (or project .deepcode/mcp.json; the latter overrides)
{
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "sentry": { "url": "http://localhost:8000/mcp" }
}
```

Or `deepcode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .`

### Behavior

- Lazy connection at startup (stdio or HTTP/SSE); a connection failure does not block the main loop (event notification)
- Tools register as `mcp__<server>__<tool>`; MCP tools go through Ask approval by default (configurable via `askApproval: false`)
- After a crash/disconnect, tool calls return an error without interrupting the agent
- Examples: Linear (issue management), Sentry (log capture), Postgres (SQL queries), Buddy (trigger CI/CD)
