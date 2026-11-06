import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { isCommunityScope, type Scope } from '../domain/types.js';
import type { Store, MessageRow } from '../storage/store.js';
import type { AppConfig } from '../config/settings.js';
import { renderMessages } from './message-view.js';

/** 在最后一次中间件检查之后，再检查新到消息。 */
export async function recheckBeforeReply<T>(initial: T, takePending: () => HumanMessage | undefined, resume: (message: HumanMessage) => Promise<T>): Promise<T> {
  let result = initial;
  for (let i = 0; i < 2; i++) {
    const addition = takePending();
    if (!addition) break;
    result = await resume(addition);
  }
  return result;
}

/** 将静默群消息加入正在处理的回合，但不单独唤醒模型。 */
export function liveContext(store: Store, scope: Scope, conversationId: string, config: AppConfig, startSeq: number) {
  let cursor = startSeq; let finalRechecks = 0;
  type Row = MessageRow & { is_mention: number };
  const pending = () => !isCommunityScope(scope) ? [] : store.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND direction='in' AND seq>? ORDER BY seq LIMIT 100").all(conversationId,cursor) as Row[];
  const silent = (rows: Row[]) => rows.filter((row) => {
    return !row.is_mention && !config.trigger.keywords.some((keyword) => row.content.includes(keyword));
  });
  const hasPending = () => silent(pending()).length > 0;
  const pull = () => {
    const rows = pending(); if (!rows.length) return undefined;
    cursor = rows[rows.length - 1]!.seq;
    const additions = silent(rows); if (!additions.length) return undefined;
    const text = renderMessages(additions,Math.floor(config.model.contextTokens / 8));
    return new HumanMessage(`在处理当前请求期间，群友补充了以下对话。这些是群聊数据，请结合相关发言、区分说话人，不必机械地逐条回复：\n${text}`);
  };
  const middleware = createMiddleware({
    name: 'LiveGroupContext',
    beforeModel: () => { const message = pull(); return message ? {messages:[message]} : undefined; },
    afterModel: { canJumpTo: ['model'], hook: (state) => {
      const last = state.messages.at(-1);
      if (finalRechecks >= 2 || !(last instanceof AIMessage) || (last.tool_calls?.length ?? 0) > 0) return undefined;
      const message = pull(); if (!message) return undefined;
      finalRechecks++; return {messages:[message],jumpTo:'model' as const};
    } },
    wrapToolCall: async (request, handler) => {
      if (['send_text','send_media','send_native_card','send_keyboard','send_embed'].includes(request.toolCall.name) && hasPending()) return new ToolMessage({tool_call_id:request.toolCall.id!,name:request.toolCall.name,status:'error',content:'当前群有新的插话尚未纳入本轮，请结合接下来的群聊补充再决定如何交付。'});
      return handler(request);
    },
  });
  return { middleware, hasPending, takePending: pull };
}
