import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { deepcodeConfigSchema, type DeepcodeConfig } from './types.js';
import { defaultConfig, mergeConfig, modelMetaFor } from './defaults.js';

export const DEEPCODE_DIR_NAME = '.deepcode';

export interface ResolvedPaths {
  /** User data directory ~/.deepcode */
  dataDir: string;
  /** Project directory .deepcode (may not exist) */
  projectDir: string;
  /** Session directory */
  sessionsDir: string;
  /** Screenshot directory */
  screenshotsDir: string;
  /** Log directory */
  logsDir: string;
  /** User-level skills directory */
  userSkillsDir: string;
  /** User-level plugins directory */
  userPluginsDir: string;
  /** User-level system-prompt extension file */
  systemPromptFile: string;
  /** Memory database path */
  memoryDbPath: string;
  /** Usage database path */
  usageDbPath: string;
}

export interface ResolvedConfig {
  config: DeepcodeConfig;
  paths: ResolvedPaths;
  workspace: string;
  /** Effective model ID */
  model: string;
  /** Effective model metadata */
  modelMeta: ReturnType<typeof import('./defaults.js').modelMetaFor>;
}

/** Resolve "env:VAR" style values; returns undefined when the variable is not set */
export function resolveEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^env:([A-Z0-9_]+)$/i.exec(value.trim());
  if (m) {
    const v = m[1] ? process.env[m[1]] : undefined;
    if (!v) {
      // keep the placeholder but signal it is unresolved
      return undefined;
    }
    return v;
  }
  return value;
}

/** Environment variable that holds the API key for each provider */
export const API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  grok: 'XAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  'openai-compat': 'DEEPCODE_API_KEY',
};

function loadJsonFile<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  let raw = readFileSync(file, 'utf8');
  // Strip a UTF-8 BOM if present (e.g. files rewritten by PowerShell/Windows editors); JSON.parse rejects it
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const parsed = JSON.parse(raw) as T;
  return parsed;
}

/** Resolve ~ and relative paths (relative to the workspace) */
function resolvePath(p: string, workspace: string): string {
  if (p === '~' || p.startsWith('~/')) return join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(workspace, p);
}

export function loadConfig(opts?: { workspace?: string; model?: string; provider?: string }): ResolvedConfig {
  const workspace = opts?.workspace ?? process.cwd();
  // DEEPCODE_HOME overrides the data directory (tests / portable deployments)
  const dataDir = process.env.DEEPCODE_HOME ? resolve(process.env.DEEPCODE_HOME) : join(homedir(), DEEPCODE_DIR_NAME);
  const projectDir = join(workspace, DEEPCODE_DIR_NAME);

  // Layered loading: defaults -> user -> project
  let config = defaultConfig();
  const userFile = join(dataDir, 'config.json');
  const projectFile = join(projectDir, 'config.json');
  const userCfg = loadJsonFile<Partial<DeepcodeConfig>>(userFile);
  const projectCfg = loadJsonFile<Partial<DeepcodeConfig>>(projectFile);
  if (userCfg) config = mergeConfig(config, userCfg);
  if (projectCfg) config = mergeConfig(config, projectCfg);

  // MCP servers: ~/.deepcode/mcp.json merged with project .deepcode/mcp.json (project wins)
  const userMcp = loadJsonFile<Record<string, unknown>>(join(dataDir, 'mcp.json'));
  const projectMcp = loadJsonFile<Record<string, unknown>>(join(projectDir, 'mcp.json'));
  config = mergeConfig(config, { mcpServers: { ...(userMcp ?? {}), ...(projectMcp ?? {}) } } as Partial<DeepcodeConfig>);

  // CLI overrides
  if (opts?.provider) config = { ...config, provider: opts.provider as DeepcodeConfig['provider'] };
  if (opts?.model) config = { ...config, models: { ...config.models, [config.provider]: opts.model } };

  // env:VAR resolution + environment variable fallback
  const p = config.providers;
  for (const pid of ['anthropic', 'deepseek', 'grok', 'gemini', 'openai-compat'] as const) {
    const ep = p[pid];
    if (!ep) continue;
    ep.apiKey = resolveEnvValue(ep.apiKey);
    if (!ep.apiKey) {
      const envKey = API_KEY_ENV[pid];
      if (envKey && process.env[envKey]) ep.apiKey = process.env[envKey];
    }
    ep.baseUrl = resolveEnvValue(ep.baseUrl) ?? ep.baseUrl;
  }
  if (p.ollama?.baseUrl) p.ollama.baseUrl = resolveEnvValue(p.ollama.baseUrl) ?? p.ollama.baseUrl;

  // Validate (schema is partial; the parsed result is merged back into defaults)
  const parsed = deepcodeConfigSchema.safeParse(config);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Config validation failed: ${msg}`);
  }
  config = mergeConfig(defaultConfig(), parsed.data as Partial<DeepcodeConfig>);

  const model = config.models[config.provider] ?? 'unknown-model';
  const modelMeta = modelMetaFor(config, model);

  // Normalize additionalDirectories / mcp relative paths
  config.permissions.additionalDirectories = config.permissions.additionalDirectories.map((d) =>
    resolvePath(d, workspace),
  );

  const paths: ResolvedPaths = {
    dataDir,
    projectDir,
    sessionsDir: join(dataDir, 'sessions'),
    screenshotsDir: join(projectDir, 'review-screenshots'),
    logsDir: join(dataDir, 'logs'),
    userSkillsDir: join(dataDir, 'skills'),
    userPluginsDir: join(dataDir, 'plugins'),
    systemPromptFile: join(dataDir, 'system-prompt.md'),
    memoryDbPath: config.memory.dbPath ? resolvePath(config.memory.dbPath, workspace) : join(dataDir, 'memory.db'),
    usageDbPath: join(dataDir, 'usage.db'),
  };

  for (const dir of [paths.sessionsDir, paths.screenshotsDir, paths.logsDir, paths.userSkillsDir, paths.userPluginsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return { config, paths, workspace, model, modelMeta };
}
