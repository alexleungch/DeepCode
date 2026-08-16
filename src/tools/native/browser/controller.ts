import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Browser controller: prefers playwright-core driving the system browser (real rendering checks);
 * when no browser is available, falls back to opening the system default browser + a fetch text snapshot.
 */
export interface BrowserSession {
  /** Open the page and capture rendering information. */
  review(input: ReviewPageInput): Promise<ReviewCapture>;
  close(): Promise<void>;
}

interface ReviewPageInput {
  url: string;
  timeoutMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  viewport?: { width: number; height: number };
  fullPage: boolean;
  screenshot: boolean;
  screenshotPath?: string;
}

export interface ReviewCapture {
  mode: 'playwright' | 'native-open';
  status: number;
  title: string;
  finalUrl: string;
  consoleErrors: string[];
  pageErrors: string[];
  /** Accessibility/DOM text snapshot. */
  snapshot: string;
  /** Screenshot (PNG base64; only in playwright mode when a screenshot exists). */
  screenshotBase64?: string;
  screenshotPath?: string;
}

/** Normalize URL: fill in the protocol and localhost. */
export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) {
    if (/^\d+$/.test(url)) url = `http://localhost:${url}`;
    else if (/^localhost(:\d+)?(\/.*)?$/.test(url)) url = `http://${url}`;
    else url = `http://${url}`;
  }
  return url;
}

const SYSTEM_BROWSER_PATHS = [
  // Windows
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

async function findPlaywrightBrowser(): Promise<{ channel?: string; executablePath?: string } | null> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    const pw = (await import('playwright-core')) as typeof import('playwright-core');
    chromium = pw.chromium;
  } catch {
    return null;
  }
  // Try by priority: msedge → chrome → common executable paths
  for (const channel of ['msedge', 'chrome'] as const) {
    try {
      const b = await chromium.launch({ channel });
      await b.close();
      return { channel };
    } catch {
      // Keep trying
    }
  }
  for (const p of SYSTEM_BROWSER_PATHS) {
    if (existsSync(p)) return { executablePath: p };
  }
  return null;
}

/** Create a browser session (playwright mode); returns null on failure (caller falls back). */
export async function createPlaywrightSession(): Promise<BrowserSession | null> {
  const found = await findPlaywrightBrowser();
  if (!found) return null;
  const pw = (await import('playwright-core')) as typeof import('playwright-core');
  const browser = await pw.chromium.launch(found);
  return {
    async review(input: ReviewPageInput): Promise<ReviewCapture> {
      const context = await browser.newContext({
        viewport: input.viewport ?? { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => pageErrors.push(String(err)));

      let status = 0;
      let finalUrl = input.url;
      let title = '';
      let snapshot = '';
      let screenshotBase64: string | undefined;
      try {
        const response = await page.goto(input.url, {
          waitUntil: input.waitUntil,
          timeout: input.timeoutMs,
        });
        status = response?.status() ?? 0;
        finalUrl = page.url();
        title = await page.title().catch(() => '');
        snapshot = await captureSnapshot(page);
        if (input.screenshot) {
          const buf = await page.screenshot({
            fullPage: input.fullPage,
            type: 'png',
          });
          screenshotBase64 = buf.toString('base64');
          if (input.screenshotPath) {
            const { writeFileSync, mkdirSync } = await import('node:fs');
            mkdirSync(input.screenshotPath.split(/[\\/]/).slice(0, -1).join('/'), { recursive: true });
            writeFileSync(input.screenshotPath, buf);
          }
        }
      } catch (e) {
        pageErrors.push(`Navigation failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await context.close();
      }
      return {
        mode: 'playwright',
        status,
        title,
        finalUrl,
        consoleErrors: consoleErrors.slice(0, 20),
        pageErrors: pageErrors.slice(0, 20),
        snapshot,
        screenshotBase64,
        screenshotPath: input.screenshotPath,
      };
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
  };
}

async function captureSnapshot(page: import('playwright-core').Page): Promise<string> {
  // Prefer the aria snapshot (accessibility tree, understandable by text models); fall back to innerText
  try {
    const snapshot = await page.locator('body').ariaSnapshot();
    if (snapshot && snapshot.length > 0) return snapshot.slice(0, 8000);
  } catch {
    // Version does not support ariaSnapshot
  }
  try {
    const text = await page.evaluate(() => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? '');
    return String(text).slice(0, 8000);
  } catch {
    return '';
  }
}

/** Open the browser natively (degraded mode). */
export function openInDefaultBrowser(url: string): string {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return `Opened ${url} in the default browser`;
  } catch (e) {
    return `Failed to open the browser: ${e instanceof Error ? e.message : String(e)}`;
  }
}
