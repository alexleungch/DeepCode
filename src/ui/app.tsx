import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { theme } from './theme.js';
import { emptyState, reduceState, setContextInfo, nextSeqId, type TUIState, type MessageView } from './state.js';
import { EventBatcher } from './event-batcher.js';
import { messageIndexWindow, bottomStart, estimateTotalRows, estimateMessageRows } from './virtual-scroll.js';
import { StatusBar } from './components/StatusBar.js';
import { Header } from './components/Header.js';
import { MessageItem } from './components/MessageList.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { PromptInput } from './components/PromptInput.js';
import { TodoPanel } from './components/TodoPanel.js';
import type { DeepcodeEngine } from '../engine.js';
import { providerLabel } from '../engine.js';
import { applyTheme, currentThemeId, resolveTheme, setActiveThemeId, themeListing } from './themes.js';
import { API_KEY_ENV } from '../config/loader.js';
import { providerIds, type PermissionMode, type ProviderId } from '../config/types.js';
import type { ApprovalResult } from '../tools/permission.js';
import { formatTokens } from '../agent/token-budget.js';
import { parseMouse, WHEEL_UP, WHEEL_DOWN } from './mouse.js';

/** Main TUI: subscribes to the engine event stream -> React state -> rendering */
export function DeepcodeTUI({ engine, onExit }: { engine: DeepcodeEngine; onExit: () => void }) {
  // Apply the configured theme (config ui.theme / --theme) before the first render.
  // The palette is a mutable singleton (themeColors via applyTheme), so this also
  // covers the /theme command: any later applyTheme() re-renders every component
  // that reads the shared `theme` object.
  useEffect(() => {
    setActiveThemeId(engine.config.ui?.theme);
    applyTheme(currentThemeId());
  }, [engine]);
  const [state, setState] = useState<TUIState>(() => {
    const s = emptyState();
    s.sessionId = engine.session.id;
    s.provider = engine.config.provider;
    s.model = engine.provider.model;
    s.workspace = engine.workspace;
    s.permissionMode = engine.config.permissions.mode;
    return setContextInfo(s, engine.contextRatio(), engine.provider.modelMeta.windowTokens || engine.config.context.maxTokens);
  });
  const [showCost, setShowCost] = useState(false);
  const [showContext, setShowContext] = useState(false);
  // Tool card whose full diff/result is expanded (set by Enter on a tool card)
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  // Assistant message whose collapsed thinking is expanded (set by Ctrl+O when no tool card exists)
  const [expandedThinkingId, setExpandedThinkingId] = useState<number | null>(null);
  // Provider whose model name the user is being prompted to enter (set by /models <provider>)
  const [pendingModel, setPendingModel] = useState<ProviderId | null>(null);
  // Provider + model whose API key the user is being prompted to enter (after the model name)
  const [pendingKey, setPendingKey] = useState<{ pid: ProviderId; model: string } | null>(null);
  // In-app history scroll. `scrollOffset` is the index of the FIRST VISIBLE message in the full
  // list; PageUp decreases it (reveal older), PageDown increases it (toward newer). `atBottom`
  // pins the view to the newest message — when the user scrolls up it becomes false so new turns
  // don't yank the view down while they're reading history. A real terminal height enables the
  // pinned viewport + scrollbar; headless/test environments render the full list with no scrollbar.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollOffsetRef = useRef(0);
  // Latest message list for the (memoized, stable) onSubmit handler. The reducer reuses message
  // object identities, so reading through the ref at submit time is equivalent to a fresh render
  // closure — but it keeps onSubmit's identity STABLE across streamed frames, which is what lets
  // the memoized PromptInput skip re-rendering while the agent streams.
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  const SCROLL_STEP = 8;
  const WHEEL_STEP = 3;
  const { stdout } = useStdout();
  // Track the terminal column AND row count so a resize triggers a re-render. The pinned frame
  // (Header + scroll viewport + bordered input + StatusBar) replaces the old <Static> + native
  // scrollback design: the main area is now a fixed-height viewport that scrolls internally
  // (PageUp/PageDown), so we no longer rely on the terminal's own scrollbar.
  const [cols, setCols] = useState(() => stdout.columns ?? 100);
  const [rows, setRows] = useState(() => stdout.rows ?? 40);
  useEffect(() => {
    const onResize = () => {
      setCols(stdout.columns ?? 100);
      setRows(stdout.rows ?? 40);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  const width = Math.max(40, cols - 4);
  // Only pin the layout to a fixed terminal height when a real row count is available (a TTY).
  // Ink 6.8's calculateLayout constrains only the root WIDTH, never its height, so without an
  // explicit height `flexGrow` has no definite space to distribute and the input + status bar
  // float just below the (content-height) message area instead of sitting at the bottom. In
  // headless/test environments `stdout.rows` is undefined, so we fall back to the old
  // content-height layout (no fixed height, no flexGrow filling) — this also avoids Ink's
  // log-update line-overlap artifact that only shows up when a fixed height is forced without a
  // real terminal.
  const fixedHeight = typeof stdout.rows === 'number' && stdout.rows > 0 ? rows : undefined;
  // Adaptive input-box height cap: the input may grow up to 2/3 of the main conversation area so
  // a long paste / multi-line draft stays visible without swallowing the whole screen. The main
  // area is what remains after the pinned Header (~2 rows), the bordered input (~3 rows min),
  // and the bordered StatusBar (~4 rows) — a ~9-row fixed overhead. The box still scrolls
  // internally past this cap; on submit it collapses back to a single line via setBoth('', 0).
  const fixedOverhead = 9;
  // Pinned overlay height estimate: the todo panel, transient notices, and the approval dialog
  // are rendered BELOW the scroll viewport (above the input) and consume REAL terminal rows.
  // The message window and the last-message cap must budget for them, otherwise the newest
  // content overflows out the TOP of the viewport (flex-end anchoring) and the head of a long
  // final answer disappears while the agent's todo panel is still pinned — the user sees a todo
  // checklist followed by nothing, and can't tell the answer (or the task) ever finished.
  // Todo panel: 2 borders + 1 title + up to 8 visible items + 1 margin (+1 "+N more" line).
  const todoPanelRows = state.todos.length > 0 ? Math.min(state.todos.length, 8) + (state.todos.length > 8 ? 5 : 4) : 0;
  // Transient notices: up to 5 shown, each a text row plus its margin row.
  const noticeRows = Math.min(state.notices.length, 5) * 2;
  // Approval dialog: rough estimate (frame + one row per pending item); the turn is paused while
  // it is open, so exactness here only affects how much history stays in the window.
  const approvalRows =
    state.approvals.some((a) => !a.resolved) ? Math.min(12, Math.max(6, state.approvals.filter((a) => !a.resolved).length * 3)) : 0;
  const overlayRows = todoPanelRows + noticeRows + approvalRows;
  const mainAreaRows = Math.max(3, rows - fixedOverhead - overlayRows);
  const inputMaxLines = Math.max(2, Math.floor((mainAreaRows * 2) / 3));

  // Mouse tracking (wheel scroll) is enabled for the whole TUI session in cli.ts runTUI
  // (`\x1b[?1000h` + SGR `\x1b[?1006h`) and disabled again on exit. Wheel events reach the
  // useInput handler below as `[<64;…M` (up) / `[<65;…M` (down) and scroll the main viewport.

  // Keep the view pinned to the newest message while `atBottom` is true. Recompute the bottom start
  // whenever the conversation grows — in LENGTH (a new turn) OR in CONTENT SIZE (a thinking-only
  // message that later fills in its final answer text changes height without changing the count),
  // or a tool card expands/collapses while at the bottom.
  const pinOpts = { expandedCallId: expandedTool, expandedThinkingId: expandedThinkingId };
  // Total estimated rows of the whole conversation. Computed ONCE per render and reused by the
  // pin effect, the scroll-hint percent, and the viewport guards (the old code called
  // estimateTotalRows twice per render; the markdown line cache in MessageList makes this cheap).
  const totalRows = estimateTotalRows(state.messages, width, pinOpts);
  useEffect(() => {
    if (!atBottom) return;
    const bs = bottomStart(state.messages, width, mainAreaRows, pinOpts);
    scrollOffsetRef.current = bs;
    setScrollOffset(bs);
  }, [atBottom, totalRows, state.messages.length, width, mainAreaRows, expandedTool, expandedThinkingId]);

  // Keep the mirror ref in sync with the scroll offset even when it is changed outside the main
  // input handler (e.g. the /clear command resets it via setState).
  useEffect(() => {
    scrollOffsetRef.current = scrollOffset;
  }, [scrollOffset]);

  // Approval bridge: engine -> dialog
  const [approval, setApproval] = useState<{ requestId: string; items: import('../tools/permission.js').ApprovalItem[] } | null>(null);
  const [approvalResolve, setApprovalResolve] = useState<((r: ApprovalResult) => void) | null>(null);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);
  // Cumulative decisions in the current approval batch (for the summary line)
  const [decisionSummary, setDecisionSummary] = useState<{ allowed: number; denied: number }>({ allowed: 0, denied: 0 });
  // Whether the focused approval item's diff is fully expanded (Ctrl+E)
  const [diffExpanded, setDiffExpanded] = useState(false);

  useEffect(() => {
    // Streaming tokens (text-delta / thinking-delta / tool-progress) can arrive much faster than
    // React renders; batch them into ONE setState per 16ms frame instead of re-rendering per token.
    // Control events (message / tool-result / turn-end / error / …) flush the buffer first and are
    // applied immediately, preserving stream order. The pure reduceState is applied per batch.
    const batcher = new EventBatcher((events) => setState((s) => events.reduce(reduceState, s)));
    const off = engine.onEvent((e) => batcher.push(e));
    return () => {
      off();
      batcher.dispose();
    };
  }, [engine]);

  // Engine approval handler: driven by the TUI dialog (registered after construction)
  useEffect(() => {
    const handler = (items: import('../tools/permission.js').ApprovalItem[]): Promise<ApprovalResult> => {
      return new Promise((resolve) => {
        setApproval({ requestId: `r${Date.now()}`, items });
        setFocusIndex(0);
        setFeedbackMode(false);
        setFeedbackText('');
        setDecisionSummary({ allowed: 0, denied: 0 });
        setDiffExpanded(false);
        setApprovalResolve(() => resolve);
      });
    };
    engine.setApprovalHandler(handler);
    return () => engine.setApprovalHandler(undefined);
  }, [engine]);

  const activeApproval = approval;

  const decide = (callId: string, action: 'allow' | 'deny' | 'allow-always' | 'deny-always', feedback?: string) => {
    if (!activeApproval || !approvalResolve) return;
    const others = activeApproval.items.filter((i) => i.callId !== callId);
    setDecisionSummary((s) =>
      action === 'deny' || action === 'deny-always' ? { ...s, denied: s.denied + 1 } : { ...s, allowed: s.allowed + 1 },
    );
    if (others.length === 0) {
      approvalResolve({ decisions: [{ callId, action, feedback }], aborted: false });
      setApproval(null);
      setApprovalResolve(null);
      return;
    }
    // More items pending: decide the current one and keep the dialog for the rest
    setApproval({ requestId: activeApproval.requestId, items: others });
    setFocusIndex(0);
    setDiffExpanded(false);
    const r = approvalResolve;
    setApprovalResolve(() => (result: ApprovalResult) => {
      r({ decisions: [{ callId, action, feedback }, ...result.decisions], aborted: result.aborted });
    });
  };

  /** Decide every remaining item with the same action (A = allow all, D = deny all). */
  const decideAll = (action: 'allow' | 'deny') => {
    if (!activeApproval || !approvalResolve) return;
    const items = activeApproval.items;
    setDecisionSummary((s) =>
      action === 'deny' ? { ...s, denied: s.denied + items.length } : { ...s, allowed: s.allowed + items.length },
    );
    approvalResolve({
      decisions: items.map((i) => ({ callId: i.callId, action })),
      aborted: false,
    });
    setApproval(null);
    setApprovalResolve(null);
  };

  const abortAll = () => {
    if (approvalResolve) approvalResolve({ decisions: [], aborted: true });
    setApproval(null);
    setApprovalResolve(null);
  };

  // Shared vertical-scroll primitive for PageUp/PageDown and the mouse wheel. `delta < 0` scrolls
  // up (reveal older messages), `delta > 0` scrolls down (toward the newest). Clamped to [0, N-1];
  // scrolling up unpins from the bottom, scrolling down re-pins once the newest message is in view.
  const scrollBy = (delta: number) => {
    const N = state.messages.length;
    const no = Math.min(Math.max(0, N - 1), Math.max(0, scrollOffsetRef.current + delta));
    scrollOffsetRef.current = no;
    setScrollOffset(no);
    if (delta < 0) {
      setAtBottom(false);
      return;
    }
    const win = messageIndexWindow(state.messages, width, no, mainAreaRows, {
      expandedCallId: expandedTool,
      expandedThinkingId: expandedThinkingId,
    });
    setAtBottom(win.atBottom);
  };

  useInput((input, key) => {
    // Ctrl+C: while busy/interrupting → abort the current request; while idle → graceful exit
    // (unmount → engine.finalizeMemory + close so memory/session/usage are flushed, not lost).
    if (key.ctrl && (input === 'c' || input === 'C')) {
      if (state.busy || approval !== null) {
        // With an approval dialog open, ESC/Ctrl+C must abandon the PENDING batch (resolve the
        // approval Promise with aborted=true) instead of just aborting the model stream — otherwise
        // runToolCalls awaits the approval forever and the UI is stuck on an unresolvable dialog.
        if (approval !== null) abortAll();
        engine.interrupt();
      } else {
        onExit();
      }
      return;
    }
    // Ctrl+O toggles the most recent tool card's full diff/result (only in the live region).
    // Deliberately NOT Enter — Ink fires every useInput handler, so Enter would both submit the
    // prompt input and toggle expansion; Ctrl+O is unambiguous and safe while typing.
    // When no terminal tool card exists, Ctrl+O expands the last settled message's collapsed
    // thinking instead (the thinking indicator stays hidden after the turn until then).
    if (key.ctrl && (input === 'o' || input === 'O')) {
      const lastTool = [...state.messages]
        .reverse()
        .flatMap((m) => m.toolCalls)
        .find((tc) => tc.status === 'done' || tc.status === 'error' || tc.status === 'denied');
      if (lastTool) {
        setExpandedTool((cur) => (cur === lastTool.callId ? null : lastTool.callId));
      } else {
        const lastThought = [...state.messages].reverse().find((m) => m.thinking && !m.streaming);
        if (lastThought) {
          setExpandedThinkingId((cur) => (cur === lastThought.id ? null : lastThought.id));
        }
      }
      return;
    }
    // Shift+Tab cycles the permission mode (one-key switch, per the layout/UX spec). Tab alone
    // stays reserved for slash-command completion in PromptInput (which now ignores Shift+Tab).
    if (key.tab && key.shift) {
      const nm = nextMode(state.permissionMode);
      switchMode(engine, nm, setState);
      pushNotice(setState, `Mode → ${MODE_LABEL[nm]} (${nm}). Press Shift+Tab to switch again.`, 'info', 'mode');
      return;
    }
    // In-app history scroll (replaces the native terminal scrollback we dropped for the pinned
    // layout). Shift+↑/↓ moves one message (≈ one line); PageUp/PageDown moves a page; Home/End
    // jumps to the top/bottom. Plain ↑/↓ are left for the input box's cursor (PromptInput), so we
    // deliberately gate line-scroll behind Shift to avoid breaking multi-line editing.
    if (key.shift && key.upArrow) {
      scrollBy(-1);
      return;
    }
    if (key.shift && key.downArrow) {
      scrollBy(1);
      return;
    }
    if (key.pageUp) {
      scrollBy(-SCROLL_STEP);
      return;
    }
    if (key.pageDown) {
      scrollBy(SCROLL_STEP);
      return;
    }
    // Ctrl+Home / Ctrl+End jump to the very top / bottom of the history. PLAIN Home/End are
    // deliberately NOT handled here — they belong to the input box's cursor movement
    // (PromptInput). Ink fires every useInput handler, so binding plain Home/End in both
    // places used to scroll history AND move the cursor at the same time.
    if (key.ctrl && key.home) {
      scrollBy(-1e9);
      return;
    }
    if (key.ctrl && key.end) {
      scrollBy(1e9);
      return;
    }
    // Mouse wheel over the main viewport (SGR extended mode; enabled in cli.ts). Only the press
    // (`M`) half of each wheel pair is acted on, so every notch scrolls exactly once.
    const mouse = parseMouse(input);
    if (mouse) {
      if (mouse.press && mouse.button === WHEEL_UP) scrollBy(-WHEEL_STEP);
      else if (mouse.press && mouse.button === WHEEL_DOWN) scrollBy(WHEEL_STEP);
      return;
    }
    // History scrolling is now handled above (PageUp/PageDown over the in-app viewport), so the
    // ESC branch below only deals with cancellation / panel closing / interrupt.
    if (!key.escape) return;
    // Cancel a pending model-name / API-key entry first
    if (pendingKey) {
      setPendingKey(null);
      pushNotice(setState, 'API key entry cancelled.', 'info', 'models');
      return;
    }
    if (pendingModel) {
      setPendingModel(null);
      pushNotice(setState, 'Model name entry cancelled.', 'info', 'models');
      return;
    }
    // Floating panels take priority: ESC closes the cost/context panel
    if (showCost) {
      setShowCost(false);
      return;
    }
    if (showContext) {
      setShowContext(false);
      return;
    }
    // With no panel open, ESC interrupts the current request
    if (!activeApproval) engine.interrupt();
  });

  // Stable submit handler for the memoized PromptInput. Reads the LATEST message list through
  // messagesRef (a ref mirror updated each render) instead of the render closure, so its identity
  // only changes when the inputs it truly depends on (pendingModel/pendingKey/engine) change —
  // otherwise the memoized input would re-render on every streamed frame.
  const onSubmit = useCallback(
    (text: string) => {
      // Help and /models notices are transient: any new submission supersedes them so they never
      // crowd the live region. This mirrors /help — the previous hint (the /models list, the
      // "Switched to …" banner, or an API-key prompt) is replaced by your input and scrolls away.
      setState((s) =>
        s.notices.some((n) => n.group === 'help' || n.group === 'models')
          ? { ...s, notices: s.notices.filter((n) => n.group !== 'help' && n.group !== 'models') }
          : s,
      );
      // Stage 1: a model name is being requested — the next submitted line is the model name
      if (pendingModel) {
        const pid = pendingModel;
        setPendingModel(null);
        const model = text.trim() || (engine.config.models[pid] ?? 'unknown-model');
        if (pid !== 'ollama' && !engine.config.providers[pid]?.apiKey) {
          setPendingKey({ pid, model });
          pushNotice(setState, `${model} — no API key. Enter the API key for ${providerLabel(pid)} (verified against the API before saving), or press ESC to cancel:`, 'info', 'models');
          return;
        }
        switchToProvider(engine, pid, model, setState);
        return;
      }
      // Stage 2: an API key is being requested — the next submitted line is the key
      if (pendingKey) {
        const { pid, model } = pendingKey;
        const key = text.trim();
        if (!key) {
          setPendingKey(null);
          pushNotice(setState, 'API key entry cancelled.', 'info', 'models');
          return;
        }
        pushNotice(setState, `Testing API key for ${providerLabel(pid)}…`, 'info', 'models');
        void (async () => {
          try {
            await engine.testApiKey(key, pid);
          } catch (e) {
            pushNotice(setState, `API key test failed for ${providerLabel(pid)}: ${e instanceof Error ? e.message : String(e)} — key not saved. Try again or press ESC to cancel.`, 'error', 'models');
            return; // stay in key-entry mode so the user can retry
          }
          try {
            engine.setApiKey(key, pid);
          } catch (e) {
            pushNotice(setState, `Failed to save API key: ${e instanceof Error ? e.message : String(e)}`, 'error', 'models');
            return;
          }
          setPendingKey(null);
          pushNotice(setState, `API key for ${providerLabel(pid)} verified and saved (…${key.slice(-4)}). Persisted to ~/.deepcode/config.json.`, 'info', 'models');
          switchToProvider(engine, pid, model, setState);
        })();
        return;
      }
      if (text.startsWith('/')) {
        handleSlash(text, engine, onExit, setShowCost, setShowContext, setState, setPendingModel, setPendingKey, setScrollOffset, setAtBottom, messagesRef.current);
        return;
      }
      // Re-pin the viewport to the newest content when the user submits a new message. Without this,
      // reading history (PageUp) then sending a follow-up leaves the new result BELOW the fold —
      // the view stays at the old scroll position and the user has to scroll down to see it.
      setAtBottom(true);
      // User messages are added uniformly via the message event emitted at the start of runAgentTurn
      void engine.runTurn(text);
    },
    [engine, onExit, pendingModel, pendingKey, setState, setShowCost, setShowContext, setPendingModel, setPendingKey, setScrollOffset, setAtBottom],
  );

  // Stable @-completion hint handler for the memoized PromptInput (pushNotice is module-level).
  const onAtMatches = useCallback(
    (matches: string[]) => {
      const shown = matches.slice(0, 8).join('  ');
      const more = matches.length > 8 ? `  … +${matches.length - 8} more` : '';
      pushNotice(setState, `@ matches: ${shown}${more}  (Tab cycles)`, 'info', 'at');
    },
    [setState],
  );

  const busy = state.busy || (approval !== null);

  // The main scroll viewport is a fixed-height region between the header and the input. When a real
  // terminal height is known (fixedHeight set) we render a position-based window of the conversation
  // (anchored to the bottom at the newest, or to the top once the user scrolls up) plus a scrollbar;
  // headless/test environments (no rows) keep the full list with no scrollbar.
  const win =
    fixedHeight !== undefined
      ? messageIndexWindow(
          state.messages,
          width,
          // When pinned to the bottom, derive the window from the true bottom start instead of the
          // (possibly stale) scrollOffset. Without this, a frame between a new message arriving and
          // the re-pin effect running can show a non-bottom window and flash the "Back to bottom"
          // hint right after the user submits (visible under load when the batcher splits events).
          atBottom ? bottomStart(state.messages, width, mainAreaRows, { expandedCallId: expandedTool, expandedThinkingId: expandedThinkingId }) : scrollOffset,
          mainAreaRows,
          {
            expandedCallId: expandedTool,
            expandedThinkingId: expandedThinkingId,
          },
        )
      : null;
  const renderMessages = win ? state.messages.slice(win.start, win.end) : state.messages;
  // The view is only "at the bottom" when BOTH the user hasn't scrolled away (`atBottom` state,
  // set false by PageUp/Shift+↑/wheel-up) AND the window actually reaches the newest message.
  // Previously `win.atBottom` alone decided this: for a conversation that fits the (overscanned)
  // render window but not the strict viewport, `win.atBottom` stays true even after PageUp, so
  // the view stayed bottom-anchored, no "Back to bottom" hint appeared, and PageUp was a silent
  // no-op that could never reveal the tail of the newest message.
  const atBottomRender = win ? atBottom && win.atBottom : true;
  // Viewport overflow guard: when pinned to the bottom and the NEWEST rendered message alone is
  // taller than the viewport, cap how many of its markdown lines we render so the whole message
  // head stays visible. Without this, Ink's flex container clips the overflow from the TOP
  // (flex-end) or BOTTOM depending on justification — either way the start of a long answer that
  // arrived after a thinking phase can be hidden, which forces the user to scroll to find it.
  // (This is the "thinking finished but the result needs scrolling" regression.)
  const lastRendered = renderMessages[renderMessages.length - 1];
  const lastIsTall = lastRendered ? estimateMessageRows(lastRendered, width, { expandedCallId: expandedTool, expandedThinkingId: expandedThinkingId }) > mainAreaRows : false;
  // Reserve the REAL estimated rows of every message ABOVE the last one (each includes its own
  // margin), then give the remaining budget to the last message's content. The old guard only
  // reserved 1 row for "other messages" — a 2-row user message (text + margin) then overflowed
  // the viewport and the flex-end anchoring clipped the ANSWER'S FIRST LINE out of view.
  const aboveRows = renderMessages.length > 1 ? renderMessages.slice(0, -1).reduce((acc, m) => acc + estimateMessageRows(m, width, { expandedCallId: expandedTool, expandedThinkingId: expandedThinkingId }), 0) : 0;
  const maxLines = atBottomRender && lastIsTall ? Math.max(1, mainAreaRows - aboveRows - 1) : undefined;
  // Ink measures each markdown line slightly taller than 1 row when the message Box has a
  // marginBottom; subtract one more so the FIRST line of the answer is never pushed out.
  const contentMaxLines = maxLines !== undefined ? Math.max(1, maxLines - 1) : undefined;
  // Total estimated rows (only meaningful with a real terminal height) — used to derive the floating
  // position hint that REPLACES the old visual scrollbar. Computed once above (totalRows) and reused.
  let firstVisibleRow = 0;
  if (win) {
    for (let i = 0; i < win.start; i++) {
      firstVisibleRow += estimateMessageRows(state.messages[i]!, width, { expandedCallId: expandedTool, expandedThinkingId: expandedThinkingId });
    }
  }
  // Floating position hint that replaces the visual scrollbar: when scrolled up it reports how far
  // through the conversation the viewport top sits (percent), how many messages are above, and a
  // quick "jump to bottom" affordance. Null when pinned to the bottom (nothing to report).
  const scrollHint =
    win && !atBottomRender && totalRows > mainAreaRows
      ? `↓ Back to bottom (End) · ${scrollOffset} msgs above · ${Math.min(100, Math.max(0, Math.round((firstVisibleRow / Math.max(1, totalRows - mainAreaRows)) * 100)))}%`
      : null;

  return (
    // Root Box is pinned to the full terminal height (fixedHeight, set when a real row count
    // exists). Fixing the height makes flexGrow fill the middle viewport and anchors Header at
    // the top, the message area in between, and input + StatusBar at the bottom (chat layout).
    <Box flexDirection="column" height={fixedHeight}>
      <Header state={state} width={width} />
      <Box flexGrow={1} flexDirection="row" overflow="hidden" paddingX={1}>
        <Box flexGrow={1} flexDirection="column" justifyContent={atBottomRender ? 'flex-end' : 'flex-start'} overflow="hidden">
          {renderMessages.map((m, mi) => (
            <MessageItem
              key={m.id}
              m={m}
              width={width}
              expandedCallId={expandedTool ?? undefined}
              expandedThinkingId={expandedThinkingId ?? undefined}
              maxLines={mi === renderMessages.length - 1 ? contentMaxLines : undefined}
            />
          ))}
        </Box>
      </Box>
      {/* Pinned overlay (always visible, above the input): todo checklist, transient notices,
          the approval dialog, and the cost/context panels. Kept out of the scroll viewport so
          they never scroll away during a turn. */}
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        <TodoPanel todos={state.todos} width={width} />
        {state.notices.slice(-5).map((n) => (
          <Box key={`n-${n.id}`} flexDirection="column" marginBottom={1}>
            <Text color={n.kind === 'error' ? theme.error : n.kind === 'compact' ? theme.warning : theme.muted}>
              {n.text}
            </Text>
          </Box>
        ))}
        {activeApproval ? (
          <ApprovalDialog
            approval={{
              requestId: activeApproval.requestId,
              items: activeApproval.items,
              focusIndex,
              feedbackMode,
              feedbackText,
              resolved: false,
            }}
            width={width}
            callbacks={{
              decide: (callId, action, feedback) => decide(callId, action, feedback),
              decideAll: (action) => decideAll(action),
              setFeedbackMode: (on) => setFeedbackMode(on),
              typeFeedback: (ch) => setFeedbackText((t) => t + ch),
              backspaceFeedback: () => setFeedbackText((t) => t.slice(0, -1)),
              submitFeedback: () => {
                const f = feedbackText;
                if (activeApproval) decide(activeApproval.items[focusIndex]?.callId ?? '', 'allow', f);
                setFeedbackMode(false);
                setFeedbackText('');
              },
              abortAll,
              focusNext: (d) => {
                setFocusIndex((i) => (i + d) % Math.max(1, activeApproval.items.length));
                setDiffExpanded(false);
              },
              toggleDiff: () => setDiffExpanded((v) => !v),
            }}
            diffExpanded={diffExpanded}
          />
        ) : null}
        {activeApproval && (decisionSummary.allowed > 0 || decisionSummary.denied > 0) ? (
          <Text color={theme.muted}>
            Decided so far: {decisionSummary.allowed} allowed · {decisionSummary.denied} denied
          </Text>
        ) : null}
        {showCost ? <CostPanel state={state} width={width} onClose={() => setShowCost(false)} /> : null}
        {showContext ? <ContextPanel state={state} onClose={() => setShowContext(false)} /> : null}
      </Box>
      {/* Input box: visually distinct from history via a rounded border whose COLOR encodes the
          active permission mode (gray=AUTO, green=EDIT, yellow=PLAN, red=BYPASS). Height is
          adaptive — it grows with the content up to 2/3 of the main conversation area
          (inputMaxLines) and scrolls internally past that cap; on submit it collapses to 1 line. */}
      <Box borderStyle="round" borderColor={MODE_BORDER[state.permissionMode]} paddingX={1} flexShrink={0}>
        <PromptInput
          disabled={busy}
          width={width}
          maxLines={inputMaxLines}
          cwd={engine.workspace}
          onAtMatches={onAtMatches}
          onSubmit={onSubmit}
          placeholder={
            pendingModel
              ? `Enter model name for ${providerLabel(pendingModel)}…`
              : pendingKey
                ? `Enter API key for ${providerLabel(pendingKey.pid)}…`
                : busy
                  ? 'Running… (ESC to interrupt)'
                  : 'Type a message… (/help for shortcuts)'
          }
        />
      </Box>
      <StatusBar state={state} scrollHint={scrollHint} width={width} />
    </Box>
  );
}

/** Apply a permission-mode switch: engine + TUI state stay in sync. */
function switchMode(engine: DeepcodeEngine, mode: PermissionMode, setState: React.Dispatch<React.SetStateAction<TUIState>>): void {
  engine.setMode(mode);
  setState((s) => ({ ...s, permissionMode: mode }));
}

/** Cycle order for Shift+Tab mode switching (AUTO → EDIT → PLAN → BYPASS → AUTO). */
const MODE_CYCLE: PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'bypassPermissions'];

/** Status-bar / notice labels for permission modes (AUTO = the default ask mode). */
const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'AUTO',
  acceptEdits: 'EDIT',
  plan: 'PLAN',
  bypassPermissions: 'BYPASS',
};

/** Border color of the input box per active permission mode. */
const MODE_BORDER: Record<PermissionMode, string> = {
  ask: theme.muted,
  acceptEdits: theme.success,
  plan: theme.warning,
  bypassPermissions: theme.error,
};

/** Next mode in the Shift+Tab cycle. */
function nextMode(m: PermissionMode): PermissionMode {
  const i = MODE_CYCLE.indexOf(m);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!;
}

function pushNotice(
  setState: React.Dispatch<React.SetStateAction<TUIState>>,
  text: string,
  kind: 'info' | 'error' = 'info',
  group?: string,
) {
  setState((s) => {
    // Grouped notices replace their previous instance instead of stacking, so a section
    // (e.g. the /models list or the add-model flow) never accumulates.
    // ids come from the shared message/notice sequence so notices interleave chronologically
    // with messages in the merged list.
    const rest = group ? s.notices.filter((n) => n.group !== group) : s.notices;
    return { ...s, notices: [...rest, { id: nextSeqId(), text, kind, group }].slice(-15) };
  });
}

function switchToProvider(
  engine: DeepcodeEngine,
  pid: ProviderId,
  model: string | undefined,
  setState: React.Dispatch<React.SetStateAction<TUIState>>,
) {
  try {
    engine.setProvider(pid, model, true);
    setState((s) => ({ ...s, provider: pid, model: engine.provider.model }));
    pushNotice(setState, `Switched to ${providerLabel(pid)} (${engine.provider.model}). Persisted to ~/.deepcode/config.json.`, 'info', 'models');
  } catch (e) {
    pushNotice(setState, `Failed to switch to ${providerLabel(pid)}: ${e instanceof Error ? e.message : String(e)}`, 'error', 'models');
  }
}

/**
 * Serialize the in-app message list to a readable markdown transcript for /export. Renders each
 * message's text, collapsed thinking, and tool calls (name, input JSON, result). Long tool results
 * are capped so a single huge diff doesn't blow up the file.
 */
function formatTranscript(messages: MessageView[]): string {
  const lines: string[] = ['# deepcode conversation export', ''];
  const roleLabel = (r: MessageView['role']) => (r === 'user' ? 'User' : r === 'assistant' ? 'Assistant' : 'System');
  for (const m of messages) {
    lines.push(`## ${roleLabel(m.role)}`);
    if (m.thinking) lines.push('', '_Thinking:_', '', ...m.thinking.split('\n'), '');
    if (m.text) lines.push(...m.text.split('\n'), '');
    for (const tc of m.toolCalls) {
      lines.push('', `### Tool: ${tc.name} \`${tc.status}\``);
      if (tc.inputJson) lines.push('', '```json', tc.inputJson, '```', '');
      const res = tc.result?.diff ?? tc.result?.content ?? '';
      if (res) lines.push('', 'Result:', '', '```', res.length > 4000 ? res.slice(0, 4000) + '\n…(truncated)' : res, '```', '');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function handleSlash(
  text: string,
  engine: DeepcodeEngine,
  onExit: () => void,
  setShowCost: (v: boolean) => void,
  setShowContext: (v: boolean) => void,
  setState: React.Dispatch<React.SetStateAction<TUIState>>,
  setPendingModel: (v: ProviderId | null) => void,
  setPendingKey: (v: { pid: ProviderId; model: string } | null) => void,
  setScrollOffset: (v: (e: number) => number) => void,
  setAtBottom: (v: boolean) => void,
  messages: MessageView[],
) {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      onExit();
      break;
    case 'clear':
      engine.session.messages = [];
      setState((s) => ({ ...s, messages: [] }));
      // The main area is now an in-app scroll viewport; clearing just empties the list and
      // resets the scroll position to the (empty) bottom.
      setAtBottom(true);
      setScrollOffset(() => 0);
      break;
    case 'export': {
      // Offload a long conversation to a file (the Claude Code "external pager / export" pattern).
      // We write a readable markdown transcript to disk instead of suspending the TUI to run `less`
      // — safe, cross-platform, and non-destructive to the live session.
      if (messages.length === 0) {
        pushNotice(setState, 'Nothing to export.', 'info', 'export');
        break;
      }
      const target = rest[0];
      const safeTs = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outPath = target
        ? path.isAbsolute(target)
          ? target
          : path.join(engine.workspace, target)
        : path.join(engine.workspace, '.deepcode', 'exports', `session-${safeTs}.md`);
      try {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, formatTranscript(messages), 'utf8');
        pushNotice(setState, `Conversation exported to ${outPath} (${messages.length} messages).`, 'info', 'export');
      } catch (e) {
        pushNotice(setState, `Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error', 'export');
      }
      break;
    }
    case 'cost':
    case 'usage':
      setShowCost(true);
      break;
    case 'context':
      setShowContext(true);
      break;
    case 'compact':
      void engine.compactNow();
      break;
    case 'models': {
      const target = rest[0]?.toLowerCase();
      if (!target) {
        // Only show models whose API key was successfully added (ollama is local, no key needed).
        // Rendered as ONE grouped notice so repeated /models runs replace the old list instead of
        // stacking lines that would push it off-screen.
        const configured = providerIds.filter((pid) => pid === 'ollama' || !!engine.config.providers[pid]?.apiKey);
        const lines: string[] = ['Available providers:'];
        if (configured.length === 0) {
          lines.push('  No models configured yet — add one with /models <vendor>.');
        } else {
          for (const pid of configured) {
            const active = engine.config.provider === pid ? ' (current)' : '';
            const model = engine.config.models[pid] ?? 'unknown-model';
            const status = pid === 'ollama' ? 'local (no key needed)' : 'API key set';
            lines.push(`  ${model} — ${status}${active}`);
          }
        }
        lines.push(`Supported vendors: ${providerIds.join(', ')}`);
        lines.push('Add/switch with /models <vendor> — you will be prompted for the model name and, if needed, the API key (verified against the API before saving).');
        pushNotice(setState, lines.join('\n'), 'info', 'models');
        break;
      }
      const pid = providerIds.find((p) => p === target);
      if (!pid) {
        pushNotice(setState, `Unknown vendor "${target}". Supported vendors: ${providerIds.join(', ')}`, 'error', 'models');
        break;
      }
      if (rest[1]) {
        // Model provided inline: skip the model-name prompt
        if (pid !== 'ollama' && !engine.config.providers[pid]?.apiKey) {
          setPendingKey({ pid, model: rest[1] });
          pushNotice(setState, `${rest[1]} — no API key. Enter the API key for ${providerLabel(pid)} (verified against the API before saving), or press ESC to cancel:`, 'info', 'models');
          break;
        }
        switchToProvider(engine, pid, rest[1], setState);
        break;
      }
      const defaultModel = engine.config.models[pid] ?? 'unknown-model';
      setPendingModel(pid);
      pushNotice(setState, `Enter the model name for ${providerLabel(pid)} (default: ${defaultModel}), or press ESC to cancel:`, 'info', 'models');
      break;
    }
    case 'key': {
      const pid = engine.config.provider;
      if (pid === 'ollama') {
        pushNotice(setState, 'Ollama does not require an API key.');
        break;
      }
      const configured = engine.config.providers[pid]?.apiKey;
      if (rest[0]) {
        const key = rest[0];
        pushNotice(setState, `Testing API key for ${providerLabel(pid)}…`);
        void (async () => {
          try {
            await engine.testApiKey(key, pid);
          } catch (e) {
            pushNotice(setState, `API key test failed for ${providerLabel(pid)}: ${e instanceof Error ? e.message : String(e)} — key not saved.`, 'error');
            return;
          }
          try {
            engine.setApiKey(key, pid);
            pushNotice(setState, `API key for ${providerLabel(pid)} verified and saved (…${key.slice(-4)}). Persisted to ~/.deepcode/config.json.`);
          } catch (e) {
            pushNotice(setState, `Failed to save API key: ${e instanceof Error ? e.message : String(e)}`, 'error');
          }
        })();
      } else if (configured) {
        pushNotice(setState, `API key configured for ${providerLabel(pid)} (…${configured.slice(-4)}). Use /key <KEY> to replace it.`);
      } else {
        const envKey = API_KEY_ENV[pid];
        pushNotice(setState, `No API key configured for ${providerLabel(pid)}. Use /key <KEY> or set the ${envKey} environment variable.`);
      }
      break;
    }
    case 'theme': {
      const target = rest[0]?.toLowerCase();
      if (!target) {
        const cur = engine.config.ui?.theme ?? 'default';
        pushNotice(setState, ['Theme: ' + cur, ...themeListing()].join('\n'), 'info', 'theme');
        break;
      }
      const t = resolveTheme(target);
      try {
        engine.setTheme(t.id, true);
        pushNotice(setState, `Theme switched to ${t.id} (${t.name}) — ${t.description}. Persisted to ~/.deepcode/config.json.`, 'info', 'theme');
      } catch (e) {
        pushNotice(setState, `Failed to save theme: ${e instanceof Error ? e.message : String(e)}`, 'error', 'theme');
      }
      break;
    }
    case 'help': {
      // Rendered as ONE grouped multi-line notice so it survives the dynamic region's
      // slice(-5) window intact (repeated /help replaces the previous one instead of stacking).
      const lines = [
        'Available commands:',
        '  /help                       Show this help',
        '  /theme [id]                 Switch the TUI theme (default, dracula, gruvbox, nord, solarized, matrix, light, gruvbox-light); bare /theme lists them; auto-picks light on light terminals when unset',
        '  /key [KEY]                  Set the API key for the current provider (verified against the API before saving)',
        '  /models                     List configured models (only vendors with a working API key) + supported vendors',
        '  /models <vendor> [model]    Add/switch a vendor: prompts for the model name and, if needed, the API key (verified before saving)',
        '  /cost, /usage               Usage dashboard (tokens, cache hits, cost)',
        '  /context                    Context window usage and compaction threshold',
        '  /compact                    Manually compact the conversation',
        '  /clear                      Clear the current session',
        '  /export [path]              Save the conversation to a file',
        '  /exit, /quit                Exit the TUI',
        '',
        'Keybindings:',
        '  Enter                       Submit / insert newline (Alt+Enter / Shift+Enter for newline)',
        '  Tab                         Complete slash command, or insert the highlighted file from the @ list (Shift+Tab = cycle mode)',
        '  ↑/↓                         Cursor between wrapped lines (multi-line) / cycle command history (single-line) / move in the @ file list',
        '  ←/→, Home/End, Ctrl+A/E     Move the cursor',
        '  Ctrl+U/K/W                  Delete to line start / end / word before',
        '  Ctrl+O                      Expand the latest tool result (or collapsed thinking)',
        '  Ctrl+C                      Interrupt the current run / exit when idle',
        '  Ctrl+E                      Expand/collapse diff in approval dialog',
        '  ESC                         Cancel entry / close panel / interrupt',
        '  Shift+Tab                   Cycle permission mode (AUTO → EDIT → PLAN → BYPASS)',
        '  Shift+↑/↓                  Scroll history one line (up/down)',
        '  PageUp/PageDown, wheel     Page through conversation history',
        '  Ctrl+Home / Ctrl+End       Jump to top / bottom of history',
        '',
        '@file references:',
        '  Type @ in your message to attach a file — a live file list opens automatically; ↑/↓ move the highlight, Tab inserts (globs like @src/*.ts work)',
        '  Directories get a trailing / so you can keep descending; completing a file closes the list',
        '',
        'Permission modes:',
        '  AUTO   Ask before any file edit or tool use (default)',
        '  EDIT   Allow edits, ask before other tools',
        '  PLAN   Read-only: show what would happen, make no changes',
        '  BYPASS Full auto-pilot: no confirmations',
      ];
      pushNotice(setState, lines.join('\n'), 'info', 'help');
      break;
    }
    default:
      // Unknown commands are treated as ordinary messages for the agent (added via engine events).
      // Re-pin like the regular submit path so the response is visible even if the user scrolled up.
      setAtBottom(true);
      void engine.runTurn(text);
  }
}

function CostPanel({ state, width, onClose }: { state: TUIState; width: number; onClose: () => void }) {
  const u = state.usage;
  const cacheHit = u.cacheReadTokens + u.promptCacheHitTokens;
  const rows: [string, string][] = [
    ['Input tokens', formatTokens(u.inputTokens)],
    ['Output tokens', formatTokens(u.outputTokens)],
    ['Cache hits', cacheHit > 0 ? formatTokens(cacheHit) : '—'],
    ['Cache writes', u.cacheWriteTokens > 0 ? formatTokens(u.cacheWriteTokens) : '—'],
    ['Requests', String(u.requests)],
    ['Est. Cost', `$${u.costUsd.toFixed(4)}`],
  ];
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column" flexShrink={0}>
      <Text color={theme.accent} bold>
        📊 Usage (session total) — Esc to close
      </Text>
      {rows.map(([k, v]) => (
        <Text key={k}>
          <Text color={theme.muted}>{k.padEnd(14)}</Text>
          {v}
        </Text>
      ))}
    </Box>
  );
}

function ContextPanel({ state, onClose }: { state: TUIState; onClose: () => void }) {
  const pct = Math.round(state.contextRatio * 100);
  const threshold = Math.round(0.7 * 100);
  return (
    <Box borderStyle="round" borderColor={theme.primary} paddingX={1} flexDirection="column" flexShrink={0}>
      <Text color={theme.primary} bold>
        🧠 Context usage — Esc to close
      </Text>
      <Text>
        Current: {formatTokens(state.usage.totalTokens)} estimated / {formatTokens(state.contextWindow)} window ({pct}%)
      </Text>
      <Text color={pct >= threshold ? theme.error : theme.muted}>
        Compaction threshold: {threshold}% (auto-compacts beyond this{state.contextRatio >= threshold ? ' — threshold reached' : ''})
      </Text>
    </Box>
  );
}
