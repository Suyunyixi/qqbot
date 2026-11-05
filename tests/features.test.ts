import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { InboundEvent } from '../src/domain/types.js';
import { ToolMessage } from '@langchain/core/messages';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-features-'));
const { initConfig, readConfig, setRuntimeConfigProvider } = await import('../src/config/settings.js'); initConfig();
const { Store } = await import('../src/storage/store.js');
const { Harness } = await import('../src/agent/harness.js');
const { ReplyRuntime } = await import('../src/delivery/reply.js');
const { TaskManager } = await import('../src/agent/task-manager.js');
const { makeTools } = await import('../src/tools/registry.js');
const { workspaceFor } = await import('../src/storage/workspace.js');
const { handleAdmin } = await import('../src/admin/api.js');
const { searchWeb } = await import('../src/tools/search.js');
const { recentSocialContext } = await import('../src/agent/social-context.js');
const { hasEvidence, needsCurrentResearch } = await import('../src/agent/research-gate.js');
function event(group:string,user:string,id:string): InboundEvent { return { id,conversationId:group,scope:'group',senderId:user,senderName:user,content:'消息',timestamp:new Date().toISOString(),isMention:false,attachments:[] }; }

describe('全局用户记忆和创建者权限', () => {
  it('只突出指定时间窗口里的群友发言，并保留发言人和时间', () => {
    const now=Date.now();const rows=[{seq:1,id:'old',sender_id:'a',sender_name:'小王',content:'久远聊天',timestamp:new Date(now-600000).toISOString(),direction:'in',attachments:'[]'},{seq:2,id:'new',sender_id:'b',sender_name:'小李',content:'最近的纠正',timestamp:new Date(now-15000).toISOString(),direction:'in',attachments:'[]'}];
    const text=recentSocialContext(rows,now,180);expect(text).toContain('小李');expect(text).toContain('最近的纠正');expect(text).not.toContain('久远聊天');
  });
  it('同一用户跨群共享用户记忆，群记忆只在所属群可见', () => {
    const store=new Store(':memory:');store.record(event('group-a','member-a','1'));store.record(event('group-b','member-a','2'));store.record(event('group-b','member-b','3'));
    const user=store.memory.lookup('group','group-a','member-a')!;
    expect(store.memory.lookup('group','group-b','member-a')).toBe(user);
    store.memory.add('user',user,'喜欢猫','group-a');store.memory.add('group','group-a','群项目 A','group-a');
    expect(store.memory.context('group','group-b',['member-a']).map((m)=>m.content)).toEqual(['喜欢猫']);
    expect(store.memory.context('group','group-b',['member-b'])).toEqual([]);
    expect(store.memory.context('group','group-a',['member-a']).map((m)=>m.content)).toContain('群项目 A');
    store.close();
  });
  it('扫码身份可成为创建者，群身份必须关联后才获得权限；普通用户工具不含创建者工具', () => {
    const store=new Store(':memory:');store.saveQQCredentials({appId:'app',appSecret:'secret',userOpenid:'owner-c2c'});store.record(event('g','owner-member','1'));store.record(event('g','other-member','2'));
    expect(store.memory.isOwner('group','g','owner-member')).toBe(false);
    const groupUser=store.memory.lookup('group','g','owner-member')!;const owner=store.memory.lookup('c2c','owner-c2c','owner-c2c')!;
    store.memory.add('user',groupUser,'创建者偏好','g');store.memory.link(groupUser,owner);
    expect(store.memory.isOwner('group','g','owner-member')).toBe(true);expect(store.memory.isOwner('group','g','other-member')).toBe(false);
    expect(store.memory.list('user',owner).map((m)=>m.content)).toContain('创建者偏好');
    const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const base={conversationId:'g',scope:'group' as const,store,reply,tasks,background:false};
    expect(makeTools({...base,owner:false}).some((t)=>t.name==='owner_set_persona')).toBe(false);
    expect(makeTools({...base,owner:true}).some((t)=>t.name==='owner_set_persona')).toBe(true);
    const api=vi.fn(async()=>({ok:true}));
    expect(makeTools({...base,owner:false,qqApi:api}).some((t)=>t.name==='owner_qq_api')).toBe(false);
    expect(makeTools({...base,background:true,owner:true,qqApi:api}).some((t)=>t.name==='owner_qq_api')).toBe(true);
    store.memory.detach('group','g','owner-member');
    expect(store.memory.isOwner('group','g','owner-member')).toBe(false);
    expect(store.memory.isOwner('c2c','owner-c2c','owner-c2c')).toBe(true);
    expect(store.memory.list('user',owner).map((m)=>m.content)).toContain('创建者偏好');
    tasks.stop();store.close();
  });
  it('关闭群回复后仍持久化普通消息', async () => {
    const store=new Store(':memory:');store.setSetting('quiet','groupSettings',JSON.stringify({enabled:false,keywords:['你好'],persona:'',disabledTools:[]}));
    const send=vi.fn(async()=>({}));const harness=new Harness(store,{send});
    expect(await harness.receive({...event('quiet','u','1'),isMention:true,content:'你好'})).toBe(false);
    expect(store.recent('quiet',10)).toHaveLength(1);expect(send).not.toHaveBeenCalled();harness.stop();store.close();
  });
  it('普通用户明确要求记住时立即保存自己的跨群记忆', async () => {
    const store=new Store(':memory:');store.record(event('g1','member','1'));store.record(event('g2','member','2'));
    const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const remember=makeTools({conversationId:'g1',scope:'group',actorId:'member',owner:false,store,reply,tasks,background:false}).find((item)=>item.name==='remember_fact')!;
    expect(JSON.parse(String(await remember.invoke({type:'self',content:'喜欢猫'}))).ok).toBe(true);
    expect(store.memory.context('group','g2',['member']).map((m)=>m.content)).toContain('喜欢猫');
    tasks.stop();store.close();
  });
  it('无法对应用户的旧记忆保留原表，不错误变成群记忆', () => {
    const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-migration-')),'history.sqlite');
    const first=new Store(file);first.record(event('g','known','1'));
    first.addMemory('g','旧用户记忆','unknown',1,1);
    first.db.prepare("DELETE FROM app_settings WHERE key='subject_memories_migrated'").run();first.close();
    const reopened=new Store(file);
    expect(reopened.memory.list('group','g')).toEqual([]);
    expect(reopened.memories('g').map((m)=>m.content)).toContain('旧用户记忆');
    const old=reopened.memory.unresolvedLegacy()[0]!;
    const resolved=reopened.memory.resolveLegacy(old.id,'user',reopened.memory.lookup('group','g','known')!);
    expect(reopened.memory.unresolvedLegacy()).toEqual([]);
    expect(reopened.memory.list('user',reopened.memory.lookup('group','g','known')!).map((m)=>m.content)).toContain('旧用户记忆');
    reopened.close();
    const again=new Store(file);expect(again.memory.list().some((m)=>m.id===resolved)).toBe(true);again.close();
  });
});

describe('管理页面接口', () => {
  it('展示并动态修改群配置和记忆，拒绝跨站写入', async () => {
    const store=new Store(':memory:');store.record(event('g','u','1'));
    const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    setRuntimeConfigProvider(()=>store.getAppSetting('runtime_config'));
    const address=server.address();if(!address||typeof address==='string')throw Error('listen');const origin=`http://127.0.0.1:${address.port}`;
    try {
      const settings={label:'测试群',enabled:true,keywords:['唤醒'],persona:'轻松',disabledTools:['web_search']};
      const bad=await fetch(origin+'/api/group',{method:'PUT',headers:{Origin:'http://evil.example','Content-Type':'application/json'},body:JSON.stringify({conversationId:'g',settings})});expect(bad.status).toBe(403);
      const ok=await fetch(origin+'/api/group',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({conversationId:'g',settings})});expect(ok.status).toBe(200);
      const groups=await (await fetch(origin+'/api/conversations')).json() as {conversations:Array<{settings:{label:string}}>};expect(groups.conversations[0]?.settings.label).toBe('测试群');
      const user=store.memory.lookup('group','g','u')!;
      const create=await fetch(origin+'/api/memories',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({type:'user',subjectId:user,content:'喜欢音乐',conversationId:'g'})});expect(create.status).toBe(200);
      const memories=await (await fetch(origin+'/api/memories')).json() as {memories:Array<{content:string}>};expect(memories.memories[0]?.content).toBe('喜欢音乐');
      for(let i=0;i<115;i++)store.record({...event('g','u',`history-${i}`),content:`测试记录 ${i}`});
      const page1=await (await fetch(origin+'/api/messages?conversationId=g&q='+encodeURIComponent('测试记录'))).json() as {messages:Array<{content:string}>;hasMore:boolean;nextBefore:number};
      expect(page1.messages).toHaveLength(100);expect(page1.hasMore).toBe(true);
      const page2=await (await fetch(origin+'/api/messages?conversationId=g&q='+encodeURIComponent('测试记录')+'&before='+page1.nextBefore)).json() as {messages:Array<{content:string}>};
      expect(page2.messages).toHaveLength(15);expect(page2.messages[0]?.content).toBe('测试记录 0');
      const save=await fetch(origin+'/api/runtime-config',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({model:{name:'new-model',apiKey:'test-secret'}})});expect(save.status).toBe(200);
      expect(readConfig().model.name).toBe('new-model');expect(readConfig().model.apiKey).toBe('test-secret');
      const visible=await (await fetch(origin+'/api/runtime-config')).text();expect(visible).not.toContain('test-secret');expect(visible).toContain('new-model');
    } finally {setRuntimeConfigProvider(undefined);await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
});

describe('完整媒体交付', () => {
  it('本地文件先发送后说明，发送失败保留文件并记录失败', async () => {
    const store=new Store(':memory:');const delivered:string[]=[];const reply=new ReplyRuntime(store,{send:async(item)=>{delivered.push(item.kind);return {id:'ok'}}});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const file=path.join(workspaceFor('g-media'),'demo.bin');fs.writeFileSync(file,'sample');
    const tool=makeTools({conversationId:'g-media',scope:'group',store,reply,tasks,background:true,taskId:'job'}).find((x)=>x.name==='deliver_media')!;
    const value=JSON.parse(String(await tool.invoke({source:file,format:'original',mode:'auto',note:'处理好了'}))) as {result:{delivered:boolean}};
    expect(value.result.delivered).toBe(true);expect(delivered).toEqual(['file','text']);
    const failedReply=new ReplyRuntime(store,{send:async()=>{throw Error('平台拒绝')}});
    const fail=makeTools({conversationId:'g-media',scope:'group',store,reply:failedReply,tasks,background:true,taskId:'other'}).find((x)=>x.name==='deliver_media')!;
    const rejected=JSON.parse(String(await fail.invoke({source:file,format:'original',mode:'auto'}))) as {result:{delivered:boolean;error:string;path:string}};
    expect(rejected.result.delivered).toBe(false);expect(rejected.result.error).toContain('平台拒绝');expect(fs.existsSync(rejected.result.path)).toBe(true);
    tasks.stop();store.close();
  });
});

describe('DSH 同款结构化联网搜索', () => {
  it('最新请求要求读取真实原文，空结果和错误不能当作证据', () => {
    expect(needsCurrentResearch('给我最新强度榜')).toBe(true);expect(needsCurrentResearch('今天心情不错')).toBe(false);
    const msg=(content:string)=>new ToolMessage({tool_call_id:'1',name:'research_web',content});
    expect(hasEvidence(msg(JSON.stringify({ok:true,result:{reads:[]}})))).toBe(false);
    expect(hasEvidence(msg(JSON.stringify({ok:false,error:'失败'})))).toBe(false);
    expect(hasEvidence(msg(JSON.stringify({ok:true,result:{reads:[{document:{text:'来源正文'}}]}})))).toBe(true);
  });
  it('只使用原生 web_search_tool_result 来源并保留发布时间', async () => {
    const old={base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY,provider:process.env.SEARCH_PROVIDER};process.env.MODEL_BASE_URL='https://api.deepseek.com';process.env.MODEL_API_KEY='test-key';process.env.SEARCH_PROVIDER='deepseek';
    const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({content:[{type:'text',text:'不能当作来源'},{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/source',title:'来源',page_age:'2026-11-01'}]}]}),{status:200}));
    try { const result=await searchWeb(['查询']);expect(result.sufficient).toBe(true);expect(result.sources).toHaveLength(1);expect(result.sources[0]).toMatchObject({provider:'deepseek',publishedAt:'2026-11-01'}); }
    finally {spy.mockRestore();if(old.base===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=old.base;if(old.key===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=old.key;if(old.provider===undefined)delete process.env.SEARCH_PROVIDER;else process.env.SEARCH_PROVIDER=old.provider;}
  });
});
