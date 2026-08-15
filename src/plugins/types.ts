import type { ToolDef } from '../tools/types.js';
import type { McpServerConfig } from '../config/types.js';

/**
 * Plugin contract (DSH style, plain JS ESM, no build step):
 * exports a default object { id, name, tools?, skills?, mcpServers?, hooks? }
 * - tools: ToolDef[] (inputSchema is a JSON Schema)
 * - skills: array of plugin-embedded skill directory names (the loader resolves {id}/skills/<name>/SKILL.md)
 * - mcpServers: Record<name, McpServerConfig>
 * - hooks: { onToolResult?(result, ctx): result }
 */
export interface Plugin {
  id: string;
  name: string;
  version?: string;
  description?: string;
  tools: ToolDef[];
  skills: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks?: {
    onToolResult?: (result: import('../tools/types.js').ToolResult, ctx: { toolName: string }) => import('../tools/types.js').ToolResult;
  };
}

export interface PluginScopeConfig {
  enabled: boolean;
  directories: string[];
}

/** Skill source resolved from a plugin directory */
export interface PluginSkillSource {
  pluginId: string;
  dir: string;
}
