/** 读取 QQ 事件中明确提供的引用原文，包括数据库保存的原始事件。 */
export function quotedMessage(raw: unknown): string | undefined {
  if(typeof raw==='string')try {raw=JSON.parse(raw) as unknown;} catch {return undefined;}
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as { msgElements?: unknown; refMsgIdx?: unknown; raw?: { msg_elements?: unknown; ref_msg_idx?: unknown } };
  const elements = Array.isArray(event.msgElements) ? event.msgElements : Array.isArray(event.raw?.msg_elements) ? event.raw.msg_elements : [];
  const reference = typeof event.refMsgIdx === 'string' ? event.refMsgIdx : event.raw?.ref_msg_idx;
  const texts = elements.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as { message_type?: unknown; msg_idx?: unknown; content?: unknown };
    if (item.message_type !== 103 && (!reference || item.msg_idx !== reference)) return [];
    return typeof item.content === 'string' && item.content.trim() ? [item.content.trim()] : [];
  });
  return texts.length ? texts.join('\n') : undefined;
}
/** 只返回 QQ 事件明确提供的引用标识，不从文本猜测。 */
export function quotedMessageId(raw:unknown):string|undefined {
  if(!raw || typeof raw!=='object')return undefined;
  const event=raw as {refMsgIdx?:unknown;raw?:{ref_msg_idx?:unknown}};
  const id=event.refMsgIdx ?? event.raw?.ref_msg_idx;
  return typeof id==='string' && id.trim()?id:undefined;
}
