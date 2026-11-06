import { isCommunityScope, type InboundEvent } from '../domain/types.js';
import type { MessageRow } from '../storage/store.js';
import { renderMessage } from './message-view.js';

export interface ConversationFocus {
  /** 保留说话人和消息边界的近期对话。 */
  rows: MessageRow[];
  /** 较早上下文；较长的近期消息也保留在这里，方便读取原文。 */
  background: MessageRow[];
  mentionOnly: boolean;
}

/** 提取有限的近期对话，不预先猜测发言是否针对机器人。 */
export function conversationFocus(recent: MessageRow[], event: InboundEvent, windowSeconds: number): ConversationFocus {
  const mentionOnly = event.isMention && event.content.replace(/<@!?[^>]+>/g, '').trim().length === 0;
  if (!isCommunityScope(event.scope)) return { rows: [], background: recent, mentionOnly };
  const triggerTime=Date.parse(event.timestamp);
  if (!Number.isFinite(triggerTime)) return { rows: [], background: recent, mentionOnly };
  // 上一条机器人回复作为边界；更早消息保留为背景，不默认视为待答请求。
  let lastBot=-1;
  for (let i=recent.length-1;i>=0;i--) if (recent[i]!.direction==='out') { lastBot=i; break; }
  const start=lastBot<0?0:lastBot;
  const rows=recent.slice(start).filter((row)=>{
    const age=triggerTime-Date.parse(row.timestamp);
    return Number.isFinite(age) && age>=-60_000 && age<=windowSeconds*1000;
  }).slice(-12);
  if (!rows.some((row)=>row.direction==='in')) return {rows:[],background:recent,mentionOnly};
  const focused=new Set(rows.filter((row)=>row.content.length<=700 && row.attachments.length<=700).map((row)=>row.seq));
  return { rows, background:recent.filter((row)=>!focused.has(row.seq)), mentionOnly };
}

export function formatConversationFocus(rows: MessageRow[], markRecent=true): string {
  return rows.map((row)=>renderMessage(row,{marker:markRecent?'近期互动':undefined,contentLimit:700,attachmentLimit:300})).join('\n');
}
