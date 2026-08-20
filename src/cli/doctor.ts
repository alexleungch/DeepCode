import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig } from '../config/loader.js';
import { BUILTIN_MODEL_META } from '../config/defaults.js';

function check(name: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? '✅' : '❌'} ${name}: ${detail}\n`);
}

function checkBinary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['--version'], { timeout: 3000 }, (err) => resolve(!err));
    } catch {
      resolve(false); // Treat as not installed when spawn is rejected by the environment (e.g. sandbox)
    }
  });
}

export async function runDoctor(): Promise<void> {
  process.stdout.write('deepcode doctor — environment self-check\n');
  check('Node.js', process.versions.node !== undefined, `v${process.versions.node}`);
  const gitOk = await checkBinary('git');
  check('git', gitOk, gitOk ? 'available' : 'not installed (worktree isolation unavailable)');
  const rgOk = await checkBinary('rg');
  check('ripgrep', rgOk, rgOk ? 'available (grep acceleration)' : 'not installed (grep falls back to built-in scanning)');

  const resolved = loadConfig();
  const { config, model } = resolved;

  const keyChecks: Record<string, () => string> = {
    anthropic: () => config.providers.anthropic?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '',
    deepseek: () => config.providers.deepseek?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
    grok: () => config.providers.grok?.apiKey ?? process.env.XAI_API_KEY ?? '',
    gemini: () => config.providers.gemini?.apiKey ?? process.env.GOOGLE_API_KEY ?? '',
    qwen: () => config.providers.qwen?.apiKey ?? process.env.DASHSCOPE_API_KEY ?? '',
    openrouter: () => config.providers.openrouter?.apiKey ?? process.env.OPENROUTER_API_KEY ?? '',
  };
  for (const [pid, get] of Object.entries(keyChecks)) {
    check(`${pid} API key`, !!get(), get() ? 'configured' : 'not configured');
  }

  const meta = BUILTIN_MODEL_META[model];
  check('current model', !!meta || config.modelMeta[model] !== undefined, `${config.provider}/${model}${meta ? ` (window ${meta.windowTokens}, ${meta.cacheControl} caching)` : ' (custom, uses config metadata)'}`);

  // Ollama connectivity
  const base = config.providers.ollama?.baseUrl ?? 'http://localhost:11434';
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    check('Ollama', res.ok, res.ok ? `${base} reachable` : `${base} returned ${res.status}`);
  } catch {
    check('Ollama', false, `${base} unreachable (local models unavailable)`);
  }

  // Memory database
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(resolved.paths.memoryDbPath);
    db.exec('SELECT 1');
    db.close();
    check('SQLite', true, 'node:sqlite available');
  } catch (e) {
    check('SQLite', false, `unavailable (usage/memory falls back to JSONL): ${e instanceof Error ? e.message : String(e)}`);
  }

  process.stdout.write('\nTip: use `deepcode config` to set the API key; use `ollama serve` to start a local model.\n');
}
