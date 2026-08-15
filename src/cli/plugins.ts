import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { PluginLoader } from '../plugins/loader.js';

export function pluginsCommand(): Command {
  const cmd = new Command('plugins');
  cmd.description('Plugin management (ESM plugins: tools/skills/mcpServers/hooks)');
  cmd
    .command('list')
    .description('List loaded plugins')
    .action(async () => {
      const { paths, config } = loadConfig();
      const loader = new PluginLoader(paths.userPluginsDir, config.plugins);
      const plugins = await loader.loadAll();
      if (plugins.length === 0) {
        process.stdout.write('(no plugins; example: ~/.deepcode/plugins/<name>/plugin.js)\n');
        return;
      }
      for (const p of plugins) {
        process.stdout.write(`- ${p.name} (${p.id})  tools: ${p.tools.length}  skills: ${p.skills.length}  mcp: ${Object.keys(p.mcpServers).length}\n`);
      }
    });
  return cmd;
}
