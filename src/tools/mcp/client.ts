import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';
import type { Skill } from '../../skills/types.js';

/**
 * MCP client management: stdio (command/args/env) and HTTP/SSE (url) servers.
 * Lazy connection: connects at startup; failure does not block the main loop (the tool is marked unavailable).
 */
interface McpToolBridge {
  /** MCP tool registered as a ToolDef. */
  toToolDef(serverName: string, tool: { name: string; description?: string; inputSchema?: unknown }): ToolDef;
}

const mcpCallSchema = z.record(z.string(), z.unknown());

export async function connectMcpServer(
  serverName: string,
  cfg: { command?: string; args?: string[]; url?: string; env?: Record<string, string>; toolPrefix?: string; askApproval?: boolean },
): Promise<{ tools: ReturnType<McpToolBridge['toToolDef']>[]; close: () => Promise<void> } | { error: string }> {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const client = new Client({ name: 'deepcode', version: '0.1.0' });
    let transport;
    if (cfg.command) {
      const env: Record<string, string> = {};
      if (cfg.env) {
        for (const [k, v] of Object.entries(cfg.env)) {
          if (v !== undefined) env[k] = v;
        }
      }
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
        stderr: 'pipe',
      });
    } else if (cfg.url) {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url));
    } else {
      return { error: 'MCP server requires a command or url' };
    }

    await client.connect(transport);
    const list = await client.listTools();
    const prefix = cfg.toolPrefix ?? `mcp__${serverName}__`;
    const ask = cfg.askApproval ?? true;

    const tools = list.tools.map((t) => {
      const def: ToolDef = {
        name: `${prefix}${t.name}`,
        description: t.description ?? `MCP tool ${serverName}.${t.name}`,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
        permission: ask ? 'ask' : 'execute',
        async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
          const parsed = mcpCallSchema.safeParse(input);
          const result = await client.callTool({
            name: t.name,
            arguments: parsed.success ? (parsed.data as Record<string, unknown>) : {},
          });
          // Normalize the MCP result (content array → text)
          const content = Array.isArray(result.content)
            ? result.content
                .map((c) => {
                  const b = c as { type?: string; text?: string; image?: string; data?: string };
                  if (b.type === 'text') return b.text ?? '';
                  if (b.type === 'image') return `[image data:${(b.data ?? '').slice(0, 40)}…]`;
                  return JSON.stringify(b);
                })
                .join('\n')
            : JSON.stringify(result.content);
          return { content: content.slice(0, 30_000), isError: result.isError === true };
        },
      };
      return def;
    });

    return {
      tools,
      close: async () => {
        try {
          await client.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (e) {
    return { error: `MCP server ${serverName} connection failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
