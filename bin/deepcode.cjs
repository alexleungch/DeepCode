#!/usr/bin/env node
'use strict';
// deepcode startup shim: suppress node:sqlite experimental warnings and keep the ESM entry loading.
// Also enforces a generous heap limit before loading the compiled app, because the agent keeps
// large model outputs / session history / tool results in memory and can hit Node's default cap.

const MIN_HEAP_MB = 8 * 1024;
const v8 = require('v8');
const heapLimitMb = v8.getHeapStatistics().heap_size_limit / 1024 / 1024;

// If the current heap limit is below our minimum and we haven't already respawned, restart this
// process with --max-old-space-size. This is the only reliable way to raise the limit from a bin
// shim, because V8 reads the flag before the first line of user code runs.
if (heapLimitMb < MIN_HEAP_MB && !process.env.DEEPCODE_RESPAWNED) {
  process.env.DEEPCODE_RESPAWNED = '1';
  process.env.NODE_OPTIONS = [
    process.env.NODE_OPTIONS || '',
    `--max-old-space-size=${MIN_HEAP_MB}`,
    // Capture a heap snapshot as the heap approaches the limit. An old-space OOM is a fatal V8
    // abort that no JS handler can catch (heap exhaustion bypasses uncaughtException), so this
    // is the ONLY automatic way to get evidence after the fact. Snapshots land in the process
    // cwd as *.heapsnapshot and can be diffed in Chrome DevTools to find what is retained.
    '--heapsnapshot-near-heap-limit=2',
  ]
    .filter(Boolean)
    .join(' ');
  const { spawn } = require('child_process');

  // Crash auto-restart: keeps the long-lived daemon (`deepcode telegram`) alive across crashes
  // (e.g. a heap OOM abort), with capped exponential backoff. Enabled by default for the telegram
  // bridge (a human is present to rerun an interactive CLI, so those default to no restart; a
  // headless daemon would otherwise stay down). Force off with DEEPCODE_AUTO_RESTART=0, force on
  // for other invocations with DEEPCODE_AUTO_RESTART=1. Exit code 0 (graceful exit) never restarts.
  const wantRestart =
    process.env.DEEPCODE_AUTO_RESTART === '1' ||
    (process.argv.includes('telegram') && process.env.DEEPCODE_AUTO_RESTART !== '0');
  const MAX_RESTARTS = 5;
  let restarts = 0;
  const neverRestart = (signal) => signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP' || signal === 'SIGKILL';

  const spawnChild = () => {
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: false,
    });
    child.on('exit', (code, signal) => {
      const crashed = signal ? !neverRestart(signal) : code !== 0;
      if (wantRestart && crashed && restarts < MAX_RESTARTS) {
        restarts++;
        const backoffMs = 2000 * restarts;
        console.error(
          `[deepcode] ${signal ? `crashed (${signal})` : `exited with code ${code}`}; restarting in ${backoffMs}ms (${restarts}/${MAX_RESTARTS})...`,
        );
        setTimeout(spawnChild, backoffMs);
        return;
      }
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
    child.on('error', (err) => {
      console.error('[deepcode] failed to respawn with larger heap:', err);
      process.exit(1);
    });
  };
  spawnChild();
  return;
}

process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS || '',
  '--disable-warning=ExperimentalWarning',
  '--no-warnings=ExperimentalWarning',
]
  .filter(Boolean)
  .join(' ');
// suppress warning printing within the current process (NODE_OPTIONS only affects child processes)
process.removeAllListeners('warning');

import('../dist/cli.js').catch((err) => {
  console.error('[deepcode] startup failed (dist not built? run pnpm build first)', err);
  process.exit(1);
});
