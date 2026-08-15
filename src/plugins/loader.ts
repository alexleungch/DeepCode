import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Plugin } from './types.js';
import type { PluginConfig } from '../config/types.js';

const toolShape = z.object({
  name: z.string().min(1).max(64),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  permission: z.enum(['read', 'write', 'execute', 'ask']),
  execute: z.function(),
});

const mcpShape = z.record(
  z.string(),
  z
    .object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .refine((s) => s.command || s.url, { message: 'command or url is required' }),
);

const pluginShape = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(toolShape).default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: mcpShape.default({}),
  hooks: z
    .object({
      onToolResult: z.function().optional(),
    })
    .optional(),
});

/** ESM plugin loader: scan directories → import() → zod validation */
export class PluginLoader {
  constructor(
    private userPluginsDir: string,
    private config: PluginConfig,
    private extraDirs: string[] = [],
  ) {}

  private scanDir(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  async loadOne(pluginDir: string): Promise<Plugin | null> {
    // Supports plugin.js / plugin.mjs / index.js
    for (const f of ['plugin.js', 'plugin.mjs', 'index.js']) {
      const file = join(pluginDir, f);
      if (!existsSync(file)) continue;
      try {
        const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; plugin?: unknown };
        const raw = mod.default ?? mod.plugin;
        const parsed = pluginShape.safeParse(raw);
        if (!parsed.success) {
          console.warn(`[deepcode] Plugin ${pluginDir} validation failed: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
          return null;
        }
        return parsed.data as Plugin;
      } catch (e) {
        console.warn(`[deepcode] Plugin ${pluginDir} failed to load: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
    return null;
  }

  async loadAll(): Promise<Plugin[]> {
    const dirs = [this.userPluginsDir, ...this.config.directories, ...this.extraDirs];
    const plugins: Plugin[] = [];
    for (const dir of dirs) {
      for (const name of this.scanDir(dir)) {
        const pluginDir = join(dir, name);
        try {
          if (!statSync(pluginDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const plugin = await this.loadOne(pluginDir);
        if (plugin) plugins.push(plugin);
      }
    }
    // Dedupe (later loads override same-name plugins)
    const byId = new Map<string, Plugin>();
    for (const p of plugins) byId.set(p.id, p);
    return [...byId.values()];
  }
}
