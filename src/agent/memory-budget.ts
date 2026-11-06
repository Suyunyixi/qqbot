import type { Store } from '../storage/store.js';

/** 仅统计待整理正文和发言人信息，图片内容不计入字符预算。 */
export function pendingMemoryCharacters(store: Store, conversationId: string, since: number, through: number): number {
  const row=store.db.prepare("SELECT COALESCE(SUM(LENGTH(content)+LENGTH(COALESCE(sender_name,''))+24),0) AS size FROM messages WHERE conversation_id=? AND seq>? AND seq<=?").get(conversationId,since,through) as {size:number};
  return row.size;
}

export function memoryBudgetReached(characters: number, budget: number, percent: number): boolean {
  return characters >= budget * percent / 100;
}
