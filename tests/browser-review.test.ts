import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { makeBrowserReviewTool } from '../src/tools/native/browser/review.js';
import { normalizeUrl } from '../src/tools/native/browser/controller.js';
import type { BrowserSession, ReviewCapture } from '../src/tools/native/browser/controller.js';
import type { ToolContext } from '../src/tools/types.js';
import { defaultConfig } from '../src/config/defaults.js';
import { runAgentTurn } from '../src/agent/loop.js';
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamEvent } from '../src/providers/types.js';

let dir: string;
let server: Server;
let fixtureUrl = '';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'browser-'));
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Test page</title></head>
      <body><h1>Hello deepcode</h1><p>fixture content</p>
      <script>console.error('mock console error');</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    fixtureUrl = `http://127.0.0.1:${addr.port}/`;
    resolve();
  }));
});

afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx: ToolContext = {
  cwd: dir,
  workspace: dir,
  sessionId: 's1',
  config: defaultConfig(),
  permissionMode: 'ask',
  askApproval: async () => [],
  emit: () => undefined,
  signal: new AbortController().signal,
};

describe('normalizeUrl', () => {
  it('completes the protocol and localhost', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeUrl('example.com/path')).toBe('http://example.com/path');
  });
});

describe('browser_review unit (mock session)', () => {
  it('argument validation', async () => {
    const tool = makeBrowserReviewTool({ workspace: dir, screenshotsDir: dir, allowScreenshots: false });
    const r = await tool.execute({ url: '' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('invalid arguments');
  });

  it('playwright mode: structured result + screenshot artifact + vision-injected image', async () => {
    const fakeCapture: ReviewCapture = {
      mode: 'playwright',
      status: 200,
      title: 'Test page',
      finalUrl: fixtureUrl,
      consoleErrors: ['mock console error'],
      pageErrors: [],
      snapshot: 'heading "Hello deepcode"',
      screenshotBase64: 'c2NyZWVuc2hvdA==', // "screenshot"
      screenshotPath: join(dir, 'shot.png'),
    };
    const fakeSession: BrowserSession = {
      review: async () => fakeCapture,
      close: async () => undefined,
    };
    const tool = makeBrowserReviewTool({
      workspace: dir,
      screenshotsDir: dir,
      sessionFactory: async () => fakeSession,
    });
    const r = await tool.execute({ url: fixtureUrl }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Test page');
    expect(r.content).toContain('mock console error');
    expect(r.content).toContain('Hello deepcode');
    expect(r.images?.[0]).toEqual({ mediaType: 'image/png', base64: 'c2NyZWVuc2hvdA==' });
    expect(r.artifacts?.[0]?.path).toContain('.png');
  });

  it('degraded mode: native open + fetch text snapshot', async () => {
    const tool = makeBrowserReviewTool({
      workspace: dir,
      screenshotsDir: dir,
      allowScreenshots: false,
      sessionFactory: async () => null, // no playwright
    });
    const r = await tool.execute({ url: fixtureUrl }, ctx);
    expect(r.content).toContain('degraded mode');
    expect(r.content).toContain('Hello deepcode');
    expect(r.images).toBeUndefined();
  });
});

/** Vision injection end-to-end: the fake provider re-emits the image on the second turn */
describe('browser_review vision injection (loop level)', () => {
  it('supportsVision models receive the screenshot image message', async () => {
    // fake provider: first turn emits browser_review tool_use; second turn checks for the image block
    let sawImage = false;
    const fakeProvider: LLMProvider = {
      id: 'deepseek',
      model: 'deepseek-chat',
      modelMeta: { id: 'deepseek-chat', windowTokens: 128_000, supportsVision: true, supportsTools: true, cacheControl: 'auto' },
      async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const hasToolResult = req.messages.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
        if (!hasToolResult) {
          yield {
            type: 'done',
            response: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'check rendering' },
                  { type: 'tool_use', id: 'b1', name: 'browser_review', input: { url: 'http://x', screenshot: true } },
                ],
              },
              usage: { inputTokens: 10, outputTokens: 5 },
              stopReason: 'tool_use',
            },
          };
          return;
        }
        // second turn: assert the message contains an image block
        const imageMsg = req.messages.find((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'image'));
        sawImage = !!imageMsg;
        yield {
          type: 'done',
          response: {
            message: { role: 'assistant', content: [{ type: 'text', text: 'rendering ok' }] },
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'end_turn',
          },
        };
      },
      async complete() {
        throw new Error('not used');
      },
    };

    // register a browser_review stub tool with a screenshot result
    const { ToolRegistry } = await import('../src/tools/registry.js');
    const { ToolExecutor } = await import('../src/tools/executor.js');
    const { PermissionGate } = await import('../src/tools/permission.js');
    const { UsageTracker } = await import('../src/usage/extractor.js');
    const { SessionStore } = await import('../src/session/store.js');
    const { TodoStore } = await import('../src/tools/native/todo.js');

    const registry = new ToolRegistry();
    registry.register({
      name: 'browser_review',
      description: 'check rendering',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, screenshot: { type: 'boolean' } } },
      permission: 'execute',
      execute: async () => ({
        content: 'screenshot taken',
        images: [{ mediaType: 'image/png', base64: 'ZmFrZQ==' }],
      }),
    });
    const sessionStore = new SessionStore(join(dir, 'sessions'));
    const session = sessionStore.create({ workspace: dir, provider: 'deepseek', model: 'deepseek-chat', title: 't' });
    const usage = new UsageTracker();
    const config = defaultConfig();
    config.permissions.mode = 'acceptEdits';

    const result = await runAgentTurn(
      {
        config,
        provider: fakeProvider,
        modelMeta: fakeProvider.modelMeta,
        registry,
        executor: new ToolExecutor(registry),
        gate: new PermissionGate(config, dir),
        usage,
        session,
        sessionStore,
        todoStore: new TodoStore(),
        emit: () => undefined,
        systemPrompt: 'sys',
        approvalHandler: async (items) => ({ decisions: items.map((i) => ({ callId: i.callId, action: 'allow' })), aborted: false }),
        signal: new AbortController().signal,
      },
      'check the page rendering',
    );
    expect(result.stopReason).toBe('end_turn');
    expect(sawImage).toBe(true);
    // the session should contain one observation message with an image block
    const obs = result.messages.filter((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'image'));
    expect(obs.length).toBe(1);
  });
});
