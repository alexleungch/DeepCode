import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

export const askUserSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).max(9).optional(),
});

/**
 * ask_user: the agent asks the user a question (when clarification is needed).
 * Implemented through the approval channel: Ask mode shows a dialog; --print mode reads stdin.
 */
export function makeAskUserTool(): ToolDef {
  return {
    name: 'ask_user',
    description: 'Ask the user a question to clarify requirements. Options may be omitted (free-form answer). Use only when truly needed.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 9, description: 'Candidate options (optional)' },
      },
      required: ['question'],
    },
    permission: 'ask',
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = askUserSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `ask_user invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { question, options } = parsed.data;
      const [decision] = await ctx.askApproval([
        {
          callId: 'ask-user',
          toolName: 'ask_user',
          description: `❓ ${question}${options?.length ? `\nOptions: ${options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}` : ''}`,
          risk: 'low',
        },
      ]);
      if (!decision || decision.action === 'deny') {
        return { content: 'User did not answer the question', isError: true };
      }
      const answer = decision.feedback?.trim();
      if (!answer) return { content: 'User did not provide an answer', isError: true };
      return { content: `User answer: ${answer}` };
    },
  };
}
