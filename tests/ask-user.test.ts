import { describe, it, expect } from 'vitest';
import { makeAskUserTool } from '../src/tools/native/ask-user.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { ToolContext } from '../src/tools/types.js';
import type { ApprovalResult } from '../src/tools/permission.js';

/** Build a ToolContext whose approval channel returns a fixed batch result. */
function ctxWith(result: ApprovalResult): ToolContext {
  return {
    cwd: process.cwd(),
    workspace: process.cwd(),
    sessionId: 's',
    config: defaultConfig(),
    permissionMode: 'ask',
    askApproval: async () => result.decisions,
    askApprovalBatch: async () => result,
    emit: () => undefined,
    signal: new AbortController().signal,
  };
}

describe('ask_user', () => {
  it('returns the chosen option as the answer (1-9 quick selection)', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute(
      { question: 'Approve this plan?', options: ['同意', '需要修改'] },
      ctxWith({
        decisions: [{ callId: 'ask-user', action: 'allow', feedback: '同意' }],
        aborted: false,
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('User answer: 同意');
  });

  it('maps allow-without-feedback (the y key) to an affirmative answer, not "no answer"', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute(
      { question: 'Approve this plan?' },
      ctxWith({
        decisions: [{ callId: 'ask-user', action: 'allow' }],
        aborted: false,
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('User answer: yes');
  });

  it('maps deny (the n key) to a negative answer', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute(
      { question: 'Approve this plan?' },
      ctxWith({
        decisions: [{ callId: 'ask-user', action: 'deny' }],
        aborted: false,
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('User answer: no');
  });

  it('reports an abort (x / ESC) as aborted, not as a deny', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute(
      { question: 'Approve this plan?' },
      ctxWith({ decisions: [], aborted: true }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe('User aborted the question');
  });

  it('returns custom text typed via the e key', async () => {
    const tool = makeAskUserTool();
    const result = await tool.execute(
      { question: 'What color?' },
      ctxWith({
        decisions: [{ callId: 'ask-user', action: 'allow', feedback: '  blue  ' }],
        aborted: false,
      }),
    );
    expect(result.content).toBe('User answer: blue');
  });
});
