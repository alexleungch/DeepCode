import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';

const askUserSchema = z.object({
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
      // Use askApprovalBatch so an aborted dialog (x / ESC) is distinguishable from a plain
      // "no": the tool must never report "no answer" for a decision the user DID make.
      const { decisions, aborted } = await ctx.askApprovalBatch([
        {
          callId: 'ask-user',
          toolName: 'ask_user',
          description: `❓ ${question}${options?.length ? `\nOptions: ${options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}` : ''}`,
          risk: 'low',
        },
      ]);
      const [decision] = decisions;
      if (aborted || !decision) {
        return { content: 'User aborted the question', isError: true };
      }
      // In the dialog, [n] deny / [d] always deny answer the question negatively; allow
      // without feedback (the [y]/[a]/[A] keys) means the user approved → affirmative answer.
      if (decision.action === 'deny' || decision.action === 'deny-always') {
        return { content: 'User answer: no' };
      }
      const answer = decision.feedback?.trim();
      if (answer) return { content: `User answer: ${answer}` };
      return { content: 'User answer: yes' };
    },
  };
}
