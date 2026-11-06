import { randomUUID } from 'node:crypto';
import { readConfig } from '../config/settings.js';
import { Store } from '../storage/store.js';
import type { DeliveryItem, DeliveryKind, Scope, Sender } from '../domain/types.js';
import { resolveWorkspaceFile } from '../storage/workspace.js';
import { splitMarkdown } from './markdown.js';
import { qqMentionMarkup } from '../platform/qq/mentions.js';

export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = Math.max(rest.lastIndexOf('\n', limit), rest.lastIndexOf('。', limit), rest.lastIndexOf('！', limit), rest.lastIndexOf('？', limit));
    if (cut < limit / 3) cut = limit; else cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Every delivery, including explicit tools and background callbacks, uses this queue.
export class ReplyRuntime {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: Store, private readonly sender: Sender) {}

  async retry(conversationId: string, id: string, currentReplyTo?: string): Promise<void> {
    const item = this.store.pendingOutbox(conversationId).find((candidate) => candidate.id === id);
    if (!item) throw new Error('没有找到可重试的发送记录');
    if (item.status === 'unknown') throw new Error('上次发送结果未知，不能自动重发，请先检查群消息');
    this.store.setOutbox(id, 'retrying');
    try {
      await this.send(conversationId, item.scope, currentReplyTo ?? item.reply_to ?? undefined, item.kind, item.content, item.file_name ?? undefined);
      this.store.setOutbox(id, 'retried');
    } catch (error) { this.store.setOutbox(id, 'failed', undefined, error instanceof Error ? error.message : String(error)); throw error; }
  }

  async send(conversationId: string, scope: Scope, replyTo: string | undefined, kind: DeliveryKind, content: string, fileName?: string, deliveryKey?: string): Promise<void> {
    if (kind !== 'text' && kind !== 'card' && kind !== 'keyboard' && kind !== 'embed') {
      content = resolveWorkspaceFile(conversationId, content);
    }
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const formatted=kind==='text' && (scope==='group' || scope==='guild') ? qqMentionMarkup(content) : content;
      const pieces = kind === 'text' ? splitMarkdown(formatted, readConfig().delivery.chunkCharacters) : [content];
      for (const [index, piece] of pieces.entries()) {
        const item: DeliveryItem = { id: deliveryKey ? `${deliveryKey}:${index}` : randomUUID(), conversationId, scope, replyTo, kind, content: piece, fileName };
        const state = this.store.outboxState(item.id);
        if (state === 'sent') continue;
        if (state === 'unknown' || state === 'sending') throw new Error('上次发送结果未知，未自动重复发送');
        if (!state) this.store.addOutbox(item);
        this.store.setOutbox(item.id, 'sending');
        try {
          const result = await this.sender.send(item);
          this.store.setOutbox(item.id, 'sent', result.id);
          this.store.recordSent(item, result.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // A timeout may have reached QQ. Never silently retry such a delivery.
          const uncertain = /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(reason);
          this.store.setOutbox(item.id, uncertain ? 'unknown' : 'failed', undefined, reason);
          throw error;
        }
      }
    });
    this.queues.set(conversationId, next);
    try { await next; } finally { if (this.queues.get(conversationId) === next) this.queues.delete(conversationId); }
  }
}
