import { z } from 'zod';
import type { ToolDef, ToolContext, ToolResult } from '../types.js';
import type { Skill } from '../../skills/types.js';
import { skillsCatalog } from '../../skills/loader.js';

export const skillSchema = z.object({
  action: z.enum(['list', 'load']),
  name: z.string().optional(),
});

export interface SkillToolOptions {
  /** Skill loader (injected at engine assembly; includes plugin-embedded skills). */
  getSkills: () => Promise<Skill[]>;
  /** Skill catalog (appended to the system prompt). */
  catalog?: () => string;
}

/**
 * skill tool: DSH-style skill loading.
 * - list: list the skill catalog (name + description + size)
 * - load: load the full skill text (instructions injected into context)
 */
export function makeSkillTool(opts: SkillToolOptions): ToolDef {
  return {
    name: 'skill',
    description: 'List available skills (list) or load a skill\'s full instructions (load <name>). Load a matching skill before executing a task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'load'], description: 'list=view the skill catalog; load=load the full skill text' },
        name: { type: 'string', description: 'Skill name (required when loading)' },
      },
      required: ['action'],
    },
    permission: 'read',
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = skillSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `skill invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { action, name } = parsed.data;
      const skills = await opts.getSkills();
      if (action === 'list') {
        if (skills.length === 0) return { content: '(no skills available)' };
        return { content: `Available skills (${skills.length}):\n${skillsCatalog(skills)}` };
      }
      if (!name) return { content: 'skill load requires a name argument', isError: true };
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        return {
          content: `Skill ${name} not found. Available: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
          isError: true,
        };
      }
      return {
        content: `# Skill: ${skill.name}\n${skill.description}\n\n${skill.body}\n\n(skill dir: ${skill.dir}, ${skill.sizeTokens} tokens)`,
      };
    },
  };
}
