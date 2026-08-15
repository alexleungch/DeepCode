import { describe, it, expect } from 'vitest';
import { PermissionGate, riskOf, DEFAULT_DENY_PATTERNS } from '../src/tools/permission.js';
import { defaultConfig, mergeConfig } from '../src/config/defaults.js';
import type { ApprovalItem } from '../src/tools/permission.js';

const ws = 'C:/project';
const gate = (cfg = defaultConfig()) => new PermissionGate(cfg, ws);

const item = (partial: Partial<ApprovalItem>): ApprovalItem => ({
  callId: 'c1',
  toolName: 'run_terminal_cmd',
  description: 'execute command',
  risk: 'medium',
  ...partial,
});

describe('PermissionGate', () => {
  it('ask mode requires human approval for writes/executions (returns undefined)', () => {
    const g = gate();
    expect(g.check(item({ toolName: 'run_terminal_cmd', command: 'npm test' }))).toBeUndefined();
    expect(g.check(item({ toolName: 'edit_file', diff: 'x' }))).toBeUndefined();
  });

  it('read-only tools are auto-allowed', () => {
    const g = gate();
    expect(g.check(item({ toolName: 'read_file', path: 'C:/project/a.ts' }))?.action).toBe('allow');
    expect(g.check(item({ toolName: 'glob', description: '**/*.ts' }))?.action).toBe('allow');
  });

  it('dangerous command blacklist hard-denies (including bypass mode)', () => {
    for (const mode of ['ask', 'acceptEdits', 'bypassPermissions'] as const) {
      const g = gate(mergeConfig(defaultConfig(), { permissions: { mode, allow: [], deny: [], additionalDirectories: [] } }));
      expect(g.check(item({ command: 'rm -rf /' }))?.action).toBe('deny');
      expect(g.check(item({ command: 'git push origin main --force' }))?.action).toBe('deny');
    }
  });

  it('allow rules can override the blacklist', () => {
    const g = gate(
      mergeConfig(defaultConfig(), {
        permissions: { mode: 'ask', allow: ['run_terminal_cmd:^git push --force'], deny: [], additionalDirectories: [] },
      }),
    );
    expect(g.check(item({ command: 'git push --force' }))?.action).toBe('allow');
    expect(g.check(item({ command: 'rm -rf /' }))?.action).toBe('deny');
  });

  it('out-of-workspace paths are denied', () => {
    const g = gate();
    expect(g.check(item({ toolName: 'edit_file', path: 'C:/outside/file.ts' }))?.action).toBe('deny');
    expect(g.check(item({ toolName: 'edit_file', path: 'C:/project/inside.ts' }))?.action).toBeUndefined();
  });

  it('additionalDirectories allows', () => {
    const g = gate(mergeConfig(defaultConfig(), { permissions: { mode: 'ask', allow: [], deny: [], additionalDirectories: ['C:/extra'] } }));
    expect(g.check(item({ toolName: 'write_file', path: 'C:/extra/x.ts' }))?.action).toBeUndefined();
  });

  it('acceptEdits allows file edits; commands still need approval', () => {
    const g = gate(mergeConfig(defaultConfig(), { permissions: { mode: 'acceptEdits', allow: [], deny: [], additionalDirectories: [] } }));
    expect(g.check(item({ toolName: 'edit_file', path: 'C:/project/x.ts' }))?.action).toBe('allow');
    expect(g.check(item({ toolName: 'run_terminal_cmd', command: 'npm test' }))).toBeUndefined();
  });

  it('plan mode denies writes and executions', () => {
    const g = gate(mergeConfig(defaultConfig(), { permissions: { mode: 'plan', allow: [], deny: [], additionalDirectories: [] } }));
    expect(g.check(item({ toolName: 'edit_file', path: 'C:/project/x.ts' }))?.action).toBe('deny');
    expect(g.check(item({ toolName: 'run_terminal_cmd', command: 'ls' }))?.action).toBe('deny');
    expect(g.check(item({ toolName: 'read_file', path: 'C:/project/x.ts' }))?.action).toBe('allow');
  });

  it('remember records always decisions', () => {
    const g = gate();
    g.check(item({ toolName: 'run_terminal_cmd', command: 'npm test' }));
    g.remember({ callId: 'c1', action: 'allow-always' });
    expect(g.check(item({ toolName: 'run_terminal_cmd', command: 'npm test' }))?.action).toBe('allow');
  });

  it('deny rules reject specific commands', () => {
    const g = gate(mergeConfig(defaultConfig(), { permissions: { mode: 'ask', allow: [], deny: ['run_terminal_cmd:^npm publish'], additionalDirectories: [] } }));
    expect(g.check(item({ command: 'npm publish' }))?.action).toBe('deny');
    expect(g.check(item({ command: 'npm test' }))).toBeUndefined();
  });
});

describe('riskOf / DEFAULT_DENY_PATTERNS', () => {
  it('risk classification', () => {
    expect(riskOf('run_terminal_cmd', 'rm -rf build')).toBe('high');
    expect(riskOf('run_terminal_cmd', 'npm test')).toBe('medium');
    expect(riskOf('read_file', 'read')).toBe('low');
  });
  it('blacklist includes git push --force and fork bomb', () => {
    expect(DEFAULT_DENY_PATTERNS.some((p) => p.includes('--force'))).toBe(true);
    expect(DEFAULT_DENY_PATTERNS.some((p) => new RegExp(p, 'i').test(':(){ :|:& };:'))).toBe(true);
    expect(DEFAULT_DENY_PATTERNS.some((p) => new RegExp(p, 'i').test('rm -rf /'))).toBe(true);
  });
});
