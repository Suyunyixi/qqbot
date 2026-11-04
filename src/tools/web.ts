import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith('::ffff:')) return privateAddress(ip.slice(7));
  if (isIP(ip) === 6) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || /^fe[89ab]/.test(ip);
  if (isIP(ip) !== 4) return true;
  const parts = ip.split('.').map(Number); const a = parts[0] ?? 0; const b = parts[1] ?? 0;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
async function validateUrl(value: string): Promise<URL> {
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
export async function readPublicWebpage(address: string, offset = 0): Promise<{ url: string; text: string; nextOffset?: number }> {
  let url = await validateUrl(address);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 4; redirects++) {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QQHarnessBot/0.1)' } });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location'); if (!location) throw new Error('网页重定向缺少目标');
    url = await validateUrl(new URL(location, url).toString()); response = undefined;
  }
  if (!response || !response.ok || !response.body) throw new Error(`网页请求失败：HTTP ${response?.status ?? '重定向过多'}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(type)) throw new Error(`不支持该网页类型：${type}`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); break; } chunks.push(value); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const text = decodeEntities(raw.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, Math.floor(offset)); const result = text.slice(start, start + 12000);
  return { url: url.toString(), text: result, nextOffset: start + result.length < text.length ? start + result.length : undefined };
}
