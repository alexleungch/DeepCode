import type { ChatMessage } from '../providers/types.js';
import { textContentOf } from '../providers/types.js';
import type { MemoryDb } from './db.js';
import type { MemoryExtraction } from '../agent/compressor.js';
import type { MemoryType } from '../config/types.js';

/**
 * Four-layer memory pipeline (inspired by TencentCloud/TencentDB-Agent-Memory):
 * L0 session stream → session store (existing)
 * L1 working memory → auto-extracted within the session / during compression (this module's extractFromTurns)
 * L2 long-term memory → persisted across sessions (MemoryDb save + retrieval)
 * L3 project knowledge → project docs (CLAUDE.md, etc.) + project-level memories
 */
export class MemoryPipeline {
  constructor(
    private db: MemoryDb,
    private workspace: string,
  ) {}

  private scope(): 'project' | 'global' {
    // Use the project scope within a project (distinguished by workspace path)
    return 'project';
  }

  /** Session start: retrieve a digest of relevant memories (injected into the system prompt; stable within the session). */
  digest(query: string, topK: number): string {
    const entries = this.db.search(query, { limit: topK, scope: this.scope() });
    if (entries.length === 0) return '';
    return (
      `The following are memories relevant to this project from past sessions (${entries.length}):\n` +
      entries
        .map((e, i) => `${i + 1}. [${e.type}] ${e.summary}${e.accessCount > 3 ? ' (frequently used)' : ''}`)
        .join('\n')
    );
  }

  /** On compression/session end, extract memories from collapsed turns (L1→L2). */
  extractFromTurns(turns: ChatMessage[]): MemoryExtraction[] {
    const out: MemoryExtraction[] = [];
    for (const msg of turns) {
      const text = textContentOf(msg).trim();
      if (!text || text.length < 20) continue;
      const extractions = extractFacts(text);
      for (const e of extractions) {
        if (this.isDuplicate(e.content)) continue;
        const entry = this.db.save({
          scope: this.scope(),
          type: e.type as MemoryType,
          content: e.content,
          sessionId: undefined,
        });
        void entry;
        out.push(e);
      }
    }
    return out;
  }

  /** Session end: extract user preferences and key decisions from the whole session. */
  extractFromSession(messages: ChatMessage[]): MemoryExtraction[] {
    const out: MemoryExtraction[] = [];
    const allText = messages.map((m) => textContentOf(m)).join('\n');
    // User preferences: imperative statements (always/never/avoid/prefer/please, etc.)
    const prefRe = /(?:always|never|don'?t|avoid|prefer|please|remember)\s*([^.\n!?]{4,80})/gi;
    let m: RegExpExecArray | null;
    while ((m = prefRe.exec(allText)) !== null) {
      const content = `User preference: ${m[1]!.trim()}`;
      if (content.length > 12 && !this.isDuplicate(content)) {
        this.db.save({ scope: this.scope(), type: 'preference', content, importance: 0.8 });
        out.push({ type: 'preference', content });
      }
    }
    // Key decisions: "decided/adopted/chose/plan" in assistant summaries
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const text = textContentOf(msg);
      const decRe = /(?:decided|adopted|chose|selected|conclusion(?: is)?|final plan(?: is)?)\s*:?\s*([^.\n]{6,100})/gi;
      while ((m = decRe.exec(text)) !== null) {
        const content = `Decision: ${m[1]!.trim()}`;
        if (!this.isDuplicate(content)) {
          this.db.save({ scope: this.scope(), type: 'experience', content, importance: 0.6 });
          out.push({ type: 'experience', content });
        }
      }
    }
    return out;
  }

  /** Dedup: an FTS hit (highly similar content) or the same text already exists. */
  private isDuplicate(content: string): boolean {
    const key = content.slice(0, 40);
    const hits = this.db.search(key, { limit: 1, scope: this.scope() });
    if (hits.length === 0) return false;
    const h = hits[0]!;
    // Full containment or high overlap counts as duplicate
    return h.content === content || h.content.includes(content) || content.includes(h.content);
  }
}

/** Rule-based fact extraction (no model dependency): extract short sentences from text. */
export function extractFacts(text: string): MemoryExtraction[] {
  const out: MemoryExtraction[] = [];
  const sentences = text.split(/(?<=[.!?\n])/).map((s) => s.trim()).filter((s) => s.length >= 10 && s.length <= 120);
  for (const s of sentences.slice(0, 6)) {
    const clean = s.replace(/^[#\-*\d.\s]+/, '').replace(/[.!?]+$/, '');
    if (/^(i|you|please|can|could|should|suggest)/i.test(clean)) continue; // Skip conversational statements
    if (/\b(tool|execut|read|write|succeed|success|fail|error)\w*\b|^(done|completed|finished)/i.test(clean)) continue; // Skip process noise
    const type: MemoryType = /(like|prefer|hope|want|don'?t|avoid)/i.test(clean) ? 'preference' : 'fact';
    out.push({ type, content: clean.slice(0, 100) });
  }
  return out.slice(0, 3);
}
