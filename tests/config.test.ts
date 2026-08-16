import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { defaultConfig, mergeConfig, modelMetaFor, pricingFor } from '../src/config/defaults.js';
import { maxOutputTokens } from '../src/agent/loop.js';
import type { ModelMeta } from '../src/config/types.js';

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

describe('max_tokens safety (regression: DeepSeek 400 "valid range of max_tokens is [1, 393216]")', () => {
  it('never sends an unbounded max_tokens for a model without explicit metadata', () => {
    const meta: ModelMeta = {
      id: 'deepseek-v4-flash',
      windowTokens: 128_000,
      supportsVision: false,
      supportsTools: true,
      cacheControl: 'auto',
    };
    expect(maxOutputTokens(meta)).toBeLessThanOrEqual(32_768);
    expect(maxOutputTokens(meta)).toBeGreaterThan(0);
  });

  it('prefers the explicit per-model cap', () => {
    const meta: ModelMeta = {
      id: 'deepseek-v4-flash',
      windowTokens: 1_000_000,
      maxOutputTokens: 393_216,
      supportsVision: false,
      supportsTools: true,
      supportsThinking: true,
      cacheControl: 'auto',
    };
    expect(maxOutputTokens(meta)).toBe(393_216);
  });

  it('builtin deepseek-v4 metadata carries the documented window and output cap', () => {
    const cfg = defaultConfig();
    const flash = modelMetaFor(cfg, 'deepseek-v4-flash');
    expect(flash.windowTokens).toBe(1_000_000);
    expect(flash.maxOutputTokens).toBe(393_216);
    const chat = modelMetaFor(cfg, 'deepseek-chat');
    expect(chat.maxOutputTokens).toBe(8_192); // within the legacy alias' documented limit
  });

  it('pricingFor resolves deepseek-v4 prices', () => {
    const cfg = defaultConfig();
    expect(pricingFor(cfg, 'deepseek-v4-flash').input).toBe(0.14);
    expect(pricingFor(cfg, 'deepseek-v4-flash').output).toBe(0.28);
  });
});
