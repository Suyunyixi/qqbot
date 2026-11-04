import type { IncomingMessage, ServerResponse } from 'node:http';
import { persona } from '../agent/runtime.js';
import type { Store } from '../storage/store.js';

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
/** Management is local-only, with origin validation for mutations. */
export async function handlePersona(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) { json(res, 403, { error: '管理接口仅允许通过本机地址访问' }); return; }
  if (req.method === 'GET') { json(res, 200, { persona: persona(store) }); return; }
  if (req.method !== 'PUT') { json(res, 405, { error: '方法不支持' }); return; }
  if (req.headers.origin !== `http://${host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '请求来源无效' }); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 128000) throw new Error('内容过长'); }
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || !('persona' in parsed) || typeof parsed.persona !== 'string' || !parsed.persona.trim() || parsed.persona.length > 30000) throw new Error('人格内容必须为 1 至 30000 个字符');
    store.setAppSetting('persona', parsed.persona);
    json(res, 200, { ok: true });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '内容无效' }); }
}
