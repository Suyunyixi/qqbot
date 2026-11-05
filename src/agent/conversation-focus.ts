import { isCommunityScope, type InboundEvent } from '../domain/types.js';
import type { MessageRow } from '../storage/store.js';

export interface ConversationFocus {
  /** Recent conversation candidates, preserving each speaker and message boundary. */
  rows: MessageRow[];
  /** Older context; long focused messages stay here so their full text remains available. */
  background: MessageRow[];
  mentionOnly: boolean;
}

/** Highlight a bounded recent conversation without guessing whether someone addressed the bot. */
export function conversationFocus(recent: MessageRow[], event: InboundEvent, windowSeconds: number): ConversationFocus {
  const mentionOnly = event.isMention && event.content.replace(/<@!?[^>]+>/g, '').trim().length === 0;
  if (!isCommunityScope(event.scope)) return { rows: [], background: recent, mentionOnly };
  const triggerTime=Date.parse(event.timestamp);
  if (!Number.isFinite(triggerTime)) return { rows: [], background: recent, mentionOnly };
  // A previous bot response is a useful boundary: older conversation remains
  // available as background, but is not presumed to be an unanswered request.
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

export function formatConversationFocus(rows: MessageRow[]): string {
  return rows.map((row)=>{
    const speaker=row.direction==='out'?'机器人':`${row.sender_name || '群友'} [${row.sender_id}]`;
    const content=row.content.length>700?`${row.content.slice(0,350)} … [本条节选，完整原文见历史] … ${row.content.slice(-250)}`:row.content;
    const attachments=row.attachments==='[]'?'':` 附件信息：${row.attachments.slice(0,300)}${row.attachments.length>300?'…':''}`;
    return `[${row.timestamp} · 近期互动] ${speaker}：${content}${attachments}`;
  }).join('\n');
}
