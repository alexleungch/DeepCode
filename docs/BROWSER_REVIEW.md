# browser_review — browser rendering review

Automatically opens a browser to check UI rendering — the core tool of the frontend development loop:

```
start dev server → browser_review → model inspects screenshot/errors and self-corrects → re-check
```

## Work Modes

### Playwright mode (preferred)

- `playwright-core` (no browser download) drives the **system browser**: Windows prefers Edge (`channel: 'msedge'`) → Chrome; macOS/Linux probes common paths
- Collects:
  - HTTP status code and final URL
  - Page title
  - **console errors and pageerrors** (JS exceptions = the core signal for rendering checks)
  - `ariaSnapshot` accessibility tree (plain-text models can understand the page structure too)
  - Screenshot (viewport/full-page, PNG written to `<project>/.deepcode/review-screenshots/`)
- Closes the browser context when done and returns a structured Observation

### Fallback mode (no system browser)

Opens the URL in the system default browser + port polling + `fetch` to grab a page text snapshot (marked "no rendering details").

## Vision injection

- Models with `supportsVision=true` (Claude/Gemini/Grok vision models, overridable via `modelMeta`) → screenshots injected as image blocks into the **next request**; the model inspects the image directly to check rendering
- Plain-text models (deepseek-chat etc.) → only title/status/console errors/aria snapshot are injected; the screenshot path is provided as an artifact for the user to view

## Parameters

| Parameter | Default | Description |
|---|---|---|
| url | required | Protocol optional (`localhost:5173` / `5173` auto-completed) |
| timeoutMs | 15000 | Navigation timeout |
| waitUntil | load | load / domcontentloaded / networkidle |
| viewport | 1280×800 | Viewport size |
| fullPage | false | Full-page screenshot |
| screenshot | true | Whether to take a screenshot |

## Permissions

Classified as `execute` (spawns processes + network); Ask mode shows an approval prompt (displays the URL); the TUI shows a BrowserReviewCard (status / console error count / screenshot path).
