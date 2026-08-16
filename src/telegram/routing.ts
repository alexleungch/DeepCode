export type RoutedCommand =
  | { kind: 'help' }
  | { kind: 'new' }
  | { kind: 'status' }
  | { kind: 'instruction'; text: string };

/** Classify an inbound message into a bot command or an agent instruction. */
export function classifyMessage(text: string): RoutedCommand {
  const t = text.trim().toLowerCase();
  if (t === '/start' || t === '/help') return { kind: 'help' };
  if (t === '/new') return { kind: 'new' };
  if (t === '/status') return { kind: 'status' };
  return { kind: 'instruction', text: text.trim() };
}

/** Allowlist gate: an empty list denies everyone (must be explicitly configured). */
export function isAllowed(chatId: number, allowChatIds: number[]): boolean {
  if (!allowChatIds.length) return false;
  return allowChatIds.includes(chatId);
}
