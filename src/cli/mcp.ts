import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function mcpCommand(): Command {
  const cmd = new Command('mcp');
  cmd.description('MCP server management (Model Context Protocol)');
  cmd
    .command('list')
    .description('List configured servers')
    .action(() => {
      const { config, paths } = loadConfig();
      const servers = Object.entries(config.mcpServers);
      if (servers.length === 0) {
        process.stdout.write('(none configured; example: deepcode mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .)\n');
        return;
      }
      for (const [name, s] of servers) {
        process.stdout.write(`- ${name}: ${s.command ? `stdio ${s.command} ${(s.args ?? []).join(' ')}` : `http ${s.url}`}\n`);
      }
      void paths;
    });
  cmd
    .command('add <name> [command...]')
    .description('Add a stdio server: deepcode mcp add <name> -- <command> [args...]')
    .option('-u, --url <url>', 'HTTP/SSE server URL')
    .action((name: string, command: string[], opts: { url?: string }) => {
      const { config, paths } = loadConfig();
      const file = join(paths.dataDir, 'mcp.json');
      let servers: Record<string, unknown> = {};
      if (existsSync(file)) servers = JSON.parse(readFileSync(file, 'utf8'));
      if (opts.url) {
        servers[name] = { url: opts.url };
      } else if (command.length > 0) {
        servers[name] = { command: command[0], args: command.slice(1) };
      } else {
        process.stdout.write('Usage: deepcode mcp add <name> -- <command> [args...] or --url <url>\n');
        return;
      }
      writeFileSync(file, JSON.stringify(servers, null, 2), 'utf8');
      process.stdout.write(`Added MCP server ${name} (${file})\n`);
      void config;
    });
  cmd
    .command('remove <name>')
    .description('Remove a server')
    .action((name: string) => {
      const { paths } = loadConfig();
      const file = join(paths.dataDir, 'mcp.json');
      if (!existsSync(file)) {
        process.stdout.write('No servers configured\n');
        return;
      }
      const servers = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (!(name in servers)) {
        process.stdout.write(`Server ${name} not found\n`);
        return;
      }
      delete servers[name];
      writeFileSync(file, JSON.stringify(servers, null, 2), 'utf8');
      process.stdout.write(`Removed ${name}\n`);
    });
  return cmd;
}
