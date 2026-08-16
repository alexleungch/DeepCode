const BASE_URL = 'https://api.telegram.org';

/** Typed Telegram Bot API error (carries the HTTP error code and optional retry_after). */
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id?: number;
  text?: string;
  from?: { id: number; is_bot?: boolean };
  chat: { id: number };
}

interface TelegramErrorBody {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const NOT_MODIFIED = /message is not modified/i;

/**
 * Minimal Telegram Bot API wrapper over global fetch (Node >= 20).
 * No parse_mode is used so message text needs no escaping.
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = BASE_URL,
  ) {}

  private async api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as T & TelegramErrorBody;
    if (!res.ok || json.ok === false) {
      const code = json.error_code ?? res.status;
      throw new TelegramError(code, json.description ?? `Telegram error ${res.status}`, json.parameters?.retry_after);
    }
    return json;
  }

  /** Send a new message; returns the created message id. */
  async sendMessage(chatId: number, text: string): Promise<{ messageId: number }> {
    const json = await this.api<{ ok: boolean; result?: { message_id?: number } }>('sendMessage', {
      chat_id: chatId,
      text,
    });
    return { messageId: json.result?.message_id ?? 0 };
  }

  /** Edit an existing message in place. Swallows the "message is not modified" 400. */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.api('editMessageText', { chat_id: chatId, message_id: messageId, text });
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && NOT_MODIFIED.test(e.message)) return;
      throw e;
    }
  }

  /** Long-poll getUpdates; caller is responsible for advancing `offset`. */
  async getUpdates(opts: { offset: number; timeout: number }): Promise<TelegramUpdate[]> {
    const json = await this.api<{ ok: boolean; result?: TelegramUpdate[] }>('getUpdates', {
      offset: opts.offset,
      timeout: opts.timeout,
      allowed_updates: ['message'],
    });
    return json.result ?? [];
  }
}
