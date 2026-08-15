import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { MemoryDb } from '../memory/db.js';
import { MemoryPipeline } from '../memory/pipeline.js';
import { SessionStore } from '../session/store.js';

export function memoryCommand(): Command {
  const cmd = new Command('memory');
  cmd.description('Agent Memory management (four-layer memory: session/working/long-term/project knowledge)');

  cmd
    .command('status')
    .description('Memory database status')
    .action(() => {
      const { paths, config } = loadConfig();
      const db = new MemoryDb(paths.memoryDbPath, paths.dataDir);
      process.stdout.write(`Memory database: ${paths.memoryDbPath}\n`);
      process.stdout.write(`Status: ${config.memory.enabled ? 'enabled' : 'disabled'} (auto-extract ${config.memory.autoExtract ? 'on' : 'off'}, inject top-${config.memory.injectTopK})\n`);
      process.stdout.write(`Memory entries: ${db.count()}\n`);
      db.close();
    });

  cmd
    .command('list')
    .description('List memories')
    .option('--type <type>', 'Filter type: fact|preference|experience|episode')
    .option('--limit <n>', 'Max entries', '50')
    .action((opts: { type?: string; limit: string }) => {
      const { paths } = loadConfig();
      const db = new MemoryDb(paths.memoryDbPath, paths.dataDir);
      const entries = db.list({
        type: opts.type as never,
        limit: Number(opts.limit) || 50,
      });
      if (entries.length === 0) {
        process.stdout.write('(no memories)\n');
      } else {
        for (const e of entries) {
          process.stdout.write(`#${e.id} [${e.type}/${e.scope}] ★${e.importance.toFixed(1)} accessed ${e.accessCount}x ${e.summary}\n`);
        }
      }
      db.close();
    });

  cmd
    .command('search <query>')
    .description('Search memories')
    .option('--limit <n>', 'Max entries', '5')
    .action((query: string, opts: { limit: string }) => {
      const { paths } = loadConfig();
      const db = new MemoryDb(paths.memoryDbPath, paths.dataDir);
      const entries = db.search(query, { limit: Number(opts.limit) || 5 });
      if (entries.length === 0) {
        process.stdout.write(`No relevant memories: ${query}\n`);
      } else {
        for (const e of entries) {
          process.stdout.write(`#${e.id} [${e.type}/${e.scope}] ${e.summary} (relevance ${(e.score ?? 0).toFixed(2)})\n`);
        }
      }
      db.close();
    });

  cmd
    .command('forget <id>')
    .description('Delete a memory')
    .action((id: string) => {
      const { paths } = loadConfig();
      const db = new MemoryDb(paths.memoryDbPath, paths.dataDir);
      const ok = db.remove(Number(id));
      process.stdout.write(ok ? `Deleted memory #${id}\n` : `Memory #${id} not found\n`);
      db.close();
    });

  cmd
    .command('extract')
    .description('Immediately extract memories from the most recent session (manual trigger)')
    .action(() => {
      const { paths } = loadConfig();
      const store = new SessionStore(paths.sessionsDir);
      const recent = store.list()[0];
      if (!recent) {
        process.stdout.write('(no session to extract from)\n');
        return;
      }
      const rec = store.load(recent.id);
      if (!rec) {
        process.stdout.write('(failed to load session)\n');
        return;
      }
      const db = new MemoryDb(paths.memoryDbPath, paths.dataDir);
      const pipeline = new MemoryPipeline(db, rec.workspace);
      const extracted = pipeline.extractFromSession(rec.messages);
      if (extracted.length === 0) {
        process.stdout.write('(no new memories to extract)\n');
      } else {
        for (const e of extracted) {
          process.stdout.write(`✓ [${e.type}] ${e.content}\n`);
        }
      }
      db.close();
    });

  return cmd;
}
