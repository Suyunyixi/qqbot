import type { MessageRow } from '../storage/store.js';
import { attachmentSummary } from '../platform/qq/attachments.js';
import { quotedMessage, quotedMessageAttachments } from './quoted-message.js';

/** 保留来源时间和时区，并提供统一时区供会话中的时间比较。 */
export function messageTime(timestamp:string):string {
  const date=new Date(timestamp);
  if(!Number.isFinite(date.getTime()))return timestamp;
  const zone=process.env.TZ || 'Asia/Shanghai';
  try {
    const local=new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(date);
    return `${timestamp}；${zone} ${local}`;
  } catch {return timestamp;}
}

/** 所有读取入口共用同一份消息内容，避免正文、引用或附件信息不一致。 */
export function messageDetails(row:Pick<MessageRow,'id'|'content'|'attachments'|'raw'|'is_mention'>) {
  return {messageId:row.id,content:row.content,quotedContent:quotedMessage(row.raw),attachments:row.attachments==='[]'?'':attachmentSummary(row.attachments),quotedAttachments:attachmentSummary(quotedMessageAttachments(row.raw)),mentionedBot:row.is_mention===undefined?undefined:row.is_mention===1};
}

export function renderMessage(row:MessageRow, options:{marker?:string;contentLimit?:number;attachmentLimit?:number}={}):string {
  const item=messageDetails(row);
  const speaker=row.sender_name ? `${row.sender_name} [${row.sender_id}]` : row.sender_id;
  const limit=options.contentLimit;
  const content=limit && item.content.length>limit ? `${item.content.slice(0,Math.floor(limit/2))} … [本条节选，可按消息标识读取原文] … ${item.content.slice(-Math.floor(limit/2))}` : item.content;
  const attachment=options.attachmentLimit ? item.attachments.slice(0,options.attachmentLimit) : item.attachments;
  return `[${messageTime(row.timestamp)}${options.marker ? ` · ${options.marker}` : ''}] ${row.direction==='out'?'【机器人本人】':'【用户】'} ${speaker}${item.mentionedBot?'（@机器人）':''}：${content}\n  消息标识:${row.id}${item.quotedContent?`\n  该消息引用的原文：${item.quotedContent}`:''}${attachment?`\n  附件消息标识:${row.id} 附件:${attachment}`:''}${item.quotedAttachments?`\n  引用附件（原作者未知，读取图片时 source 为 quote）：${item.quotedAttachments}`:''}`;
}

/** 按完整消息保留最新记录，超长消息保留标识，方便模型读取原文。 */
export function renderMessages(rows:MessageRow[],budget:number):string {
  const selected:string[]=[];let used=0;let omitted=false;
  for(let index=rows.length-1;index>=0;index--) {
    const row=rows[index]!;const rendered=renderMessage(row);
    if(used+rendered.length+(selected.length?1:0)<=budget) {selected.push(rendered);used+=rendered.length+1;continue;}
    omitted=true;
    if(!selected.length) {
      const prefix=`[${messageTime(row.timestamp)}] ${row.direction==='out'?'【机器人本人】':'【用户】'} ${row.sender_name || row.sender_id} [${row.sender_id}] 消息标识:${row.id}（内容过长，仅显示尾部；可按消息标识读取原文）：\n`;
      const available=Math.max(0,budget-prefix.length);
      selected.push(prefix+(available?rendered.slice(-available):''));
    }
    break;
  }
  return `${omitted?'[更早消息或超长内容未完整显示，可查询原文]\n':''}${selected.reverse().join('\n')}`;
}
