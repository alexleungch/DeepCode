import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { defaultConfig, mergeConfig, modelMetaFor, pricingFor } from '../src/config/defaults.js';

let home: string;
let workspace: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'deepcode-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'deepcode-ws-'));
  prevHome = process.env.DEEPCODE_HOME;
  process.env.DEEPCODE_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.DEEPCODE_HOME;
  else process.env.DEEPCODE_HOME = prevHome;
});

describe('loadConfig', () => {
  it('uses defaults (deepseek / ask mode)', () => {
    const r = loadConfig({ workspace });
    expect(r.config.provider).toBe('deepseek');
    expect(r.config.permissions.mode).toBe('ask');
    expect(r.model).toBe('deepseek-chat');
    expect(r.paths.dataDir).toBe(home);
  });

  it('layered merge: project config overrides user config', () => {
    mkdirSync(join(home), { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ provider: 'gemini' }), 'utf8');
    mkdirSync(join(workspace, '.deepcode'), { recursive: true });
    writeFileSync(
      join(workspace, '.deepcode', 'config.json'),
      JSON.stringify({ permissions: { mode: 'acceptEdits' } }),
      'utf8',
    );
    const r = loadConfig({ workspace });
    expect(r.config.provider).toBe('gemini'); // user config
    expect(r.config.permissions.mode).toBe('acceptEdits'); // project config overrides
  });

  it('resolves env:VAR and env fallback', () => {
    process.env.TEST_KEY = 'secret';
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ providers: { deepseek: { apiKey: 'env:TEST_KEY', baseUrl: 'http://x' } } }),
      'utf8',
    );
    const r = loadConfig({ workspace });
    expect(r.config.providers.deepseek?.apiKey).toBe('secret');
    delete process.env.TEST_KEY;
  });

  it('environment variable fallback for the API key', () => {
    process.env.DEEPSEEK_API_KEY = 'env-secret';
    const r = loadConfig({ workspace });
    expect(r.config.providers.deepseek?.apiKey).toBe('env-secret');
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('CLI overrides provider and model', () => {
    const r = loadConfig({ workspace, provider: 'ollama', model: 'qwen2.5-coder:32b' });
    expect(r.config.provider).toBe('ollama');
    expect(r.config.models['ollama']).toBe('qwen2.5-coder:32b');
    expect(r.model).toBe('qwen2.5-coder:32b');
  });
});

describe('mergeConfig / modelMetaFor / pricingFor', () => {
  it('mergeConfig deep-merges key sections', () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, { context: { maxTokens: 200_000, compactAt: 0.8, autoCompact: true, keepRecentTurns: 3, maxSummaryTokens: 5000 } });
    expect(merged.context.maxTokens).toBe(200_000);
    expect(merged.context.keepRecentTurns).toBe(3);
    expect(merged.permissions.mode).toBe('ask'); // untouched sections keep defaults
  });

  it('modelMetaFor built-in metadata + user overrides', () => {
    const cfg = mergeConfig(defaultConfig(), {
      modelMeta: { 'deepseek-chat': { supportsVision: true } },
    });
    const meta = modelMetaFor(cfg, 'deepseek-chat');
    expect(meta.windowTokens).toBe(128_000);
    expect(meta.supportsVision).toBe(true); // override applied
    expect(meta.cacheControl).toBe('auto');
  });

  it('pricingFor default prices + overrides', () => {
    const cfg = mergeConfig(defaultConfig(), { pricing: { 'deepseek-chat': { input: 0.5 } } });
    const p = pricingFor(cfg, 'deepseek-chat');
    expect(p.input).toBe(0.5);
    expect(p.output).toBe(1.1); // untouched keeps the built-in value
  });
});
