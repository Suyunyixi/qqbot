import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { workspaceFor } from '../storage/workspace.js';

function privateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return privateAddress(ip.slice(7));
  if (isIP(ip) === 6) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip);
  if (isIP(ip) !== 4) return true;
  const parts = ip.split('.').map(Number); const a = parts[0] ?? 0; const b = parts[1] ?? 0;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export async function validateUrl(value: string): Promise<URL> {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持公开 HTTP(S) 网页');
  if (url.hostname.toLowerCase() === 'localhost') throw new Error('不允许访问本机地址');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('不允许访问内网或本机地址');
  return url;
}
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, token: string) => {
    if (token.startsWith('#')) { const n = token[1]?.toLowerCase() === 'x' ? Number.parseInt(token.slice(2), 16) : Number.parseInt(token.slice(1), 10); return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match; }
    return named[token.toLowerCase()] ?? match;
  });
}
async function fetchPublic(address: string, timeout = 30000): Promise<{url: URL; response: Response}> {
  let url = await validateUrl(address);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 4; redirects++) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QQHarnessBot/0.1)' } });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location'); if (!location) throw new Error('网页重定向缺少目标');
    url = await validateUrl(new URL(location, url).toString()); response = undefined;
  }
  if (!response || !response.ok || !response.body) throw new Error(`网页请求失败：HTTP ${response?.status ?? '重定向过多'}`);
  return { url, response };
}
function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}
function absoluteUrl(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value, base); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
export async function readPublicWebpage(address: string, offset = 0): Promise<{ url: string; text: string; nextOffset?: number; title?: string; publishedAt?: string; images?: string[]; contentType: string; fetchedAt: string; truncated: boolean }> {
  const {url,response} = await fetchPublic(address);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/(html|plain)|application\/(xhtml\+xml|json|[a-z.+-]+\+json)/i.test(type)) throw new Error(`该地址是 ${type || '文件'}，请使用 download_file 保存到工作区`);
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  let truncated = false;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); truncated = true; break; } chunks.push(value); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const html = /html|xhtml/i.test(type);
  const title = html ? decodeEntities(raw.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g,' ').trim() ?? '') || undefined : undefined;
  let publishedAt: string | undefined; const imageSet = new Set<string>();
  if (html) {
    for (const tag of raw.match(/<meta\b[^>]*>/gi) ?? []) {
      const key=(attribute(tag,'property') ?? attribute(tag,'name') ?? '').toLowerCase(); const value=attribute(tag,'content');
      if (!publishedAt && ['article:published_time','date','pubdate','publishdate','datepublished','dc.date'].includes(key)) publishedAt=value;
      if (['og:image','twitter:image','twitter:image:src'].includes(key)) { const src=absoluteUrl(value,url); if(src)imageSet.add(src); }
    }
    for (const tag of (raw.match(/<img\b[^>]*>/gi) ?? []).slice(0,100)) { const src=absoluteUrl(attribute(tag,'data-src') ?? attribute(tag,'src'),url); if(src)imageSet.add(src); if(imageSet.size>=20)break; }
    if (!publishedAt) publishedAt = raw.match(/<time\b[^>]*datetime\s*=\s*["']([^"']+)/i)?.[1];
  }
  const text = html ? decodeEntities(raw.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : raw;
  const start = Math.max(0, Math.floor(offset)); const result = text.slice(start, start + 12000);
  return { url:url.toString(),text:result,nextOffset:start + result.length < text.length ? start + result.length : undefined,title,publishedAt,images:[...imageSet].slice(0,20),contentType:type,fetchedAt:new Date().toISOString(),truncated };
}

export async function downloadPublicFile(conversationId: string, address: string, desiredName?: string) {
  const {url,response}=await fetchPublic(address,120000); const max=100*1024*1024;
  if (Number(response.headers.get('content-length') ?? 0)>max) throw new Error('文件超过 100 MB 下载上限');
  const contentType=(response.headers.get('content-type')??'application/octet-stream').split(';')[0]!;
  const fallback=decodeURIComponent(path.posix.basename(url.pathname)) || 'download';
  let name=(desiredName || fallback).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,160) || 'download';
  if (!path.extname(name)) { const ext:Record<string,string>={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','image/svg+xml':'.svg','application/json':'.json','application/pdf':'.pdf'}; name+=ext[contentType]??''; }
  const dir=path.join(workspaceFor(conversationId),'downloads',randomUUID());fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,name);
  const out=await fs.promises.open(file,'wx',0o600); const reader=response.body!.getReader(); let size=0;const hash=createHash('sha256');
  try { for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw new Error('文件超过 100 MB 下载上限');}hash.update(value);let offset=0;while(offset<value.length){const result=await out.write(value,offset,value.length-offset);if(!result.bytesWritten)throw new Error('文件写入失败');offset+=result.bytesWritten;}} }
  catch(error){await out.close();await fs.promises.unlink(file).catch(()=>{});throw error;}
  await out.close(); if(!size){await fs.promises.unlink(file).catch(()=>{});throw new Error('下载文件为空');}
  return {path:file,size,contentType,source:url.toString(),sha256:hash.digest('hex'),fetchedAt:new Date().toISOString()};
}
