import type { IncomingMessage, ServerResponse } from 'node:http';
import { persona } from '../agent/runtime.js';
import { Store } from '../storage/store.js';
import type { Harness } from '../agent/harness.js';
import { groupSettings, groupSettingsSchema } from '../config/group.js';
import { toolPermissions } from '../tools/sandbox.js';
import { z } from 'zod';
import { readConfig, runtimeOverrideSchema } from '../config/settings.js';
import { registeredPlugins, reloadPlugins } from '../tools/plugins.js';
import { makeTools } from '../tools/registry.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { TaskManager } from '../agent/task-manager.js';

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

async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) { text += String(chunk); if (Buffer.byteLength(text) > 128000) throw new Error('内容过长'); }
  return JSON.parse(text || '{}') as unknown;
}
const id = z.string().min(1).max(300);
/** Local management API; mutating calls require a same-origin browser request. */
export async function handleAdmin(req: IncomingMessage, res: ServerResponse, store: Store, harness: Harness | undefined): Promise<void> {
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host)) { json(res, 403, { error: '管理接口仅允许本机访问' }); return; }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' && (req.headers.origin !== `http://${host}` || !req.headers['content-type']?.startsWith('application/json'))) { json(res, 403, { error: '请求来源无效' }); return; }
  try {
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      const rows = store.db.prepare(`SELECT conversation_id,scope,COUNT(*) AS message_count,MAX(timestamp) AS last_activity FROM messages GROUP BY conversation_id,scope ORDER BY MAX(seq) DESC LIMIT 500`).all() as Array<{conversation_id:string;scope:string;message_count:number;last_activity:string}>;
      json(res, 200, { conversations: rows.map((row) => ({ ...row, settings: ['group','guild'].includes(row.scope) ? groupSettings(store, row.conversation_id) : undefined })) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const conversationId = id.parse(url.searchParams.get('conversationId'));
      const before = z.coerce.number().int().positive().parse(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      const query = z.string().max(200).parse(url.searchParams.get('q') ?? '');
      const rows = store.db.prepare("SELECT seq,id,scope,sender_id,sender_name,content,timestamp,direction,attachments,is_mention,raw FROM messages WHERE conversation_id=? AND seq<? AND (instr(content,?)>0 OR instr(COALESCE(sender_name,''),?)>0) ORDER BY seq DESC LIMIT 101").all(conversationId,before,query,query) as Array<Record<string, unknown>>;
      const hasMore=rows.length>100; const page=rows.slice(0,100);
      json(res, 200, { hasMore, nextBefore:hasMore ? page[page.length-1]?.seq : null, messages: page.reverse().map(({raw, ...row}) => { let eventType: unknown; try { eventType = typeof raw === 'string' ? (JSON.parse(raw) as {rawEventType?:unknown}).rawEventType : undefined; } catch { /* older record */ } return { ...row, eventType }; }) }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tools') { json(res, 200, { tools: Object.keys(toolPermissions).filter((name) => !name.startsWith('owner_')).sort() }); return; }
    if (req.method === 'GET' && url.pathname === '/api/plugins') { json(res,200,{plugins:registeredPlugins().map((item)=>({name:item.name,permissions:item.permissions}))});return; }
    if (req.method === 'POST' && url.pathname === '/api/plugins/reload') {
      const items=await reloadPlugins(undefined,(candidates)=>{
        const probe=new Store(':memory:');const reply=new ReplyRuntime(probe,{send:async()=>({})});const tasks=new TaskManager(probe,async()=>'',async()=>{});
        try {for(const background of [false,true])makeTools({conversationId:'_plugin_check',scope:'group',store:probe,reply,tasks,background,taskId:background?'00000000-0000-4000-8000-000000000000':undefined},candidates);}
        finally {tasks.stop();probe.close();}
      });
      json(res,200,{plugins:items.map((item)=>({name:item.name,permissions:item.permissions}))});return;
    }
    if (req.method === 'GET' && url.pathname === '/api/qq-events') { json(res,200,{events:store.db.prepare('SELECT seq,event_type,payload,received_at FROM qq_events ORDER BY seq DESC LIMIT 100').all()});return; }
    if (req.method === 'GET' && url.pathname === '/api/runtime-config') {
      const config=readConfig(); const {apiKey,...model}=config.model;
      json(res,200,{model,apiKeyConfigured:!!apiKey,memory:config.memory,tasks:config.tasks,tools:{search:config.tools.search,media:config.tools.media,python:config.tools.python}});return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/runtime-config') {
      const input=runtimeOverrideSchema.parse(await body(req));
      const existing=runtimeOverrideSchema.parse(JSON.parse(store.getAppSetting('runtime_config') ?? '{}'));
      for(const section of ['model','memory','tasks','tools'] as const) if(input[section]) Object.assign(existing[section] ?? (existing[section]={}),input[section]);
      store.setAppSetting('runtime_config',JSON.stringify(existing));json(res,200,{ok:true,effective:'next-turn'});return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/runtime-config') {store.db.prepare("DELETE FROM app_settings WHERE key='runtime_config'").run();json(res,200,{ok:true,effective:'next-turn'});return;}
    if (req.method === 'PUT' && url.pathname === '/api/group') {
      const input = z.object({ conversationId: id, settings: groupSettingsSchema }).parse(await body(req));
      if (!store.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND scope IN ('group','guild') LIMIT 1").get(input.conversationId)) throw new Error('群聊或频道不存在');
      store.setSetting(input.conversationId, 'groupSettings', JSON.stringify(input.settings)); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/identities') { json(res, 200, { identities: store.memory.listIdentities(), owner: store.memory.owner() }); return; }
    if (req.method === 'POST' && url.pathname === '/api/identities/link') {
      const input = z.object({ source: id, target: id }).parse(await body(req)); store.memory.link(input.source, input.target); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/identities/detach') {
      const input = z.object({ scope:z.enum(['group','c2c','guild','dm']), conversationId:id, externalId:id }).parse(await body(req));
      json(res, 200, { userId: store.memory.detach(input.scope, input.conversationId, input.externalId) }); return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/identities/owner') {
      const input = z.object({ userId: id }).parse(await body(req)); store.memory.setOwner(input.userId); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/memories') { json(res, 200, { memories: store.memory.list() }); return; }
    if (req.method === 'GET' && url.pathname === '/api/memories/legacy') { json(res, 200, { memories:store.memory.unresolvedLegacy() }); return; }
    if (req.method === 'POST' && url.pathname === '/api/memories/legacy') {
      const input=z.object({id,type:z.enum(['user','group']),subjectId:id,content:z.string().min(1).max(2000).optional()}).parse(await body(req));
      json(res,200,{id:store.memory.resolveLegacy(input.id,input.type,input.subjectId,input.content)}); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/memories') {
      const input = z.object({ type: z.enum(['user','group']), subjectId: id, content: z.string().min(1).max(2000), conversationId: id }).parse(await body(req));
      if (input.type === 'user' && !store.memory.listIdentities().some((entry) => entry.user_id === input.subjectId)) throw new Error('用户身份不存在');
      if (input.type === 'group' && !store.db.prepare("SELECT 1 FROM messages WHERE scope IN ('group','guild') AND conversation_id=?").get(input.subjectId)) throw new Error('群聊或频道不存在');
      json(res, 200, { id: store.memory.add(input.type, input.subjectId, input.content, input.conversationId) }); return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/memories') {
      const input = z.object({ id, content: z.string().min(1).max(2000) }).parse(await body(req)); if (!store.memory.edit(input.id, input.content)) throw new Error('记忆不存在'); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/memories') {
      const input = z.object({ id }).parse(await body(req)); if (!store.memory.delete(input.id)) throw new Error('记忆不存在'); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const tasks = store.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200').all();
      const progress = store.db.prepare('SELECT task_id,content,created_at,sent FROM task_progress ORDER BY created_at DESC LIMIT 500').all();
      json(res, 200, { tasks, progress }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks/action') {
      if (!harness) throw new Error('机器人运行时尚未启动');
      const input = z.object({ id, action: z.enum(['cancel','retry','update']), instruction: z.string().max(5000).optional() }).parse(await body(req));
      const task = store.task(input.id); if (!task) throw new Error('任务不存在');
      const result = input.action === 'cancel' ? harness.tasks.cancel(input.id, task.conversation_id) : input.action === 'retry' ? harness.tasks.retry(input.id) : harness.tasks.update(input.id, task.conversation_id, z.string().min(1).parse(input.instruction));
      json(res, 200, { ok: true, result }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/deliveries') {
      const deliveries = store.db.prepare('SELECT id,conversation_id,scope,kind,file_name,status,error,created_at,updated_at FROM outbox ORDER BY created_at DESC LIMIT 200').all(); json(res, 200, { deliveries }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/deliveries/retry') {
      if (!harness) throw new Error('机器人运行时尚未启动');
      const input = z.object({ id, conversationId: id }).parse(await body(req)); await harness.reply.retry(input.conversationId, input.id); json(res, 200, { ok: true }); return;
    }
    json(res, 404, { error: '接口不存在' });
  } catch (error) { json(res, 400, { error: error instanceof Error ? error.message : '请求无效' }); }
}
