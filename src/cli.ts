import { Command } from 'commander';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { render } from 'ink';
import React from 'react';
import { loadConfig } from './config/loader.js';
import { startMemoryWatchdog } from './monitor/memory.js';
import { DeepcodeEngine } from './engine.js';
import { createPrintRenderer } from './ui/print.js';
import { DeepcodeTUI } from './ui/app.js';
import { detectTerminalBackground } from './ui/background.js';
import { SessionStore } from './session/store.js';
import { TraceRecorder } from './trace/recorder.js';
import { runDoctor } from './cli/doctor.js';
import { sessionsCommand } from './cli/sessions.js';
import { usageCommand } from './cli/usage.js';
import { memoryCommand } from './cli/memory.js';
import { skillsCommand } from './cli/skills.js';
import { pluginsCommand } from './cli/plugins.js';
import { mcpCommand } from './cli/mcp.js';
import { evalCommand } from './cli/eval.js';
import { telegramCommand } from './cli/telegram.js';
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
    .option('--provider <provider>', 'Provider: anthropic|deepseek|grok|gemini|qwen|ollama|openrouter|openai-compat')
    .option('--permission-mode <mode>', 'Permission mode: ask|acceptEdits|plan|bypassPermissions')
    .option('--theme <id>', 'TUI theme: default|dracula|gruvbox|nord|solarized|matrix|light|gruvbox-light (auto-detects light terminals when unset)')
    .option('--worktree <mode>', 'Subagent worktree: auto|on|off')
    .option('--trace [dir]', 'Record an engine event trace (JSONL) for replay-based regression tests; defaults to <data dir>/traces')
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
  program.addCommand(evalCommand());
  program.addCommand(telegramCommand());

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

    // CLI theme override (applied before the engine is created so the palette is
    // active by the time the TUI first renders; unknown ids fall back to default)
    if (options.theme) {
      resolved.config.ui = { ...resolved.config.ui, theme: options.theme as string };
    }

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

    // Trace recording: `--trace` captures the full EngineEvent stream as JSONL so a session
    // can be replayed deterministically (src/trace/replay.ts) for regression tests. Attach
    // before init() so the session-start event is captured.
    if (options.trace !== undefined) {
      const tracesDir = typeof options.trace === 'string' && options.trace
        ? options.trace
        : join(dirname(resolved.paths.sessionsDir), 'traces');
      const recorder = new TraceRecorder(tracesDir, engine.session.id);
      engine.onEvent(recorder.onEvent);
    }

    // Graceful shutdown on SIGINT/SIGTERM: flush memory/session/usage instead of dropping them.
    // Ctrl+C in the TUI is handled by the UI (interrupt or graceful exit); this covers the
    // headless/print path and external signals (e.g. `kill`).
    let shutdownDone = false;
    const shutdown = async () => {
      if (shutdownDone) return;
      shutdownDone = true;
      try {
        await engine.finalizeMemory();
      } catch {
        // never block exit on memory finalization failures
      }
      engine.close();
    };
    const onSignal = () => {
      void shutdown().then(() => process.exit(0));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      // Interactive mode: TTY → Ink TUI; otherwise the --print renderer
      const tui = !print && process.stdin.isTTY && process.stdout.isTTY && !options.nonInteractive;
      if (tui) {
        await engine.init();
        // Long-lived interactive session: sample memory into ~/.deepcode/logs/memory.log and warn
        // before a heap OOM can kill the process (V8 OOM aborts cannot be caught in JS).
        const stopMemoryWatchdog = startMemoryWatchdog({ logDir: resolved.paths.logsDir });
        try {
          await runTUI(engine);
        } finally {
          stopMemoryWatchdog();
        }
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
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await shutdown();
    }
  });

  await program.parseAsync(argv, { from: 'user' });
}

/** Ink TUI entry */
async function runTUI(engine: DeepcodeEngine): Promise<void> {
  // Auto theme selection: when NO theme is configured (config ui.theme / --theme),
  // probe the terminal background (OSC 11) and pick the light palette on light
  // terminals — a Mac-default white background otherwise renders the dark themes'
  // near-white text unreadably. This is an adaptive default, never persisted
  // (a later /theme <id> or config value always wins).
  if (!engine.config.ui?.theme) {
    try {
      const bg = await detectTerminalBackground();
      if (bg === 'light') engine.setTheme('light', false);
    } catch {
      // detection must never break startup — keep the configured/default theme
    }
  }
  return new Promise((resolve) => {
    // Enter the alternate screen buffer so deepcode takes over the whole terminal like vim/top:
    // the previous terminal contents are preserved and restored on exit. We also hide the
    // terminal's native cursor — the PromptInput renders its own inverse-video cursor block,
    // and having both visible at once is confusing. Bracketed paste mode (`\x1b[?2004h`) makes
    // the terminal wrap pasted content in `\x1b[200~ … \x1b[201~` so the input handler can
    // treat a multi-line paste as one atomic insert instead of each `\n` triggering submit.
    // Mouse tracking (`\x1b[?1000h` + SGR coordinates `\x1b[?1006h`) lets the TUI scroll the main
    // viewport with the wheel; wheel events arrive as `\x1b[<64;…M` / `\x1b[<65;…M` and are
    // parsed by the app's input handlers (see src/ui/mouse.ts).
    const enterScreen = '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h';
    const exitScreen = '\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l';
    let restored = false;
    const restoreOnce = () => {
      if (restored) return;
      restored = true;
      process.stdout.write(exitScreen);
    };

    // Crash handlers: while the TUI owns the alternate screen buffer, any fatal error or unhandled
    // rejection that escapes would be invisible (the terminal is still showing the TUI buffer). We
    // must restore the normal buffer and print the error before exiting, otherwise the process
    // appears to hang with a blank/frozen screen. Note: V8 OOM fatal errors bypass these handlers,
    // which is why the bin shim also raises --max-old-space-size.
    const onFatal = (err: unknown, _promise?: Promise<unknown>) => {
      restoreOnce();
      process.removeListener('exit', restoreOnce);
      console.error(err instanceof Error ? err.stack || err.message : err);
      process.exit(1);
    };
    process.once('uncaughtException', onFatal);
    process.once('unhandledRejection', onFatal);

    process.stdout.write(enterScreen);
    // Best-effort restore if the process is killed (SIGTERM/SIGHUP) — normal exit goes through
    // the onExit path below. 'exit' fires on process.exit() and uncaught fatal exceptions.
    process.once('exit', restoreOnce);
    const instance = render(
      React.createElement(DeepcodeTUI, {
        engine,
        onExit: () => {
          instance.unmount();
          restoreOnce();
          process.removeListener('exit', restoreOnce);
          process.removeListener('uncaughtException', onFatal);
          process.removeListener('unhandledRejection', onFatal);
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
        return ask(); // clear and continue the loop — closing readline here would EXIT the session
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
