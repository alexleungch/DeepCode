import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { DeepcodeConfig } from '../src/config/types.js';
import type { ToolSchema } from '../src/providers/types.js';

const tools: ToolSchema[] = [
  { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } },
  { name: 'bash', description: 'run a command', inputSchema: { type: 'object' } },
];

function promptFor(config: Partial<DeepcodeConfig['prompt']>, overrides: Partial<DeepcodeConfig> = {}): string {
  const cfg = defaultConfig();
  cfg.prompt = { ...cfg.prompt, ...config };
  return buildSystemPrompt({
    config: { ...cfg, ...overrides },
    workspace: '/ws',
    model: 'deepseek-chat',
    providerLabel: 'deepseek',
    tools,
  });
}

describe('buildSystemPrompt prompt-optimization sections', () => {
  it('is cache-prefix stable: identical input produces byte-identical output', () => {
    const a = promptFor({});
    const b = promptFor({});
    expect(a).toBe(b);
  });

  it('outputStyle concise renders the compactness line and is shorter than detailed', () => {
    const concise = promptFor({ outputStyle: 'concise' });
    const detailed = promptFor({ outputStyle: 'detailed' });
    expect(concise).toContain('Be concise');
    expect(detailed).toContain('Be thorough');
    expect(concise.length).toBeLessThan(detailed.length);
  });

  it('maxResponseChars injects the response cap line only when set', () => {
    expect(promptFor({ maxResponseChars: 0 })).not.toContain('characters');
    expect(promptFor({ maxResponseChars: 800 })).toContain('under 800 characters');
  });

  it('completion protocol section is present by default and absent when disabled', () => {
    expect(promptFor({ completionProtocol: true })).toContain('# Completion protocol');
    expect(promptFor({ completionProtocol: true })).toContain('# Blocked');
    expect(promptFor({ completionProtocol: false })).not.toContain('# Completion protocol');
  });

  it('verify-on-done contract is present by default and absent when disabled', () => {
    expect(promptFor({ verifyOnDone: true })).toContain('# Verification');
    expect(promptFor({ verifyOnDone: true })).toContain('browser_review');
    expect(promptFor({ verifyOnDone: false })).not.toContain('# Verification');
  });

  it('few-shot examples are injected only when configured (zero token cost by default)', () => {
    expect(promptFor({ examples: [] })).not.toContain('# Examples');
    const withEx = promptFor({ examples: ['Task: fix lint\nConstraints: keep API stable\nOutput: diff summary'] });
    expect(withEx).toContain('# Examples');
    expect(withEx).toContain('## Example 1');
    expect(withEx).toContain('keep API stable');
  });

  it('priority declaration exists and section order is stable', () => {
    const p = promptFor({});
    expect(p).toContain('LATER sections override EARLIER');
    // order: Role < Environment < ... < Output contract < Completion protocol < Safety rules
    expect(p.indexOf('# Role')).toBeLessThan(p.indexOf('# Output contract'));
    expect(p.indexOf('# Output contract')).toBeLessThan(p.indexOf('# Completion protocol'));
    expect(p.indexOf('# Completion protocol')).toBeLessThan(p.indexOf('# Safety rules'));
  });

  it('plan mode section still works alongside the new sections', () => {
    const p = promptFor({}, { permissions: { ...defaultConfig().permissions, mode: 'plan' } });
    expect(p).toContain('# Plan mode (active)');
    expect(p).toContain('# Completion protocol');
  });
});
