import React, { useState, useEffect } from 'react';
import { Box, Text, Static, useInput, useStdout } from 'ink';
import { theme } from './theme.js';
import { emptyState, reduceState, setContextInfo, nextSeqId, type TUIState } from './state.js';
import { StatusBar } from './components/StatusBar.js';
import { MessageItem } from './components/MessageList.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { PromptInput } from './components/PromptInput.js';
import type { DeepcodeEngine } from '../engine.js';
import { providerLabel } from '../engine.js';
import { API_KEY_ENV } from '../config/loader.js';
import { providerIds, permissionModes, type PermissionMode, type ProviderId } from '../config/types.js';
import type { ApprovalResult } from '../tools/permission.js';
import { formatTokens } from '../agent/token-budget.js';

/** Main TUI: subscribes to the engine event stream -> React state -> rendering */
export function DeepcodeTUI({ engine, onExit }: { engine: DeepcodeEngine; onExit: () => void }) {
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
  // Provider whose model name the user is being prompted to enter (set by /models <provider>)
  const [pendingModel, setPendingModel] = useState<ProviderId | null>(null);
  // Provider + model whose API key the user is being prompted to enter (after the model name)
  const [pendingKey, setPendingKey] = useState<{ pid: ProviderId; model: string } | null>(null);
  // Monotonic epoch used as <Static key=...>: bumped on /clear so the write-once Static region
  // remounts fresh instead of desyncing from the emptied message list.
  const [staticEpoch, setStaticEpoch] = useState(0);
  const { stdout } = useStdout();
  // Track the terminal column count so a resize triggers a re-render (the rendered width is
  // derived from it). The fixed-height dock layout was replaced by <Static> + the host terminal's
  // native scrollback: completed messages are written to stdout once and reviewed with the
  // terminal's own scrollbar / PageUp, so we no longer pin a fixed row count.
  const [cols, setCols] = useState(() => stdout.columns ?? 100);
  useEffect(() => {
    const onResize = () => setCols(stdout.columns ?? 100);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  const width = Math.max(40, cols - 4);

  // Mouse tracking is intentionally NOT enabled: it would make the terminal send clicks/drags to
  // the app and break native text selection and right-click paste. We defensively turn it off once
  // on startup in case a previous session left it on. Scrolling uses the terminal's native
  // scrollback (completed messages are written via <Static>), so PageUp/Home/End work natively.
  useEffect(() => {
    const s = stdout as unknown as { isTTY?: boolean };
    if (!s.isTTY) return;
    stdout.write('\x1b[?1000l\x1b[?1006l');
  }, [stdout]);

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
    const off = engine.onEvent((e) => {
      setState((s) => reduceState(s, e));
    });
    return off;
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

  useInput((input, key) => {
    // Ctrl+C: while busy/interrupting → abort the current request; while idle → graceful exit
    // (unmount → engine.finalizeMemory + close so memory/session/usage are flushed, not lost).
    if (key.ctrl && (input === 'c' || input === 'C')) {
      if (state.busy || approval !== null) {
        engine.interrupt();
      } else {
        onExit();
      }
      return;
    }
    // Ctrl+O toggles the most recent tool card's full diff/result (only in the live region).
    // Deliberately NOT Enter — Ink fires every useInput handler, so Enter would both submit the
    // prompt input and toggle expansion; Ctrl+O is unambiguous and safe while typing.
    if (key.ctrl && (input === 'o' || input === 'O')) {
      const lastTool = [...state.messages]
        .reverse()
        .flatMap((m) => m.toolCalls)
        .find((tc) => tc.status === 'done' || tc.status === 'error' || tc.status === 'denied');
      if (lastTool) {
        setExpandedTool((cur) => (cur === lastTool.callId ? null : lastTool.callId));
      }
      return;
    }
    // History scrolling is delegated to the host terminal: completed messages live in <Static>
    // and enter the terminal scrollback, so the user reviews history with the terminal's native
    // scrollbar / PageUp / Home. No in-app scroll handling is needed here.
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

  const onSubmit = (text: string) => {
    // Help is transient: any new submission supersedes it so it never crowds the live region.
    setState((s) =>
      s.notices.some((n) => n.group === 'help')
        ? { ...s, notices: s.notices.filter((n) => n.group !== 'help') }
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
      handleSlash(text, engine, onExit, setShowCost, setShowContext, setState, setPendingModel, setPendingKey, setStaticEpoch);
      return;
    }
    // User messages are added uniformly via the message event emitted at the start of runAgentTurn
    void engine.runTurn(text);
  };

  const busy = state.busy || (approval !== null);

  // Completed (settled) messages are rendered once via <Static> and pushed into the host
  // terminal's scrollback — they are never re-rendered and can be reviewed with the terminal's
  // native scrollbar / PageUp / Home. A message is "settled" once it is no longer streaming and
  // every tool call has reached a terminal state (done/error/denied), which guarantees no later
  // reducer event can mutate it — the write-once contract <Static> requires. Notices stay in the
  // dynamic region because their group-replacement semantics violate append-only; only the most
  // recent few are shown so they don't crowd the live area.
  const settled = state.messages.filter(isSettled);
  const live = state.messages.filter((m) => !isSettled(m));
  const contentWidth = width;

  return (
    <Box flexDirection="column">
      <Static key={staticEpoch} items={settled}>
        {(m) => (
          <Box key={m.id} flexDirection="column" paddingX={1}>
            <MessageItem m={m} width={contentWidth} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" paddingX={1}>
        {live.map((m) => (
          <Box key={m.id} flexDirection="column">
            <MessageItem m={m} width={contentWidth} expandedCallId={expandedTool ?? undefined} />
          </Box>
        ))}
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
        <PromptInput
          disabled={busy}
          width={width}
          onSubmit={onSubmit}
          placeholder={
            pendingModel
              ? `Enter model name for ${providerLabel(pendingModel)}…`
              : pendingKey
                ? `Enter API key for ${providerLabel(pendingKey.pid)}…`
                : busy
                  ? 'Running… (ESC to interrupt)'
                  : 'Type a message… (/help)'
          }
        />
        <StatusBar state={state} />
      </Box>
    </Box>
  );
}

/** A message is settled when it will no longer be mutated by the reducer: not streaming and all
 *  tool calls terminal. <Static> requires this so its write-once output stays correct. */
function isSettled(m: import('./state.js').MessageView): boolean {
  if (m.streaming) return false;
  return m.toolCalls.every((tc) => tc.status === 'done' || tc.status === 'error' || tc.status === 'denied');
}

/** Status-bar style labels for permission modes (AUTO = the default ask mode). */
const MODE_LABEL: Record<PermissionMode, string> = {
  ask: 'AUTO',
  acceptEdits: 'EDIT',
  plan: 'PLAN',
  bypassPermissions: 'BYPASS',
};

/** Mode that was active before entering plan mode, restored by /plan again (singleton TUI). */
let prevNonPlanMode: PermissionMode = 'ask';

/** Apply a permission-mode switch: engine + TUI state stay in sync. */
function switchMode(engine: DeepcodeEngine, mode: PermissionMode, setState: React.Dispatch<React.SetStateAction<TUIState>>): void {
  engine.setMode(mode);
  setState((s) => ({ ...s, permissionMode: mode }));
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

function handleSlash(
  text: string,
  engine: DeepcodeEngine,
  onExit: () => void,
  setShowCost: (v: boolean) => void,
  setShowContext: (v: boolean) => void,
  setState: React.Dispatch<React.SetStateAction<TUIState>>,
  setPendingModel: (v: ProviderId | null) => void,
  setPendingKey: (v: { pid: ProviderId; model: string } | null) => void,
  setStaticEpoch: (v: (e: number) => number) => void,
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
      // Remount <Static> so its write-once region restarts from the now-empty message list
      // (previously written history stays in the terminal scrollback, which is intended).
      setStaticEpoch((e) => e + 1);
      break;
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
    case 'plan': {
      // Toggle plan mode: on = read-only planning, off = restore the previous mode
      const cur = engine.config.permissions.mode;
      if (cur === 'plan') {
        switchMode(engine, prevNonPlanMode, setState);
        pushNotice(setState, `Plan mode off — back to ${MODE_LABEL[prevNonPlanMode]} (/${prevNonPlanMode}) mode. Write/exec tools are allowed again (subject to permission rules).`, 'info', 'mode');
      } else {
        prevNonPlanMode = cur;
        switchMode(engine, 'plan', setState);
        pushNotice(setState, 'Plan mode on — the agent only reads and proposes a plan; write/exec tools are denied. Run /plan again (or /mode) to exit.', 'info', 'mode');
      }
      break;
    }
    case 'mode': {
      const target = rest[0]?.toLowerCase();
      if (!target) {
        const cur = engine.config.permissions.mode;
        pushNotice(setState, `Current mode: ${MODE_LABEL[cur]} (/${cur}). Usage: /mode <${permissionModes.join('|')}>`, 'info', 'mode');
        break;
      }
      const m = permissionModes.find((p) => p === target);
      if (!m) {
        pushNotice(setState, `Unknown mode "${target}". Valid modes: ${permissionModes.join(', ')}`, 'error', 'mode');
        break;
      }
      if (m !== 'plan') prevNonPlanMode = m;
      switchMode(engine, m, setState);
      pushNotice(setState, `Permission mode: ${MODE_LABEL[m]} (/${m}).`, 'info', 'mode');
      break;
    }
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
    case 'help': {
      // Rendered as ONE grouped multi-line notice so it survives the dynamic region's
      // slice(-5) window intact (repeated /help replaces the previous one instead of stacking).
      const lines = [
        'Available commands:',
        '  /help                       Show this help',
        '  /plan, /mode [mode]      Permission mode: ask (AUTO), acceptEdits (EDIT), plan (PLAN), bypassPermissions (BYPASS). /plan toggles PLAN — agent reads + proposes a plan, write/exec tools denied (status bar shows [PLAN]); /mode <mode> sets a specific mode.',
        '  /key [KEY]                  Set the API key for the current provider (verified against the API before saving)',
        '  /models                     List configured models (only vendors with a working API key) + supported vendors',
        '  /models <vendor> [model]    Add/switch a vendor: prompts for the model name and, if needed, the API key (verified before saving)',
        '  /cost, /usage               Usage dashboard (tokens, cache hits, cost)',
        '  /context                    Context window usage and compaction threshold',
        '  /compact                    Manually compact the conversation',
        '  /clear                      Clear the current session',
        '  /exit, /quit                Exit the TUI',
        '  ESC                         Interrupt the current generation',
      ];
      pushNotice(setState, lines.join('\n'), 'info', 'help');
      break;
    }
    default:
      // Unknown commands are treated as ordinary messages for the agent (added via engine events)
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
