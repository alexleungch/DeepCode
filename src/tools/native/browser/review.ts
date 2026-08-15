import { z } from 'zod';
import { join, resolve, isAbsolute } from 'node:path';
import type { ToolDef, ToolContext, ToolResult } from '../../types.js';
import {
  normalizeUrl,
  openInDefaultBrowser,
  createPlaywrightSession,
  type BrowserSession,
  type ReviewCapture,
} from './controller.js';

export const browserReviewSchema = z.object({
  url: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  fullPage: z.boolean().optional(),
  screenshot: z.boolean().optional(),
});

export interface BrowserReviewToolOptions {
  workspace: string;
  screenshotsDir: string;
  /** Test injection; by default auto-detects playwright + the system browser. */
  sessionFactory?: () => Promise<BrowserSession | null>;
  /** Screenshot toggle (can be disabled in tests/headless environments). */
  allowScreenshots?: boolean;
}

/**
 * browser_review: automatically open a browser to check UI rendering.
 * playwright mode: wait until ready → capture HTTP status/title/console and page errors/aria snapshot/screenshot (viewport or full page).
 * degraded mode: open with the system default browser + fetch the page text.
 * Screenshots are returned via ToolResult.images for vision models in the next request.
 */
export function makeBrowserReviewTool(opts: BrowserReviewToolOptions): ToolDef {
  return {
    name: 'browser_review',
    description:
      'Automatically open a browser to check UI rendering: visit the URL, wait until the page is ready, and capture the HTTP status, title, console errors, page errors, accessibility snapshot, and a screenshot.' +
      'Use it in the frontend dev loop: start the dev server, then verify the rendered output. Screenshots are provided to vision-capable models.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to check (e.g. http://localhost:5173; the protocol may be omitted)' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Navigation timeout (default 15000)' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Wait strategy (default load)' },
        viewport: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, description: 'Viewport size (default 1280x800)' },
        fullPage: { type: 'boolean', description: 'Full-page screenshot (default false)' },
        screenshot: { type: 'boolean', description: 'Whether to take a screenshot (default true)' },
      },
      required: ['url'],
    },
    permission: 'execute',
    async preview(input: unknown): Promise<{ description: string; path?: string }> {
      const parsed = browserReviewSchema.safeParse(input);
      if (!parsed.success) {
        return { description: `browser_review (invalid arguments: ${parsed.error.issues[0]?.message ?? ''})` };
      }
      return { description: `Open browser to check ${normalizeUrl(parsed.data.url)}` };
    },
    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = browserReviewSchema.safeParse(input);
      if (!parsed.success) {
        return { content: `browser_review invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
      }
      const { url, timeoutMs = 15_000, waitUntil = 'load', viewport, fullPage = false, screenshot = true } = parsed.data;
      const target = normalizeUrl(url);
      const allowShots = opts.allowScreenshots ?? true;
      const shotPath = allowShots
        ? join(opts.screenshotsDir, `${ctx.sessionId}-${Date.now()}.png`)
        : undefined;

      // Prefer playwright mode
      const session = opts.sessionFactory ? await opts.sessionFactory() : await createPlaywrightSession();
      if (session) {
        try {
          const capture = await session.review({
            url: target,
            timeoutMs,
            waitUntil,
            viewport,
            fullPage,
            screenshot: screenshot && allowShots,
            screenshotPath: shotPath,
          });
          return formatPlaywrightResult(capture, shotPath);
        } catch (e) {
          return {
            content: `browser_review failed: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
          };
        } finally {
          await session.close();
        }
      }

      // degraded mode: native open + fetch text
      return nativeFallback(target, timeoutMs, shotPath);
    },
  };
}

function formatPlaywrightResult(c: ReviewCapture, shotPath?: string): ToolResult {
  const lines: string[] = [];
  lines.push(`🌐 ${c.finalUrl}`);
  lines.push(`Status: ${c.status} · Title: ${c.title || '(none)'}`);
  if (c.pageErrors.length > 0) {
    lines.push(`⚠️ Page errors (${c.pageErrors.length}):\n${c.pageErrors.map((e) => `  - ${e}`).join('\n')}`);
  }
  if (c.consoleErrors.length > 0) {
    lines.push(`⚠️ Console errors (${c.consoleErrors.length}):\n${c.consoleErrors.map((e) => `  - ${e.slice(0, 300)}`).join('\n')}`);
  }
  if (c.mode === 'playwright' && (c.pageErrors.length === 0) && (c.consoleErrors.length === 0)) {
    lines.push('✅ Page loaded with no JS errors');
  }
  lines.push(`Page snapshot:\n${c.snapshot.slice(0, 4000) || '(empty)'}`);
  if (shotPath) lines.push(`📷 Screenshot: ${shotPath}`);
  const result: ToolResult = {
    content: lines.join('\n'),
    artifacts: shotPath ? [{ path: shotPath }] : undefined,
  };
  if (c.screenshotBase64) {
    result.images = [{ mediaType: 'image/png', base64: c.screenshotBase64 }];
  }
  return result;
}

async function nativeFallback(target: string, timeoutMs: number, shotPath?: string): Promise<ToolResult> {
  const opened = openInDefaultBrowser(target);
  // fetch text snapshot
  let text = '';
  let status = 0;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    const raw = await res.text();
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
  } catch (e) {
    text = `(fetch failed: ${e instanceof Error ? e.message : String(e)})`;
  }
  const lines = [
    `🌐 ${target} (degraded mode: opened with the system browser, no rendering details)`,
    opened,
    `HTTP status: ${status || 'unknown'}`,
    `Text snapshot:\n${text || '(empty)'}`,
  ];
  if (shotPath) lines.push(`(degraded mode: no screenshot; path=${shotPath})`);
  return { content: lines.join('\n'), isError: status >= 400 };
}
