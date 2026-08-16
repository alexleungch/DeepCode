import type { DeepcodeEngine } from '../engine.js';
import type { EngineEvent } from '../events.js';
import type { TelegramClient } from './client.js';
import { applyEvent, createBuffer, render, splitRemainder, type BufferState } from './buffer.js';
import { TrailingEdgeThrottle } from './throttle.js';

const EDIT_LIMIT = 4096;

interface BridgeOptions {
  chatId: number;
  /** editMessageText throttle interval (ms) */
  editIntervalMs: number;
  /** Editable bubble length cap while streaming (kept below Telegram's 4096) */
  maxBubbleChars: number;
}

/**
 * Streams one engine turn into a single Telegram bubble that grows in place via
 * throttled editMessageText. Sends the initial "思考中..." bubble, subscribes to
 * engine events, and finalizes with a guaranteed flush on completion.
 */
export class StreamingBridge {
  private state: BufferState;
  private readonly throttle: TrailingEdgeThrottle;
  private msgId = 0;
  private unsubscribe?: () => void;

  constructor(
    private readonly client: TelegramClient,
    private readonly opts: BridgeOptions,
  ) {
    this.state = createBuffer();
    this.throttle = new TrailingEdgeThrottle(opts.editIntervalMs, (text) =>
      this.client.editMessageText(opts.chatId, this.msgId, text),
    );
  }

  /** Send "思考中...", subscribe to engine events, and return the bubble's message id. */
  async start(engine: DeepcodeEngine): Promise<number> {
    const { messageId } = await this.client.sendMessage(this.opts.chatId, '思考中...');
    this.msgId = messageId;
    this.state = createBuffer();
    this.unsubscribe = engine.onEvent((e) => this.onEvent(e));
    return messageId;
  }

  private onEvent(event: EngineEvent): void {
    this.state = applyEvent(this.state, event);
    if (this.state.done) return; // finish() handles the final edit
    this.throttle.push(render(this.state, { maxChars: this.opts.maxBubbleChars }));
  }

  /**
   * Finalize the bubble: flush the trailing edit, then handle Telegram's 4096-char
   * limit by spilling overflow into follow-up "continued" messages.
   */
  async finish(): Promise<void> {
    const full = render(this.state, { maxChars: Infinity });
    await this.throttle.flush();
    if (full.length <= EDIT_LIMIT) {
      try {
        await this.client.editMessageText(this.opts.chatId, this.msgId, full);
      } catch {
        // final edit is best-effort; the streamed bubble already carried most content
      }
      return;
    }
    const preview = render(this.state, { maxChars: this.opts.maxBubbleChars });
    try {
      await this.client.editMessageText(this.opts.chatId, this.msgId, `${preview}\n…\n(续)`);
    } catch {
      // ignore
    }
    for (const chunk of splitRemainder(full.slice(preview.length), EDIT_LIMIT)) {
      await this.client.sendMessage(this.opts.chatId, chunk);
    }
  }

  stop(): void {
    this.throttle.dispose();
    this.unsubscribe?.();
  }
}
