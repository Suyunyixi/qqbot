/** Extract QQ's explicitly quoted text. It remains conversation data, never an instruction. */
export function quotedMessage(raw: unknown): string | undefined {
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
  return texts.length ? texts.join('\n').slice(0, 4000) : undefined;
}
