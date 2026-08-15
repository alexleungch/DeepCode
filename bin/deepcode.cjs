#!/usr/bin/env node
'use strict';
// deepcode startup shim: suppress node:sqlite experimental warnings and keep the ESM entry loading
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
