/** 读取 QQ 事件中明确提供的引用原文，包括数据库保存的原始事件。 */
export function quotedMessage(raw: unknown): string | undefined {
  if(typeof raw==='string')try {raw=JSON.parse(raw) as unknown;} catch {return undefined;}
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as { msgElements?: unknown; refMsgIdx?: unknown; msgType?: unknown; raw?: { msg_elements?: unknown; ref_msg_idx?: unknown; message_type?: unknown; parallel_message?: {msg_nodes?:unknown} } };
  const elements = Array.isArray(event.msgElements) ? event.msgElements : Array.isArray(event.raw?.msg_elements) ? event.raw.msg_elements : [];
  const reference = typeof event.refMsgIdx === 'string' ? event.refMsgIdx : event.raw?.ref_msg_idx;
  const texts = elements.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as { message_type?: unknown; msg_idx?: unknown; content?: unknown };
    if (item.message_type !== 103 && (!reference || item.msg_idx !== reference)) return [];
    return typeof item.content === 'string' && item.content.trim() ? [item.content.trim()] : [];
  });
  if (texts.length) return texts.join('\n');
  // QQ 的引用消息还可能通过 parallel_message 提供被引用内容。
  if (event.msgType !== 103 && event.raw?.message_type !== 103 && !reference) return undefined;
  const nodes=event.raw?.parallel_message?.msg_nodes;
  if(!Array.isArray(nodes)) return undefined;
  const parallel=nodes.flatMap((node:unknown)=>node && typeof node==='object' && 'content' in node && typeof node.content==='string' && node.content.trim()?[node.content.trim()]:[]);
  return parallel.length?parallel.join('\n'):undefined;
}
/** 只返回 QQ 事件明确提供的引用标识，不从文本猜测。 */
export function quotedMessageId(raw:unknown):string|undefined {
  if(!raw || typeof raw!=='object')return undefined;
  const event=raw as {refMsgIdx?:unknown;raw?:{ref_msg_idx?:unknown}};
  const id=event.refMsgIdx ?? event.raw?.ref_msg_idx;
  return typeof id==='string' && id.trim()?id:undefined;
}

/** QQ 事件有时直接附带被引用消息的媒体，不要求引用消息已在本地保存。 */
export function quotedMessageAttachments(raw:unknown):unknown[] {
  if(typeof raw==='string')try {raw=JSON.parse(raw) as unknown;} catch {return [];}
  if(!raw || typeof raw!=='object')return [];
  const event=raw as {msgType?:unknown;refMsgIdx?:unknown;msgElements?:unknown;raw?:{message_type?:unknown;ref_msg_idx?:unknown;msg_elements?:unknown;parallel_message?:{msg_nodes?:unknown}}};
  const ref=typeof event.refMsgIdx==='string'?event.refMsgIdx:event.raw?.ref_msg_idx;
  const isQuote=event.msgType===103 || event.raw?.message_type===103 || typeof ref==='string';
  if(!isQuote)return [];
  const elements=Array.isArray(event.msgElements)?event.msgElements:Array.isArray(event.raw?.msg_elements)?event.raw.msg_elements:[];
  const nodes=event.raw?.parallel_message?.msg_nodes;
  const matched=elements.filter((item:unknown)=>item && typeof item==='object' && (('message_type' in item && item.message_type===103) || ('msg_idx' in item && item.msg_idx===ref)));
  const candidates=[...(matched.length?matched:elements.slice(0,1)),...(Array.isArray(nodes)?nodes:[])];
  return candidates.flatMap((value:unknown)=>{
    if(!value || typeof value!=='object' || !('attachments' in value) || !Array.isArray(value.attachments))return [];
    return value.attachments.filter((item:unknown)=>item && typeof item==='object');
  });
}
