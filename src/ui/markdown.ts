/**
 * Lightweight Markdown renderer: converts markdown text into styled line blocks.
 * Supports: headings, bold/italic, inline code, code blocks, lists, quotes, horizontal rules.
 * The output structure is rendered line by line by Ink <Text> (avoids a heavy highlight dependency).
 */

export interface StyledLine {
  /** Style marker used for rendering */
  kind: 'h1' | 'h2' | 'h3' | 'code' | 'list' | 'quote' | 'hr' | 'text' | 'empty';
  text: string;
}

const CODE_BLOCK_RE = /^```(\w*)\s*$/;

export function renderMarkdown(md: string): StyledLine[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: StyledLine[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const flushCode = () => {
    if (codeBuf.length > 0) {
      out.push({ kind: 'code', text: codeBuf.join('\n') });
      codeBuf = [];
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (!inCode && CODE_BLOCK_RE.test(line)) {
      flushCode();
      inCode = true;
      codeLang = CODE_BLOCK_RE.exec(line)?.[1] ?? '';
      continue;
    }
    if (inCode) {
      if (/^```\s*$/.test(line)) {
        flushCode();
        inCode = false;
        codeLang = '';
        continue;
      }
      codeBuf.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      out.push({ kind: 'empty', text: '' });
      continue;
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      const level = /^(#{1,6})/.exec(trimmed)![1]!.length;
      const kind = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
      out.push({ kind, text: inline(trimmed.replace(/^#{1,6}\s*/, '')) });
      continue;
    }
    if (/^```/.test(trimmed)) continue; // defensive
    if (/^>\s?/.test(trimmed)) {
      out.push({ kind: 'quote', text: inline(trimmed.replace(/^>\s?/, '')) });
      continue;
    }
    if (/^[-*+]\s/.test(trimmed) || /^\d+[.)]\s/.test(trimmed)) {
      out.push({ kind: 'list', text: inline(trimmed.replace(/^([-*+]|\d+[.)])\s/, '• ')) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push({ kind: 'hr', text: '─'.repeat(40) });
      continue;
    }
    out.push({ kind: 'text', text: inline(trimmed) });
  }
  flushCode();
  if (inCode) out.push({ kind: 'code', text: codeBuf.join('\n') });
  return out;
}

/** Inline styles: markers are kept for rendering (simplified here: only link syntax is stripped, text is kept) */
function inline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

/** Plain text output for the terminal (used by the --print message view) */
export function markdownToPlain(md: string): string {
  return renderMarkdown(md)
    .filter((l) => l.kind !== 'empty')
    .map((l) => {
      switch (l.kind) {
        case 'h1':
          return `# ${l.text}`;
        case 'h2':
          return `## ${l.text}`;
        case 'h3':
          return `### ${l.text}`;
        case 'code':
          return `\`\`\`\n${l.text}\n\`\`\``;
        case 'list':
          return l.text;
        case 'quote':
          return `> ${l.text}`;
        case 'hr':
          return '─'.repeat(40);
        default:
          return l.text;
      }
    })
    .join('\n');
}

/** Truncate long lines (rendering protection) */
export function clipLine(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)) + '…';
}
