import { loadConfig, resolveEnvValue } from '../config/loader.js';
import { DeepcodeEngine } from '../engine.js';
import { startMemoryWatchdog } from '../monitor/memory.js';
import type { TelegramConfig } from '../config/types.js';
import { TelegramClient } from './client.js';
import { StreamingBridge } from './bridge.js';
import { classifyMessage, isAllowed } from './routing.js';

const HELP_TEXT = `DeepCode 桥接机器人 🤖

向你的编程代理发送指令，回复会在此消息中实时增长。

命令：
  /start /help — 本帮助
  /new         — 清空会话，开启新对话
  /status      — 会话 / 上下文 / token 用量

其他任意文本都会作为指令发送给代理。`;

/** Active turn holder so SIGINT can interrupt an in-flight request. */
let active: { bridge: StreamingBridge } | undefined;

/** Run the Telegram bridge until the process is terminated. */
export async function runTelegram(): Promise<void> {
  const cfg = loadConfig().config.telegram as TelegramConfig | undefined;

  const token = process.env.TELEGRAM_BOT_TOKEN ?? resolveEnvValue(cfg?.botToken);
  if (!token) {
    console.error(
      'Missing Telegram bot token.\n  Set TELEGRAM_BOT_TOKEN, or telegram.botToken in ~/.deepcode/config.json (supports "env:VAR").',
    );
    process.exit(1);
  }

  const allowChatIds = cfg?.allowChatIds ?? [];
  if (!allowChatIds.length) {
    console.error('No allowlisted chats. Set telegram.allowChatIds in config (get your id from @userinfobot).');
    process.exit(1);
  }
  const primaryChat = allowChatIds[0]!;

  const editIntervalMs = cfg?.editIntervalMs ?? 1500;
  const maxBubbleChars = cfg?.maxBubbleChars ?? 3500;
  const longPollTimeoutSec = cfg?.longPollTimeoutSec ?? 25;

  const resolved = loadConfig({ workspace: cfg?.workspace });
  const engine = new DeepcodeEngine({
    resolved,
    permissionMode: cfg?.permissionMode ?? 'acceptEdits',
    title: 'telegram bridge',
  });
  await engine.init();

  // Daemon: sample memory into <data dir>/logs/memory.log and warn before a heap OOM abort.
  // The bin shim additionally restarts the bridge on crash (see bin/deepcode.cjs).
  startMemoryWatchdog({ logDir: resolved.paths.logsDir });

  const client = new TelegramClient(token);
  let running = true;
  let offset = 0;

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    running = false;
    if (active) {
      engine.interrupt();
      try {
        await active.bridge.finish();
      } catch {
        // ignore
      }
    }
    try {
      await engine.finalizeMemory();
    } catch {
      // ignore
    }
    engine.close();
    try {
      await client.sendMessage(primaryChat, `👋 桥接已关闭 (${reason})`);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(`[telegram] bridge running · ${engine.workspace}`);
  console.log(`[telegram] allowlisted chats: ${allowChatIds.join(', ')}`);
  console.log(`[telegram] edit throttle ${editIntervalMs}ms · bubble cap ${maxBubbleChars} chars`);

  while (running) {
    try {
      const updates = await client.getUpdates({ offset, timeout: longPollTimeoutSec });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u.message, { allowChatIds, editIntervalMs, maxBubbleChars, client, engine });
      }
    } catch (e) {
      if (!running) break;
      console.error(`[telegram] poll error: ${e instanceof Error ? e.message : String(e)}`);
      await delay(1000);
    }
  }
}

interface HandleCtx {
  allowChatIds: number[];
  editIntervalMs: number;
  maxBubbleChars: number;
  client: TelegramClient;
  engine: DeepcodeEngine;
}

async function handleUpdate(
  msg: { chat: { id: number }; text?: string; from?: { id: number; is_bot?: boolean } } | undefined,
  ctx: HandleCtx,
): Promise<void> {
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  if (msg.from?.is_bot) return; // ignore other bots to avoid loops
  if (!isAllowed(chatId, ctx.allowChatIds)) return;

  if (active) {
    await ctx.client.sendMessage(chatId, '⏳ 处理中，请稍候');
    return;
  }

  const cmd = classifyMessage(msg.text);
  switch (cmd.kind) {
    case 'help':
      await ctx.client.sendMessage(chatId, HELP_TEXT);
      return;
    case 'new':
      ctx.engine.session.messages = [];
      await ctx.client.sendMessage(chatId, '已开始新会话 ✨');
      return;
    case 'status':
      await ctx.client.sendMessage(chatId, statusLine(ctx.engine));
      return;
    case 'instruction':
      await startTurn(chatId, cmd.text, ctx);
      return;
  }
}

async function startTurn(chatId: number, text: string, ctx: HandleCtx): Promise<void> {
  const bridge = new StreamingBridge(ctx.client, { chatId, editIntervalMs: ctx.editIntervalMs, maxBubbleChars: ctx.maxBubbleChars });
  await bridge.start(ctx.engine);
  active = { bridge };
  try {
    await ctx.engine.runTurn(text);
    await bridge.finish();
  } catch (e) {
    try {
      await bridge.finish();
    } catch {
      // ignore
    }
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await ctx.client.sendMessage(chatId, `— 失败: ${msg}`);
    } catch {
      // ignore
    }
  } finally {
    bridge.stop();
    active = undefined;
  }
}

function statusLine(engine: DeepcodeEngine): string {
  const messages = engine.session.messages.length;
  const ratio = Math.round(engine.contextRatio() * 100);
  const usage = engine.usage.totalsSnapshot();
  return `📊 会话状态\n· 消息数: ${messages}\n· 上下文: ${ratio}%\n· tokens: ${usage.totalTokens ?? 0}\n· 花费: $${usage.costUsd.toFixed(4)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
