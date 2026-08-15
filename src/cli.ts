import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { render } from 'ink';
import React from 'react';
import { loadConfig } from './config/loader.js';
import { DeepcodeEngine } from './engine.js';
import { createPrintRenderer } from './ui/print.js';
import { DeepcodeTUI } from './ui/app.js';
import { SessionStore } from './session/store.js';
import { runDoctor } from './cli/doctor.js';
import { sessionsCommand } from './cli/sessions.js';
import { usageCommand } from './cli/usage.js';
import { memoryCommand } from './cli/memory.js';
import { skillsCommand } from './cli/skills.js';
import { pluginsCommand } from './cli/plugins.js';
import { mcpCommand } from './cli/mcp.js';
import { configCommand } from './cli/config.js';

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name('deepcode')
    .description('Claude Code-style TypeScript TUI coding agent: multi-provider, MCP, Skills, Plugins, Agent Memory, Prompt Caching')
    .version('0.1.0')
    .option('-p, --print', 'Headless print mode (same engine, plain-text output)')
    .option('-c, --continue', 'Resume the most recent session')
    .option('--resume <id>', 'Resume a specific session')
    .option('--model <model>', 'Model name (overrides config)')
    .option('--provider <provider>', 'Provider: anthropic|deepseek|grok|gemini|ollama|openai-compat')
    .option('--permission-mode <mode>', 'Permission mode: ask|acceptEdits|plan|bypassPermissions')
    .option('--worktree <mode>', 'Subagent worktree: auto|on|off')
    .option('-v, --verbose', 'Verbose output')
    .argument('[prompt...]', 'Instruction to pass directly to the agent (omit to enter interactive mode)');

  // Subcommands
  program.addCommand(configCommand());
  program.addCommand(doctorCommand());
  program.addCommand(sessionsCommand());
  program.addCommand(usageCommand());
  program.addCommand(memoryCommand());
  program.addCommand(skillsCommand());
  program.addCommand(pluginsCommand());
  program.addCommand(mcpCommand());

  program.action(async (promptArgs: string[], options: Record<string, unknown>) => {
    const prompt = promptArgs.join(' ');
    const print = !!options.print;
    const mode = options.permissionMode as string | undefined;
    if (mode && !['ask', 'acceptEdits', 'plan', 'bypassPermissions'].includes(mode)) {
      console.error(`Invalid permission mode: ${mode} (options: ask|acceptEdits|plan|bypassPermissions)`);
      process.exit(1);
    }

    const resolved = loadConfig({
      model: options.model as string | undefined,
      provider: options.provider as string | undefined,
    });

    // Resume session
    let resumeSession;
    if (options.resume || options.continue) {
      const store = new SessionStore(resolved.paths.sessionsDir);
      const id = (options.resume as string) ?? store.list()[0]?.id;
      resumeSession = id ? store.load(id) : undefined;
      if (!resumeSession) {
        console.error(`Session not found: ${id ?? '(no recent session)'}`);
        process.exit(1);
      }
    }

    // Engine assembly
    const engine = new DeepcodeEngine({
      resolved,
      resumeSession,
      permissionMode: mode as import('./config/types.js').PermissionMode | undefined,
      title: prompt ? prompt.slice(0, 60) : undefined,
    });

    // Interactive mode: TTY → Ink TUI; otherwise the --print renderer
    const tui = !print && process.stdin.isTTY && process.stdout.isTTY && !options.nonInteractive;
    if (tui) {
      await engine.init();
      await runTUI(engine);
    } else if (print) {
      const renderer = createPrintRenderer({ usage: engine.usage, verbose: !!options.verbose });
      engine.onEvent(renderer.onEvent);
      await engine.init();
      if (prompt) await engine.runTurn(prompt);
      else await interactiveLoop(engine, true);
    } else {
      const renderer = createPrintRenderer({ usage: engine.usage, verbose: !!options.verbose });
      engine.onEvent(renderer.onEvent);
      await engine.init();
      await interactiveLoop(engine, false);
    }

    await engine.finalizeMemory();
    engine.close();
  });

  await program.parseAsync(argv, { from: 'user' });
}

/** Ink TUI entry */
function runTUI(engine: DeepcodeEngine): Promise<void> {
  return new Promise((resolve) => {
    const instance = render(
      React.createElement(DeepcodeTUI, {
        engine,
        onExit: () => {
          instance.unmount();
          resolve();
        },
      }),
    );
  });
}

/** Interactive loop: reads user input (replaced by the Ink App in TUI mode) */
async function interactiveLoop(engine: DeepcodeEngine, print: boolean): Promise<void> {
  if (!process.stdin.isTTY || !print) {
    if (!print) {
      process.stdout.write('[deepcode] Interactive mode requires a TTY; running in --print mode (one line in, one line out)\n');
    }
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => {
    readline.question('deepcode> ', async (line) => {
      const input = line.trim();
      if (!input) return ask();
      if (input === '/exit' || input === '/quit') {
        readline.close();
        return;
      }
      if (input === '/clear') {
        engine.session.messages = [];
        readline.close();
        return;
      }
      await engine.runTurn(input);
      ask();
    });
  };
  ask();
  await new Promise<void>((resolve) => readline.on('close', resolve));
}

function doctorCommand(): Command {
  const cmd = new Command('doctor');
  cmd.description('Environment self-check (node/git/rg/API key/ollama connectivity)');
  cmd.action(() => runDoctor());
  return cmd;
}

// ESM entry bootstrap
const isMain = process.argv[1] && /(cli|deepcode)(\.js|\.cjs)?$/.test(process.argv[1]?.replace(/\\/g, '/').split('/').pop() ?? '');
if (isMain || process.env.DEEPCODE_ENTRY) {
  // Suppress node:sqlite experimental warning output (the bin shim also applies when running dist directly)
  process.removeAllListeners('warning');
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
