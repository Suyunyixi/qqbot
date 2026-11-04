import type { MessageRow } from '../../storage/store.js';

interface Attachment { url?: string; content_type?: string; asr_refer_text?: string; filename?: string }
function typed(items: unknown[]): Attachment[] { return items.filter((x): x is Attachment => typeof x === 'object' && x !== null); }
export function voiceTranscripts(items: unknown[]): string[] {
  return typed(items).map((a) => a.asr_refer_text?.trim()).filter((x): x is string => !!x);
}
export function imageAttachments(current: unknown[], recent: MessageRow[], content: string): Attachment[] {
  let selected = typed(current).filter((a) => a.content_type?.toLowerCase().startsWith('image/') && a.url);
  if (!selected.length && /图片|照片|截图|上面|上张|这张|看看|图里/.test(content)) {
    for (const row of [...recent].reverse()) {
      try { selected = typed(JSON.parse(row.attachments) as unknown[]).filter((a) => a.content_type?.toLowerCase().startsWith('image/') && a.url); } catch { /* old malformed metadata */ }
      if (selected.length) break;
    }
  }
  return selected.slice(0, 3);
}
export async function qqImageDataUrl(attachment: Attachment): Promise<string> {
  const raw = attachment.url ?? '';
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  const host = url.hostname.toLowerCase();
  const allowed = ['qq.com', 'qpic.cn', 'qlogo.cn', 'gtimg.com', 'qq.com.cn'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) throw new Error('图片地址不是受支持的 QQ 媒体地址');
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`图片下载失败：HTTP ${response.status}`);
  const type = (response.headers.get('content-type') ?? attachment.content_type ?? '').split(';')[0]!.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw new Error(`不支持图片格式 ${type}`);
  const max = 10 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error('图片超过 10MB');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new Error('图片超过 10MB'); } chunks.push(value); }
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
}
