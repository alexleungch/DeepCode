import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { SessionStore } from '../session/store.js';

export function sessionsCommand(): Command {
  const cmd = new Command('sessions');
  cmd.description('Session management');
  cmd
    .command('list')
    .description('List sessions')
    .action(() => {
      const { paths } = loadConfig();
      const store = new SessionStore(paths.sessionsDir);
      const list = store.list();
      if (list.length === 0) {
        process.stdout.write('(no sessions)\n');
        return;
      }
      for (const s of list.slice(0, 20)) {
        process.stdout.write(`${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.messageCount} messages  ${s.title}\n`);
      }
    });
  cmd
    .command('show <id>')
    .description('Show session messages')
    .action((id: string) => {
      const { paths } = loadConfig();
      const store = new SessionStore(paths.sessionsDir);
      const rec = store.load(id);
      if (!rec) {
        process.stdout.write(`Session not found: ${id}\n`);
        return;
      }
      process.stdout.write(`Session ${rec.id} (${rec.provider}/${rec.model}, ${rec.workspace})\n`);
      for (const m of rec.messages) {
        const text = typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
        process.stdout.write(`\n── ${m.role} ──\n${text.slice(0, 2000)}\n`);
      }
    });
  cmd
    .command('rm <id>')
    .description('Delete a session')
    .action((id: string) => {
      const { paths } = loadConfig();
      new SessionStore(paths.sessionsDir).remove(id);
      process.stdout.write(`Deleted session ${id}\n`);
    });
  return cmd;
}
