import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';

export function configCommand(): Command {
  const cmd = new Command('config');
  cmd.description('Configuration management (~/.deepcode/config.json and project .deepcode/config.json)');
  cmd
    .command('show')
    .description('Show the currently effective config (hides API keys)')
    .action(() => {
      const { config, paths, model } = loadConfig();
      process.stdout.write(`provider: ${config.provider}\nmodel: ${model}\n`);
      process.stdout.write(`User config: ${join(paths.dataDir, 'config.json')}\nProject config: ${join(paths.projectDir, 'config.json')}\n`);
      for (const [pid, ep] of Object.entries(config.providers)) {
        if (!ep) continue;
        const apiKey = 'apiKey' in ep && ep.apiKey ? '****' : '';
        process.stdout.write(`${pid}: ${'baseUrl' in ep && ep.baseUrl ? ep.baseUrl : ''} ${apiKey}\n`);
      }
      process.stdout.write(`Permission mode: ${config.permissions.mode}\nContext: ${config.context.maxTokens} tokens, compaction threshold ${config.context.compactAt}\n`);
      process.stdout.write(`Model: ${JSON.stringify(config.models)}\n`);
    });
  cmd
    .command('init')
    .description('Initialize a user config template')
    .action(() => {
      const { paths } = loadConfig();
      if (existsSync(join(paths.dataDir, 'config.json'))) {
        process.stdout.write('Config already exists; skipping.\n');
        return;
      }
      const template = {
        provider: 'deepseek',
        models: {
          deepseek: 'deepseek-chat',
          anthropic: 'claude-sonnet-4-5',
          gemini: 'gemini-2.5-pro',
          grok: 'grok-4',
          qwen: 'qwen3.8-max',
          ollama: 'qwen3:32b',
        },
        providers: {
          deepseek: { apiKey: 'env:DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
          anthropic: { apiKey: 'env:ANTHROPIC_API_KEY' },
          gemini: { apiKey: 'env:GOOGLE_API_KEY' },
          grok: { apiKey: 'env:XAI_API_KEY', baseUrl: 'https://api.x.ai/v1' },
          qwen: { apiKey: 'env:DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
          ollama: { baseUrl: 'http://localhost:11434' },
        },
        permissions: { mode: 'ask', allow: [], deny: [], additionalDirectories: [] },
      };
      mkdirSync(paths.dataDir, { recursive: true });
      writeFileSync(join(paths.dataDir, 'config.json'), JSON.stringify(template, null, 2), 'utf8');
      process.stdout.write(`Generated config template: ${join(paths.dataDir, 'config.json')}\nSet the environment variable or edit the file to fill in the API key.\n`);
    });
  cmd
    .command('set <key> <value>')
    .description('Set a config key (dot path, e.g. permissions.mode acceptEdits)')
    .action((key: string, value: string) => {
      const { paths } = loadConfig();
      const file = join(paths.dataDir, 'config.json');
      let cfg: Record<string, unknown> = {};
      if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8'));
      const parts = key.split('.');
      let node = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i]!;
        if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
        node = node[p] as Record<string, unknown>;
      }
      const last = parts[parts.length - 1]!;
      if (value === 'true') node[last] = true;
      else if (value === 'false') node[last] = false;
      else if (/^-?\d+(\.\d+)?$/.test(value)) node[last] = Number(value);
      else node[last] = value;
      writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
      process.stdout.write(`Set ${key}=${value} (${file})\n`);
    });
  return cmd;
}
