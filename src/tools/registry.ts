import type { ToolDef } from './types.js';
import type { ToolSchema } from '../providers/types.js';

/** Tool registry: unified registration and lookup for native + plugin + mcp. */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private order: string[] = [];

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool name conflict: ${tool.name} (already registered)`);
    }
    this.tools.set(tool.name, tool);
    this.order.push(tool.name);
  }

  /** Override registration (caller decides semantics on plugin/mcp conflicts). */
  registerOrReplace(tool: ToolDef): void {
    if (!this.tools.has(tool.name)) this.order.push(tool.name);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDef[] {
    return this.order.map((n) => this.tools.get(n)).filter((t): t is ToolDef => !!t);
  }

  /** Tool schemas for LLM requests (order matches registration order for stable prefixes). */
  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
