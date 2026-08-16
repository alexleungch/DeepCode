import { Command } from 'commander';
import { runTelegram } from '../telegram/run.js';

export function telegramCommand(): Command {
  const cmd = new Command('telegram');
  cmd.description('Run the Telegram bridge (long-lived bot)');
  cmd.action(async () => {
    try {
      await runTelegram();
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  });
  return cmd;
}
