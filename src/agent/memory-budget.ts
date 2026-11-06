import type { Store } from '../storage/store.js';
import { quotedMessage } from './quoted-message.js';

/** 统计原文、引用和发言人，逐条读取以免积累大量原始事件。 */
export function pendingMemoryCharacters(store: Store, conversationId: string, since: number, through: number): number {
  const rows=store.db.prepare("SELECT content,sender_name,raw FROM messages WHERE conversation_id=? AND seq>? AND seq<=?").iterate(conversationId,since,through) as IterableIterator<{content:string;sender_name:string|null;raw:string|null}>;
  let size=0;
  for(const row of rows) size+=row.content.length+(row.sender_name?.length ?? 0)+(quotedMessage(row.raw)?.length ?? 0)+24;
  return size;
}

export function memoryBudgetReached(characters: number, budget: number, percent: number): boolean {
  return characters >= budget * percent / 100;
}
