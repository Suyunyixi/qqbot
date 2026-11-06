import type { MessageRow } from '../../storage/store.js';

interface Attachment { url?: string; content_type?: string; asr_refer_text?: string; filename?: string }
function typed(items: unknown[]): Attachment[] { return items.filter((x): x is Attachment => typeof x === 'object' && x !== null); }
export function attachmentSummary(value:unknown):string {
  let items=value;
  if(typeof value==='string')try {items=JSON.parse(value) as unknown;} catch {return '附件信息无法解析';}
  if(!Array.isArray(items))return '';
  return items.flatMap((value,index)=>value && typeof value==='object'?[{序号:index,类型:(value as Attachment).content_type ?? '未知',文件名:(value as Attachment).filename ?? '',语音文本:(value as Attachment).asr_refer_text ?? ''}]:[]).map((item)=>JSON.stringify(item)).join('；');
}
export function voiceTranscripts(items: unknown[]): string[] {
  return typed(items).map((a) => a.asr_refer_text?.trim()).filter((x): x is string => !!x);
}
export function imageAttachments(current: unknown[], recent: MessageRow[], _content: string, _timestamp?:string, _windowSeconds=180): Attachment[] {
  let selected = typed(current).filter((a) => a.content_type?.toLowerCase().startsWith('image/') && a.url);
  if (!selected.length) {
    let lastReply=-1;for(let i=recent.length-1;i>=0;i--)if(recent[i]!.direction==='out'){lastReply=i;break;}
    for (const row of recent.slice(lastReply+1)) {
      try { selected.push(...typed(JSON.parse(row.attachments) as unknown[]).filter((a) => a.content_type?.toLowerCase().startsWith('image/') && a.url)); } catch { /* 兼容早期格式异常的附件信息。 */ }
    }
  }
  return selected.slice(-3);
}
export async function qqAttachmentResponse(attachment: Attachment,timeoutMs=20000): Promise<Response> {
  const raw = attachment.url ?? '';
  const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  const host = url.hostname.toLowerCase();
  const allowed = ['qq.com', 'qpic.cn', 'qlogo.cn', 'gtimg.com', 'qq.com.cn'].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) throw new Error('附件地址不是受支持的 QQ 媒体地址');
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`附件下载失败：HTTP ${response.status}`);
  return response;
}
export async function qqImageDataUrl(attachment: Attachment): Promise<string> {
  const response=await qqAttachmentResponse(attachment);
  const type = (response.headers.get('content-type') ?? attachment.content_type ?? '').split(';')[0]!.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) throw new Error(`不支持图片格式 ${type}`);
  const max = 10 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error('图片超过 10MB');
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { await reader.cancel(); throw new Error('图片超过 10MB'); } chunks.push(value); }
  return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
}
