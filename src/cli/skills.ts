import { Command } from 'commander';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { SkillLoader } from '../skills/loader.js';

export function skillsCommand(): Command {
  const cmd = new Command('skills');
  cmd.description('Skill management (SKILL.md instruction packs)');
  cmd
    .command('list')
    .description('List available skills')
    .action(async () => {
      const { paths, config, workspace } = loadConfig();
      const loader = new SkillLoader(paths.userSkillsDir, config.skills, [join(workspace, 'skills')]);
      const skills = await loader.loadAll(paths.projectDir);
      if (skills.length === 0) {
        process.stdout.write('(no skills; example: project .deepcode/skills/<name>/SKILL.md or ~/.deepcode/skills/<name>/SKILL.md)\n');
        return;
      }
      for (const s of skills) {
        process.stdout.write(`- ${s.name} [${s.scope}] ${s.description} (${s.sizeTokens} tokens)\n`);
      }
    });
  return cmd;
}
