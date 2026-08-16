import type { ChatMessage } from '../providers/types.js';
import type { ProviderId } from '../config/types.js';
import type { TodoItem } from '../tools/native/todo.js';
import type { UsageEvent } from '../usage/extractor.js';
import type { CompactionPlan } from '../agent/compressor.js';

export interface SessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  workspace: string;
  provider: ProviderId;
  model: string;
  title: string;
  messages: ChatMessage[];
  todos: TodoItem[];
  usage: UsageEvent[];
  compacted: CompactionPlan[];
}

/** One JSONL line of the on-disk session format */
export type SessionLine =
  | { t: 'meta'; id: string; createdAt: number; workspace: string; provider: ProviderId; model: string; title: string }
  | { t: 'message'; role: ChatMessage['role']; content: ChatMessage['content'] }
  | { t: 'usage'; event: UsageEvent }
  | { t: 'todo'; items: TodoItem[] }
  | { t: 'compacted'; plan: CompactionPlan };
