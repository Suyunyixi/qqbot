import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import type { InboundEvent } from '../src/domain/types.js';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

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
const { recentActivityMarker } = await import('../src/agent/social-context.js');
const { capabilityManifest } = await import('../src/agent/capabilities.js');
const { quotedMessage } = await import('../src/agent/quoted-message.js');
const { internalSubagentTools } = await import('../src/agent/subagent-policy.js');
const { executionAgentTools } = await import('../src/agent/subagent-policy.js');
const { conversationFocus, formatConversationFocus } = await import('../src/agent/conversation-focus.js');
const { BalanceAlert, isBalanceError } = await import('../src/agent/balance-alert.js');
const { AttachmentArchive } = await import('../src/storage/attachments.js');
const { doctor } = await import('../src/startup/doctor.js');
const { memoryBudgetReached, pendingMemoryCharacters } = await import('../src/agent/memory-budget.js');
const { QQGroupProfiles } = await import('../src/platform/qq/group-profiles.js');
const { createToolDiscovery } = await import('../src/agent/tool-discovery.js');
const { metricsMiddleware, recordMetric } = await import('../src/agent/metrics.js');
const { largeToolResults, readToolResult } = await import('../src/agent/tool-results.js');
const { historyImageTools } = await import('../src/agent/history-images.js');
const { searchBilibiliCard } = await import('../src/tools/bilibili-card.js');
const { withModelTrace, tracedModelFetch, traceFile } = await import('../src/models/trace.js');
const { persona } = await import('../src/agent/runtime.js');
const { makeModel } = await import('../src/models/factory.js');
function event(group:string,user:string,id:string): InboundEvent { return { id,conversationId:group,scope:'group',senderId:user,senderName:user,content:'消息',timestamp:new Date().toISOString(),isMention:false,attachments:[] }; }

describe('全局用户记忆和创建者权限', () => {
  it('DeepSeek Anthropic 请求显式开启 high 思考，不改写其他服务商', () => {
    const previous={provider:process.env.MODEL_PROVIDER,base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY};
    process.env.MODEL_PROVIDER='anthropic';process.env.MODEL_BASE_URL='https://api.deepseek.com/anthropic';process.env.MODEL_API_KEY='test';
    try {
      const params=(makeModel() as unknown as {invocationParams:(options:object)=>{thinking?:unknown;output_config?:unknown}}).invocationParams({});
      expect(params.thinking).toMatchObject({type:'enabled'});expect(params.output_config).toMatchObject({effort:'high'});
      process.env.MODEL_BASE_URL='https://example.org';
      const other=(makeModel() as unknown as {invocationParams:(options:object)=>{thinking?:unknown;output_config?:unknown}}).invocationParams({});
      expect(other.thinking).toBeUndefined();expect(other.output_config).toBeUndefined();
    } finally {for(const [name,value] of Object.entries({MODEL_PROVIDER:previous.provider,MODEL_BASE_URL:previous.base,MODEL_API_KEY:previous.key}))if(value===undefined)delete process.env[name];else process.env[name]=value;}
  });
  it('人格缓存只在管理修改后更新，普通消息不会使其失效', () => {
    const store=new Store(':memory:');
    try {
      store.setPersona('初始完整人格','admin');expect(persona(store)).toBe('初始完整人格');
      const spy=vi.spyOn(store,'getAppSetting');store.record(event('g','u','persona-cache'));
      expect(persona(store)).toBe('初始完整人格');expect(spy).not.toHaveBeenCalled();
      store.setPersona('新完整人格','admin');expect(persona(store)).toBe('新完整人格');
    } finally {store.close();}
  });
  it('归档实际模型请求和流式响应，并关联回合且不保存认证头', async () => {
    const store=new Store(':memory:');const raw='event: message\ndata: {"type":"thinking"}\n\nevent: done\ndata: [DONE]\n\n';
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(raw,{headers:{'content-type':'text/event-stream'}}));
    try {
      const request=JSON.stringify({system:'完整人格',thinking:{type:'enabled'},output_config:{effort:'high'},messages:[{role:'user',content:'你好'}]});
      const response=await withModelTrace({store,conversationId:'g',scope:'group',turnId:'turn',phase:'主回复'},()=>tracedModelFetch('https://model.example/v1/messages',{method:'POST',headers:{authorization:'secret-test'},body:request}));
      expect(await response.text()).toBe(raw);
      await vi.waitFor(()=>expect(store.db.prepare('SELECT status,request_path,response_path FROM model_traces').get()).toMatchObject({status:'completed',request_path:expect.any(String),response_path:expect.any(String)}));
      const row=store.db.prepare('SELECT * FROM model_traces').get() as {turn_id:string;request_path:string;response_path:string};
      expect(row.turn_id).toBe('turn');expect(gunzipSync(fs.readFileSync(traceFile(row.request_path))).toString()).toBe(request);
      expect(gunzipSync(fs.readFileSync(traceFile(row.response_path))).toString()).toBe(raw);
      expect(JSON.stringify(row)).not.toContain('secret-test');
      const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
      try {const port=(server.address() as {port:number}).port;fetchSpy.mockRestore();const saved=await fetch(`http://127.0.0.1:${port}/api/model-trace?id=${(row as unknown as {id:string}).id}&part=request`);expect(await saved.text()).toBe(request);}
      finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));}
    } finally {fetchSpy.mockRestore();store.close();}
  });
  it('调用归档隐藏认证密钥和常见敏感字段，不修改返回给模型的流', async () => {
    const store=new Store(':memory:');const secret='secret-test-123456';
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.from('data: secret-test-'));controller.enqueue(Buffer.from('123456\n\n'));controller.close();}});
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(body,{headers:{'content-type':'text/event-stream'}}));
    try {
      const request=JSON.stringify({api_key:'embedded-secret',system:`人格 ${secret}`});
      const response=await withModelTrace({store,conversationId:'g',scope:'group',phase:'主回复'},()=>tracedModelFetch('https://model.example',{headers:{authorization:`Bearer ${secret}`},body:request}));
      expect(await response.text()).toContain(secret);
      await vi.waitFor(()=>expect(store.db.prepare('SELECT status,request_path,response_path FROM model_traces').get()).toMatchObject({status:'completed',request_path:expect.any(String),response_path:expect.any(String)}));
      const row=store.db.prepare('SELECT request_path,response_path FROM model_traces').get() as {request_path:string;response_path:string};
      const input=gunzipSync(fs.readFileSync(traceFile(row.request_path))).toString();const output=gunzipSync(fs.readFileSync(traceFile(row.response_path))).toString();
      expect(input).not.toContain(secret);expect(input).not.toContain('embedded-secret');expect(output).not.toContain(secret);
      expect(input).toContain('[已隐藏');expect(output).toContain('[已隐藏密钥]');
    } finally {fetchSpy.mockRestore();store.close();}
  });
  it('执行 Agent 合并前台与专用工具，同名使用前台实例且不能直接发群消息', () => {
    const foreground=[{name:'only_foreground'},{name:'shared',version:'前台'},{name:'send_text'}];
    const additional=[{name:'video_frames'},{name:'shared',version:'专用'},{name:'send_media'}];
    const tools=executionAgentTools(foreground,additional);
    expect(tools.map((item)=>item.name)).toEqual(['only_foreground','shared','video_frames']);
    expect(tools.find((item)=>item.name==='shared')).toMatchObject({version:'前台'});
  });
  it('沙箱权限不会把关闭的语音工具误报为当前能力', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      setRuntimeConfigProvider(()=>JSON.stringify({tools:{voice:false}}));
      const tools=makeTools({conversationId:'g',scope:'group',store,reply,tasks,background:false});
      const capability=tools.find((item)=>item.name==='sandbox_capabilities')!;
      const result=JSON.parse(String(await capability.invoke({}))) as {result:{toolPermissions?:unknown;hint:string}};
      expect(result.result.toolPermissions).toBeUndefined();expect(result.result.hint).toContain('find_tools');
      expect(tools.some((item)=>item.name==='speak')).toBe(false);
    } finally {setRuntimeConfigProvider(undefined);tasks.stop();store.close();}
  });
  it('引用中的图片独立保存，离线后仍能回看且不冒认原作者', async () => {
    const store=new Store(':memory:');const original=globalThis.fetch;
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Buffer.from('引用图片'),{headers:{'content-type':'image/png'}})):original(input,init));
    const harness=new Harness(store,{send:async()=>({})});
    try {
      const picture={url:'https://example.qq.com/quoted-test',content_type:'image/png'};
      const msg={...event('引用群','引用者','引用消息'),raw:{msgType:103,raw:{parallel_message:{msg_nodes:[{attachments:[picture]}]}}}};
      expect(await harness.receive(msg)).toBe(false);
      await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM message_attachments').get()).toMatchObject({status:'saved'}));
      spy.mockRejectedValue(new Error('网络已离线'));
      const history=historyImageTools(store,harness.attachments,'引用群',true);
      const list=JSON.parse(String(await history.tools[0]!.invoke({}))) as {images:Array<{source:string;senderMeaning?:string}>};
      expect(list.images).toHaveLength(1);expect(list.images[0]).toMatchObject({source:'quote',senderMeaning:'引用者，原图片作者未知'});
      const result=JSON.parse(String(await history.tools[1]!.invoke({messageId:'引用消息',index:0,source:'quote'}))) as {ok:boolean;senderMeaning?:string};
      expect(result).toMatchObject({ok:true,senderMeaning:'引用者，原图片作者未知'});
    } finally {harness.tasks.stop();spy.mockRestore();store.close();}
  });
  it('重启后恢复等待归档的引用图片', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-quote-resume-'));const store=new Store(':memory:');
    const original=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Buffer.from('引用图片'),{headers:{'content-type':'image/png'}})):original(input,init));
    try {
      const picture={url:'https://example.qq.com/resume-quote',content_type:'image/png'};
      store.record({...event('g','u','resume-quote'),raw:{msgType:103,raw:{parallel_message:{msg_nodes:[{attachments:[picture]}]}}}});
      store.db.prepare("INSERT INTO message_attachments(conversation_id,message_id,attachment_index,source_hash,media_type,status,updated_at) VALUES(?,?,?,?,?,'pending',?)").run('g','qqbot-quote:resume-quote',0,'resume-placeholder','image/png',new Date().toISOString());
      // 模拟进程退出前已记录归档状态；恢复时应使用原始消息里的地址。
      const {createHash}=await import('node:crypto');
      store.db.prepare('UPDATE message_attachments SET source_hash=?').run(createHash('sha256').update(picture.url).digest('hex'));
      const archive=new AttachmentArchive(store,dir);archive.resumePending();
      await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM message_attachments').get()).toMatchObject({status:'saved'}));
      expect(fs.readFileSync(archive.file('g','qqbot-quote:resume-quote',0)!.path).toString()).toBe('引用图片');
    } finally {spy.mockRestore();store.close();}
  });
  it('能回看机器人发出的本地图片，不会读取其他会话的消息', async () => {
    const store=new Store(':memory:');
    try {
      const file=path.join(workspaceFor('图片所属会话'),'自己的图片.png');fs.writeFileSync(file,Buffer.from('模拟图片'));
      store.recordSent({id:'own-image',conversationId:'图片所属会话',scope:'group',kind:'image',content:file},'own-image');
      const archive=new AttachmentArchive(store);
      const tools=historyImageTools(store,archive,'图片所属会话',true);
      const ok=JSON.parse(String(await tools.tools[1]!.invoke({messageId:'own-image',index:0}))) as {ok:boolean};
      expect(ok.ok).toBe(true);
      const other=historyImageTools(store,archive,'其他会话',true);
      const denied=JSON.parse(String(await other.tools[1]!.invoke({messageId:'own-image',index:0}))) as {ok:boolean;error:string};
      expect(denied.ok).toBe(false);expect(denied.error).toContain('当前会话');
    } finally {store.close();}
  });
  it('工具目录仅发现当前允许的工具，预览目录不会全部启用', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      store.setSetting('g','groupSettings',JSON.stringify({disabledTools:['inspect_media']}));
      const tools=makeTools({conversationId:'g',scope:'group',store,reply,tasks,background:false});
      const discovery=createToolDiscovery(tools,store,{conversationId:'g',scope:'group'},'你好');
      const preview=JSON.parse(String(await discovery.finder.invoke({listAll:true,limit:100}))) as {activated:boolean;tools:Array<{name:string}>};
      expect(preview.activated).toBe(false);expect(preview.tools.some((entry)=>entry.name==='inspect_media')).toBe(false);
      expect(discovery.enabled.has('search_images')).toBe(true);
      const denied=JSON.parse(String(await discovery.finder.invoke({names:['inspect_media'],limit:12,listAll:false}))) as {missing:string[]};
      expect(denied.missing).toEqual(['inspect_media']);expect(discovery.enabled.has('inspect_media')).toBe(false);
      await discovery.finder.invoke({names:['search_images'],limit:12,listAll:false});expect(discovery.enabled.has('search_images')).toBe(true);
      const other=createToolDiscovery(tools,store,{conversationId:'g',scope:'group'},'你好');expect(other.enabled.has('search_images')).toBe(true);
    } finally {tasks.stop();store.close();}
  });
  it('工具运行期间能看到进行中状态，完成后更新同一条记录', async () => {
    const store=new Store(':memory:');let release!:()=>void;const waiting=new Promise<void>((resolve)=>{release=resolve});
    try {
      const middleware=metricsMiddleware(store,{conversationId:'g',scope:'group',taskId:'任务'},'后台任务','模拟模型');
      const request={toolCall:{id:'call',name:'inspect_media',args:{}}};
      const pending=Promise.resolve(middleware.wrapToolCall!(request as never,async()=>{await waiting;return new ToolMessage({tool_call_id:'call',content:'完成'});}));
      expect(store.db.prepare("SELECT status FROM execution_metrics WHERE name='inspect_media'").get()).toEqual({status:'running'});
      release();await pending;
      expect(store.db.prepare("SELECT status FROM execution_metrics WHERE name='inspect_media'").all()).toEqual([{status:'success'}]);
    } finally {release?.();store.close();}
  });
  it('记录服务商返回的缓存与思考用量，缺失字段保持未知', () => {
    const store=new Store(':memory:');
    try {
      const message=new AIMessage({content:'完成',usage_metadata:{input_tokens:100,output_tokens:20,total_tokens:120,input_token_details:{cache_read:40},output_token_details:{reasoning:7}},response_metadata:{usage:{prompt_cache_miss_tokens:60}}});
      recordMetric(store,{conversationId:'g',scope:'group',turnId:'turn-a'},'主回复','模拟模型',Date.now(),message,'success');
      recordMetric(store,{conversationId:'g',scope:'group'},'主回复','模拟模型',Date.now(),new AIMessage('完成'),'success');
      const anthropic=new AIMessage({content:'完成',usage_metadata:{input_tokens:100,output_tokens:20,total_tokens:120,input_token_details:{cache_read:40}},response_metadata:{usage:{input_tokens:60,cache_read_input_tokens:40,output_tokens:20}}});
      recordMetric(store,{conversationId:'g',scope:'group'},'主回复','模拟模型',Date.now(),anthropic,'success');
      const rows=store.db.prepare('SELECT turn_id,cache_read_tokens,cache_miss_tokens,reasoning_tokens FROM execution_metrics ORDER BY seq').all();
      expect(rows).toEqual([{turn_id:'turn-a',cache_read_tokens:40,cache_miss_tokens:60,reasoning_tokens:7},{turn_id:null,cache_read_tokens:null,cache_miss_tokens:null,reasoning_tokens:null},{turn_id:null,cache_read_tokens:40,cache_miss_tokens:60,reasoning_tokens:null}]);
    } finally {store.close();}
  });
  it('大型工具结果完整归档，可分页回读且不跨会话访问', async () => {
    const content='群聊资料'.repeat(10000)+'最后内容';
    const middleware=largeToolResults('归档所属会话');
    const original=new ToolMessage({id:'tool-result',name:'grep',tool_call_id:'call',content});
    const result=await middleware.wrapToolCall!({toolCall:{id:'call',name:'grep',args:{}}} as never,async()=>original) as ToolMessage;
    expect(result.content.length).toBeLessThan(3000);expect(result.tool_call_id).toBe('call');
    const match=String(result.content).match(/[0-9a-f]{64}/);expect(match).not.toBeNull();const id=match![0];
    let recovered='';let offset:number|null=0;
    while(offset!==null){const page=readToolResult('归档所属会话',id,offset,6000);recovered+=page.content;offset=page.nextOffset;}
    expect(recovered).toBe(content);expect(()=>readToolResult('其他会话',id,0,100)).toThrow();
    let sent:unknown;
    await middleware.wrapModelCall!({messages:[new HumanMessage('继续'),original]} as never,async(request)=>{sent=request.messages;return new AIMessage('完成');});
    expect(JSON.stringify(sent)).not.toContain('最后内容');expect(String((sent as ToolMessage[])[1]?.content)).toContain(id);
  });
  it('异步获取群资料并缓存，不覆盖人工备注，失败保留上次成功结果', async () => {
    const store=new Store(':memory:');
    try {
      store.record(event('测试群','成员','消息一'));
      store.setSetting('测试群','groupSettings',JSON.stringify({label:'我的备注'}));
      const fetch=vi.fn().mockResolvedValueOnce({group_name:'平台群名',group_member_num:23}).mockRejectedValueOnce(new Error('11253'));
      const profiles=new QQGroupProfiles(store,fetch);
      await Promise.all([profiles.refresh('测试群'),profiles.refresh('测试群')]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(store.db.prepare('SELECT name,error FROM qq_group_profiles WHERE conversation_id=?').get('测试群')).toEqual({name:'平台群名',error:null});
      expect(store.getSetting('测试群','groupSettings')).toContain('我的备注');
      await profiles.refreshKnown();expect(fetch).toHaveBeenCalledTimes(1);
      store.db.prepare('UPDATE qq_group_profiles SET last_attempt_at=? WHERE conversation_id=?').run('2000-01-01T00:00:00.000Z','测试群');
      await profiles.refresh('测试群');
      expect(store.db.prepare('SELECT name,error FROM qq_group_profiles WHERE conversation_id=?').get('测试群')).toEqual({name:'平台群名',error:'群资料接口返回 11253'});
      await profiles.refresh('测试群');expect(fetch).toHaveBeenCalledTimes(2);
    } finally {store.close();}
  });
  it('按未整理内容占预算的百分比触发，超过两百条仍可统计', () => {
    const store=new Store(':memory:');
    try {
      for(let i=0;i<250;i++)store.record({...event('预算群','成员',`预算-${i}`),content:'一段聊天'});
      const through=store.maxSeq('预算群');
      const size=pendingMemoryCharacters(store,'预算群',0,through);
      expect(size).toBe(250*(4+2+24));
      expect(memoryBudgetReached(size,10000,75)).toBe(true);
      expect(memoryBudgetReached(size-1,10000,75)).toBe(false);
      expect(pendingMemoryCharacters(store,'预算群',through,through)).toBe(0);
    } finally {store.close();}
  });
  it('自检只重试指定失败项，不重新调用其他服务', async () => {
    const store=new Store(':memory:');const spy=vi.spyOn(globalThis,'fetch');
    try {const checks=await doctor(store,true,new Set(['配置和人格']));expect(checks.map((check)=>check.name)).toEqual(['配置和人格']);expect(spy).not.toHaveBeenCalled();}
    finally {spy.mockRestore();store.close();}
  });
  it('静默消息图片异步保存为路径，原文不变且可离线回读', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-attachment-'));const store=new Store(':memory:');
    const original=globalThis.fetch;const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Buffer.from('image-bytes'),{headers:{'content-type':'image/png'}})):original(input,init));
    const archive=new AttachmentArchive(store,dir);
    try {
      const msg={...event('g','u','photo'),attachments:[{url:'https://example.qq.com/image',content_type:'image/png'}]};store.record(msg);
      const raw=store.recent('g',1)[0]!.attachments;archive.enqueue(msg);
      await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM message_attachments').get()).toMatchObject({status:'saved'}));
      expect(store.recent('g',1)[0]!.attachments).toBe(raw);
      expect(fs.readFileSync(archive.file('g','photo',0)!.path).toString()).toBe('image-bytes');
      spy.mockRejectedValue(new Error('网络已离线'));
      expect(await archive.imageDataUrl(msg.attachments[0]!)).toBe(`data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`);
    } finally {spy.mockRestore();store.close();}
  });
  it('附件失败可重试，管理页按需读取归档内容', async () => {
    const store=new Store(':memory:');const original=globalThis.fetch;let online=false;
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?(online?Promise.resolve(new Response(Buffer.from('文档内容'),{headers:{'content-type':'application/pdf'}})):Promise.reject(new Error('连接失败'))):original(input,init));
    const archive=new AttachmentArchive(store);const msg={...event('file-group','u','file-message'),attachments:[{url:'https://example.qq.com/archive-pdf',content_type:'application/pdf',filename:'test.pdf'}]};store.record(msg);
    const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    try {
      archive.enqueue(msg);await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM message_attachments').get()).toMatchObject({status:'failed'}));
      online=true;archive.retry('file-group','file-message',0);await vi.waitFor(()=>expect(store.db.prepare('SELECT status FROM message_attachments').get()).toMatchObject({status:'saved'}));
      const port=(server.address() as {port:number}).port;const response=await fetch(`http://127.0.0.1:${port}/api/attachment?conversationId=file-group&messageId=file-message&index=0`);
      expect(response.status).toBe(200);expect(response.headers.get('content-disposition')).toBe('attachment');expect(await response.text()).toBe('文档内容');
    } finally {spy.mockRestore();await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
  it('当前说话人的用户记忆优先于其他参与者的历史记忆', () => {
    const store=new Store(':memory:');
    for(let i=0;i<24;i++) {store.record(event('g',`u${i}`,`m${i}`));const user=store.memory.lookup('group','g',`u${i}`)!;for(let j=0;j<8;j++)store.memory.add('user',user,`用户${i}记忆${j}`,'g');}
    const current=store.memory.context('group','g',['u23',...Array.from({length:23},(_,i)=>`u${i}`)]);
    expect(current.some((entry)=>entry.content==='用户23记忆0')).toBe(true);store.close();
  });
  it('余额不足提醒创建者并去重，其他故障不误报，恢复后可再次提醒', async () => {
    const store=new Store(':memory:');store.record(event('g','owner','1'));store.memory.setOwner(store.memory.lookup('group','g','owner')!);
    const sent:Array<{scope:string;content:string}>=[];const reply=new ReplyRuntime(store,{send:async(item)=>{sent.push(item);return {id:`alert-${sent.length}`}}});
    const alert=new BalanceAlert(store,reply);const balance=new Error('402 Insufficient Balance');
    expect(isBalanceError(balance)).toBe(true);expect(isBalanceError(new Error('402 unrelated billing issue'))).toBe(false);expect(isBalanceError(new Error('500 error'))).toBe(false);
    await alert.report(new Error('500 error'));expect(sent).toHaveLength(0);
    await Promise.all([alert.report(balance),alert.report(balance)]);expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({scope:'group',content:'<qqbot-at-user id="owner" /> 主人，我的饭饭吃光啦，呜呜……'});
    await new BalanceAlert(store,reply).report(balance);expect(sent).toHaveLength(1);
    alert.recovered();await alert.report(balance);expect(sent).toHaveLength(2);store.close();
  });
  it('有创建者私聊身份时优先私聊，发送超时不会自动重复', async () => {
    const store=new Store(':memory:');store.saveQQCredentials({appId:'a',appSecret:'s',userOpenid:'owner-c2c'});
    const sent:string[]=[];const reply=new ReplyRuntime(store,{send:async(item)=>{sent.push(`${item.scope}:${item.content}`);throw Error('timeout')}});
    const alert=new BalanceAlert(store,reply);await alert.report(new Error('402 Insufficient Balance'));await new BalanceAlert(store,reply).report(new Error('402 Insufficient Balance'));
    expect(sent).toEqual(['c2c:主人，我的饭饭吃光啦，呜呜……']);store.close();
  });
  it('单独 @ 时突出最近连续对话，保留发言人和上一条机器人回复', () => {
    const now=Date.now();
    const row=(seq:number,sender_id:string,sender_name:string,content:string,direction='in',age=0)=>({seq,id:`r${seq}`,sender_id,sender_name,content,timestamp:new Date(now-age).toISOString(),direction,attachments:'[]'});
    const rows=[row(1,'a','甲','之前的话','in',60000),row(2,'bot','机器人','原来的回复','out',30000),row(3,'a','甲','你就是大肥鱼啊','in',20000),row(4,'b','乙','另一个人插话','in',15000),row(5,'a','甲','你不信问问其他人','in',10000)];
    const trigger={...event('g','a','trigger'),timestamp:new Date(now).toISOString(),content:'<@bot>',isMention:true};
    const focus=conversationFocus(rows,trigger,180);
    expect(focus.mentionOnly).toBe(true);expect(focus.rows.map((r)=>r.seq)).toEqual([2,3,4,5]);expect(focus.background.map((r)=>r.seq)).toEqual([1]);
    const rendered=formatConversationFocus(focus.rows);
    expect(rendered).toContain('甲 [a]：你就是大肥鱼啊');expect(rendered).toContain('乙 [b]：另一个人插话');expect(rendered).toContain('甲 [a]：你不信问问其他人');
    expect(conversationFocus(rows,{...trigger,content:'<@bot> 说说别的'},180).mentionOnly).toBe(false);
  });
  it('不把过期发言和上一轮已答复的消息判为本轮连续对话', () => {
    const now=Date.now();const row=(seq:number,direction:string,age:number)=>({seq,id:`r${seq}`,sender_id:direction==='out'?'bot':'u',sender_name:'用户',content:`记录${seq}`,timestamp:new Date(now-age).toISOString(),direction,attachments:'[]'});
    const trigger={...event('g','u','trigger'),timestamp:new Date(now).toISOString(),content:'<@bot>',isMention:true};
    const stale=conversationFocus([row(1,'out',300000),row(2,'in',200000)],trigger,180);
    expect(stale.rows).toEqual([]);expect(stale.background).toHaveLength(2);
    const answered=conversationFocus([row(1,'in',30000),row(2,'out',20000),row(3,'in',10000)],trigger,180);
    expect(answered.rows.map((r)=>r.seq)).toEqual([2,3]);expect(answered.background.map((r)=>r.seq)).toEqual([1]);
  });
  it('引用消息作为上下文单独提取，并忽略普通消息片段', () => {
    const raw={refMsgIdx:'quoted',msgElements:[{message_type:103,msg_idx:'quoted',content:'我可以下载文件'},{message_type:0,content:'不是引用'}]};
    expect(quotedMessage(raw)).toBe('我可以下载文件');
    expect(quotedMessage({msgElements:[{message_type:0,content:'不应提取'}]})).toBeUndefined();
    expect(quotedMessage({msgType:103,raw:{message_type:103,parallel_message:{msg_nodes:[{message_type:0,content:'离线前的引用原文'}]}}})).toBe('离线前的引用原文');
    expect(quotedMessage({raw:{parallel_message:{msg_nodes:[{content:'不是引用'}]}}})).toBeUndefined();
  });
  it('能力清单根据前台、后台及会话范围生成', () => {
    const enabled=capabilityManifest(['start_background_task','download_file','send_media'],['download_media','deliver_media'],'group');
    expect(enabled.downloads).toEqual({publicFiles:true,supportedMediaSites:true,scriptFallback:false});
    expect(enabled.backgroundOnlyTools).toContain('download_media');
    const disabled=capabilityManifest(['send_media'],['download_media'],'guild');
    expect(disabled.downloads.supportedMediaSites).toBe(false);expect(disabled.delivery.filesAndVideo).toBe(false);
    expect(capabilityManifest(['run_shell_command'],[],'group',true).downloads).toEqual({publicFiles:true,supportedMediaSites:null,scriptFallback:true});
    expect(capabilityManifest(['run_shell_command'],[],'group',false).downloads.publicFiles).toBe(false);
  });
  it('聊天工具不能修改主人格，创建者可调整本群风格', async () => {
    const store=new Store(':memory:');store.record(event('g','owner','1'));const user=store.memory.lookup('group','g','owner')!;store.memory.setOwner(user);
    store.setPersona('原人格','admin');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const base={conversationId:'g',scope:'group' as const,actorId:'owner',store,reply,tasks,background:false,owner:true};
    for(const currentRequest of ['你好','请把主人格修改成新的设定']) expect(makeTools({...base,currentRequest}).some((tool)=>tool.name==='owner_set_persona')).toBe(false);
    expect(store.getAppSetting('persona')).toBe('原人格');expect(store.personaRevisions()).toHaveLength(1);
    expect(()=>store.setPersona('伪造人格','qq' as never,'owner')).toThrow('主人格只能通过本机管理页面修改');
    const groupTool=(currentRequest:string)=>makeTools({...base,currentRequest}).find((tool)=>tool.name==='owner_set_group_preferences')!;
    const refused=JSON.parse(String(await groupTool('感觉本群风格被调整了').invoke({persona:'伪造风格'}))) as {ok:boolean};expect(refused.ok).toBe(false);expect(store.getSetting('g','groupSettings')).toBeUndefined();
    const allowed=JSON.parse(String(await groupTool('请把本群风格改成轻松聊天').invoke({persona:'轻松聊天'}))) as {ok:boolean};expect(allowed.ok).toBe(true);expect(store.getAppSetting('persona')).toBe('原人格');
    tasks.stop();store.close();
  });
  it('后台文字先交给主 Agent 表达，并等待其完成', async () => {
    const store=new Store(':memory:');const sent:string[]=[];const reply=new ReplyRuntime(store,{send:async(item)=>{sent.push(item.content);return {id:'qq'}}});
    const taskId=store.addTask('g','group',undefined,'测试任务');store.setTask(taskId,'running');
    const callback=vi.fn(async(task: {result:string|null})=>{await reply.send('g','group',undefined,'text',`主人人格：${task.result}`)});
    const tasks=new TaskManager(store,async()=>'',callback);
    const tool=makeTools({conversationId:'g',scope:'group',store,reply,tasks,background:true,taskId}).find((item)=>item.name==='send_text')!;
    const result=JSON.parse(String(await tool.invoke({text:'工具原话'}))) as {result:{sent:boolean;relayedToMain:boolean}};
    expect(result.result).toEqual({sent:false,relayedToMain:true});expect(callback).toHaveBeenCalledOnce();expect(sent).toEqual(['主人人格：工具原话']);
    expect(store.pendingProgress()).toHaveLength(0);tasks.stop();store.close();
  });
  it('内置子助手可处理资料但不能绕过主 Agent 发言或改人格', () => {
    const tools=['web_search','send_text','send_media','send_native_card','deliver_media','owner_set_persona','remember_fact','run_python_script'].map((name)=>({name}));
    expect(internalSubagentTools(tools).map((item)=>item.name)).toEqual(['web_search','run_python_script']);
  });
  it('保存平台最后一次提供的群角色，缺少角色的消息不会覆盖，群主不自动取得机器人权限', () => {
    const store=new Store(':memory:');
    store.record({...event('g','u','one'),raw:{raw:{author:{member_role:'member'}}}});
    store.record({...event('g','u','two'),raw:{raw:{author:{member_role:'owner'}}}});
    store.record({...event('g','u','three'),raw:{raw:{author:{}}}});
    expect(store.memory.listConversationMembers('group','g')[0]).toMatchObject({platform_role:'owner',bot_role:'ordinary',message_count:3});
    expect(store.memory.isOwner('group','g','u')).toBe(false);store.close();
  });
  it('只突出指定时间窗口里的群友发言，并保留发言人和时间', () => {
    const now=Date.now();const rows=[{seq:1,id:'old',sender_id:'a',sender_name:'小王',content:'久远聊天',timestamp:new Date(now-600000).toISOString(),direction:'in',attachments:'[]'},{seq:2,id:'new',sender_id:'b',sender_name:'小李',content:'最近的纠正',timestamp:new Date(now-15000).toISOString(),direction:'in',attachments:'[]'}];
    const text=recentSocialContext(rows,now,180);expect(text).toContain('小李');expect(text).toContain('最近的纠正');expect(text).not.toContain('久远聊天');
    expect(recentActivityMarker(rows[1]!.timestamp,now,10)).toBe('');
    expect(recentActivityMarker(rows[1]!.timestamp,now,20)).toBe('近期互动');
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
    expect(makeTools({...base,owner:true}).some((t)=>t.name==='owner_set_persona')).toBe(false);
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
  it('对话回合与工具使用统计按实际调用展示，未知用量不伪造', async () => {
    const store=new Store(':memory:');const now=new Date().toISOString();
    store.db.prepare("INSERT INTO chat_turns(id,conversation_id,scope,message_id,status,received_at,started_at,finished_at,queue_ms,duration_ms) VALUES('turn','g','group','m','completed',?,?,?,5,150)").run(now,now,now);
    store.db.prepare("INSERT INTO execution_metrics(conversation_id,scope,turn_id,phase,name,duration_ms,status,result_characters,created_at) VALUES('g','group','turn','工具','web_search',23,'success',42,?)").run(now);
    store.db.prepare("INSERT INTO execution_metrics(conversation_id,scope,turn_id,phase,name,duration_ms,status,created_at) VALUES('g','group','turn','工具','web_search',10,'failed',?)").run(now);
    const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('listen');
    try {
      const base=`http://127.0.0.1:${address.port}`;
      const metrics=await (await fetch(base+'/api/metrics')).json() as {turns:Array<{duration_ms:number;tool_calls:number;total_tokens:number|null}>;turnCalls:Array<{label:string;result_characters:number|null}>};
      expect(metrics.turns[0]).toMatchObject({duration_ms:150,tool_calls:2,total_tokens:null});expect(metrics.turnCalls).toEqual(expect.arrayContaining([expect.objectContaining({label:'联网搜索',result_characters:42})]));
      const flow=await (await fetch(base+'/api/dialogue-flow')).json() as {flows:Array<{id:string;main:unknown[];expressions:unknown[];deliveries:unknown[]}>};
      expect(flow.flows[0]).toMatchObject({id:'turn',main:[],expressions:[],deliveries:[]});
      const activity=await (await fetch(base+'/api/tool-activity')).json() as {usage:Array<{name:string;calls:number;successes:number;failures:number}>};
      expect(activity.usage[0]).toMatchObject({name:'web_search',calls:2,successes:1,failures:1});
    } finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
  it('聊天记录页面能按引用原文搜索并查看引用', async () => {
    const store=new Store(':memory:');
    store.record({...event('group','member','quoted'),content:'你说的是哪个',raw:{refMsgIdx:'r',msgElements:[{message_type:103,msg_idx:'r',content:'中山大学附属医院'}]}});
    const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('listen');
    try {
      const response=await fetch(`http://127.0.0.1:${address.port}/api/messages?conversationId=group&q=${encodeURIComponent('附属医院')}`);
      const result=await response.json() as {messages:Array<{content:string;quotedContent:string}>};
      expect(result.messages).toHaveLength(1);expect(result.messages[0]).toMatchObject({content:'你说的是哪个',quotedContent:'中山大学附属医院'});
    } finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
  it('群聊和私聊独立维护会话与成员备注，原始消息及创建者权限不受影响', async () => {
    const store=new Store(':memory:');store.record({...event('group','member-openid','msg-group'),senderName:'平台昵称',content:'原始消息',raw:{raw:{author:{member_role:'admin'}}}});
    store.record({...event('private','private-openid','msg-private'),scope:'c2c',senderName:'私聊昵称',content:'私聊内容'});
    const server=http.createServer((req,res)=>void handleAdmin(req,res,store,undefined));await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('listen');const origin=`http://127.0.0.1:${address.port}`;
    const write=(url:string,method:string,value:unknown)=>fetch(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
    try {
      expect((await write('/api/conversation-profile','PUT',{scope:'group',conversationId:'group',label:'工作群',note:'群备注'})).status).toBe(200);
      expect((await write('/api/conversation-profile','PUT',{scope:'c2c',conversationId:'private',label:'朋友私聊',note:'私聊备注'})).status).toBe(200);
      expect((await write('/api/conversation-members','PUT',{scope:'group',conversationId:'group',externalId:'member-openid',remarkName:'小王',note:'人工备注'})).status).toBe(200);
      expect((await write('/api/conversation-members','POST',{scope:'c2c',conversationId:'private',externalId:'manual-openid',remarkName:'手工用户',note:'待核实'})).status).toBe(200);
      expect((await write('/api/conversation-members','PUT',{scope:'group',conversationId:'group',externalId:'unknown',remarkName:'不应创建',note:''})).status).toBe(400);
      const all=await (await fetch(origin+'/api/conversations')).json() as {conversations:Array<{scope:string;label:string;note:string}>};
      expect(all.conversations.find((c)=>c.scope==='group')).toMatchObject({label:'工作群',note:'群备注'});
      expect(all.conversations.find((c)=>c.scope==='c2c')).toMatchObject({label:'朋友私聊',note:'私聊备注'});
      const group=await (await fetch(origin+'/api/conversation-members?scope=group&conversationId=group')).json() as {members:Array<{external_id:string;remark_name:string;note:string;bot_role:string}>};
      expect(group.members).toHaveLength(1);expect(group.members[0]).toMatchObject({external_id:'member-openid',remark_name:'小王',note:'人工备注',bot_role:'ordinary',platform_role:'admin'});
      const privateMembers=await (await fetch(origin+'/api/conversation-members?scope=c2c&conversationId=private')).json() as {members:Array<{external_id:string;bot_role:string}>};
      expect(privateMembers.members.map((m)=>m.external_id)).toContain('manual-openid');expect(privateMembers.members.every((m)=>m.bot_role==='ordinary')).toBe(true);
      const result=await (await fetch(origin+'/api/messages?conversationId=group&q='+encodeURIComponent('小王'))).json() as {messages:Array<{id:string;sender_id:string;sender_name:string;remark_name:string;content:string;botRole:string}>};
      expect(result.messages[0]).toMatchObject({id:'msg-group',sender_id:'member-openid',sender_name:'平台昵称',remark_name:'小王',content:'原始消息',botRole:'ordinary',platformRole:'admin'});
      expect(store.memory.owner()).toBeUndefined();
      store.memory.setOwner(store.memory.lookup('group','group','member-openid')!);
      const updated=await (await fetch(origin+'/api/conversation-members?scope=group&conversationId=group')).json() as {members:Array<{external_id:string;bot_role:string}>};
      expect(updated.members[0]).toMatchObject({external_id:'member-openid',bot_role:'owner'});
    } finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
  it('会话和成员的人工备注与聊天原文在数据库重开后保留', () => {
    const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'qq-member-persistence-')),'records.sqlite');
    const initial=new Store(file);initial.record({...event('g','u','m'),content:'原文',raw:{raw:{author:{member_role:'owner'}}}});
    initial.memory.saveConversationMember('group','g','u','人工名称','人工备注');
    initial.db.prepare('INSERT INTO conversation_profiles VALUES (?,?,?,?,?)').run('group','g','本地名称','本地说明',new Date().toISOString());
    // Simulate upgrading an older database whose raw events predate this index.
    initial.db.prepare('DELETE FROM conversation_member_platform_roles').run();initial.db.prepare("DELETE FROM app_settings WHERE key='member_platform_roles_migrated_v1'").run();initial.close();
    const reopened=new Store(file);
    expect(reopened.memory.listConversationMembers('group','g')[0]).toMatchObject({external_id:'u',remark_name:'人工名称',note:'人工备注',platform_role:'owner',bot_role:'ordinary'});
    expect(reopened.db.prepare('SELECT label,note FROM conversation_profiles WHERE scope=? AND conversation_id=?').get('group','g')).toEqual({label:'本地名称',note:'本地说明'});
    expect(reopened.recent('g',10)[0]?.content).toBe('原文');reopened.close();
  });
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
      const initialName=readConfig().model.name;
      const save=await fetch(origin+'/api/runtime-config',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({model:{name:'new-model',apiKey:'test-secret'}})});expect(save.status).toBe(200);
      expect(readConfig().model.name).toBe('new-model');expect(readConfig().model.apiKey).toBe('test-secret');
      const visible=await (await fetch(origin+'/api/runtime-config')).text();expect(visible).not.toContain('test-secret');expect(visible).toContain('new-model');
      const reset=await fetch(origin+'/api/runtime-config',{method:'DELETE',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});expect(reset.status).toBe(200);expect(readConfig().model.name).toBe(initialName);
    } finally {setRuntimeConfigProvider(undefined);await new Promise<void>((resolve)=>server.close(()=>resolve()));store.close();}
  });
});

describe('完整媒体交付', () => {
  it('B 站卡片查询使用签名并只返回同名候选', async () => {
    const original=globalThis.fetch;const calls:string[]=[];
    const spy=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
      const url=String(input);calls.push(url);
      if(url.includes('/x/web-interface/nav'))return Promise.resolve(new Response(JSON.stringify({data:{wbi_img:{img_url:`https://x/${'a'.repeat(32)}.png`,sub_url:`https://x/${'b'.repeat(32)}.png`}}})));
      if(url.includes('/x/web-interface/wbi/search/type'))return Promise.resolve(new Response(JSON.stringify({code:0,data:{result:[{title:'<em>测试</em>视频',bvid:'BV1L54h6EEDV',author:'作者',pic:'https://example.com/cover'},{title:'其他视频',bvid:'BV1CF41197mv'}]}})));
      return original(input,init);
    });
    try {
      const result=await searchBilibiliCard('测试视频');
      expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({bvid:'BV1L54h6EEDV',author:'作者'});expect(result.match).toContain('不等于');
      const searches=calls.filter((url)=>url.includes('/wbi/search/type'));expect(searches).toHaveLength(3);expect(searches.every((url)=>new URL(url).searchParams.has('w_rid'))).toBe(true);
    } finally {spy.mockRestore();}
  });
  it('工作区 MP4 以视频类型交付群聊', async () => {
    const store=new Store(':memory:');const delivered:Array<{kind:string;content:string}>=[];const reply=new ReplyRuntime(store,{send:async(item)=>{delivered.push(item);return {id:'video-ok'}}});
    const tasks=new TaskManager(store,async()=>'',async()=>{});const file=path.join(workspaceFor('video-delivery'),'测试.mp4');fs.writeFileSync(file,'video');
    const id=store.addTask('video-delivery','group',undefined,'发视频');store.setTask(id,'running');
    try {
      const video=makeTools({conversationId:'video-delivery',scope:'group',store,reply,tasks,background:true,taskId:id}).find((item)=>item.name==='deliver_media')!;
      const result=JSON.parse(String(await video.invoke({source:file,format:'original',mode:'auto'}))) as {result:{delivered:boolean;kind:string}};
      expect(result.result).toMatchObject({delivered:true,kind:'video'});expect(delivered).toHaveLength(1);expect(delivered[0]).toMatchObject({kind:'video',content:file});
    } finally {tasks.stop();store.close();}
  });
  it('本地文件先发送后说明，发送失败保留文件并记录失败', async () => {
    const store=new Store(':memory:');const delivered:string[]=[];const reply=new ReplyRuntime(store,{send:async(item)=>{delivered.push(item.kind);return {id:`ok-${delivered.length}`}}});
    const tasks=new TaskManager(store,async()=>'',async(task)=>{await reply.send(task.conversation_id,task.scope,task.reply_to??undefined,'text',`主人格：${task.result}`)});
    const file=path.join(workspaceFor('g-media'),'demo.bin');fs.writeFileSync(file,'sample');
    const taskId=store.addTask('g-media','group',undefined,'测试交付');store.setTask(taskId,'running');
    const tool=makeTools({conversationId:'g-media',scope:'group',store,reply,tasks,background:true,taskId}).find((x)=>x.name==='deliver_media')!;
    const value=JSON.parse(String(await tool.invoke({source:file,format:'original',mode:'auto',note:'处理好了'}))) as {status:string;result:{delivered:boolean}};
    expect(value.status).toBe('success');expect(value.result.delivered).toBe(true);expect(delivered).toEqual(['file','text']);
    const failedReply=new ReplyRuntime(store,{send:async()=>{throw Error('平台拒绝')}});
    const fail=makeTools({conversationId:'g-media',scope:'group',store,reply:failedReply,tasks,background:true,taskId:'other'}).find((x)=>x.name==='deliver_media')!;
    const rejected=JSON.parse(String(await fail.invoke({source:file,format:'original',mode:'auto'}))) as {status:string;result:{delivered:boolean;error:string;path:string}};
    expect(rejected.status).toBe('partial');expect(rejected.result.delivered).toBe(false);expect(rejected.result.error).toContain('平台拒绝');expect(fs.existsSync(rejected.result.path)).toBe(true);
    tasks.stop();store.close();
  });
});

describe('DSH 同款结构化联网搜索', () => {
  it('搜索用量包含缓存输入，并保留命中和未命中明细', async () => {
    const old={base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY,provider:process.env.SEARCH_PROVIDER};process.env.MODEL_BASE_URL='https://api.deepseek.com';process.env.MODEL_API_KEY='test-key';process.env.SEARCH_PROVIDER='deepseek';
    const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({usage:{input_tokens:12,cache_read_input_tokens:80,cache_creation_input_tokens:3,output_tokens:7},content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/source',title:'来源'}]}]}),{status:200}));
    try {const observe=vi.fn();await searchWeb(['查询'],{observe});expect(observe).toHaveBeenCalledWith(expect.objectContaining({status:'success',usage:{input_tokens:95,output_tokens:7,total_tokens:102,cache_read_tokens:80,cache_miss_tokens:12}}));}
    finally {spy.mockRestore();if(old.base===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=old.base;if(old.key===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=old.key;if(old.provider===undefined)delete process.env.SEARCH_PROVIDER;else process.env.SEARCH_PROVIDER=old.provider;}
  });
  it('只使用原生 web_search_tool_result 来源并保留发布时间', async () => {
    const old={base:process.env.MODEL_BASE_URL,key:process.env.MODEL_API_KEY,provider:process.env.SEARCH_PROVIDER};process.env.MODEL_BASE_URL='https://api.deepseek.com';process.env.MODEL_API_KEY='test-key';process.env.SEARCH_PROVIDER='deepseek';
    const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({usage:{input_tokens:12,output_tokens:7},content:[{type:'text',text:'不能当作来源'},{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.com/source',title:'来源',page_age:'2026-11-01'}]}]}),{status:200}));
    try { const observe=vi.fn();const result=await searchWeb(['查询'],{observe});expect(result.sufficient).toBe(true);expect(result.sources).toHaveLength(1);expect(result.sources[0]).toMatchObject({provider:'deepseek',publishedAt:'2026-11-01'});expect(observe).toHaveBeenCalledWith(expect.objectContaining({status:'success',usage:{input_tokens:12,output_tokens:7,total_tokens:19}})); }
    finally {spy.mockRestore();if(old.base===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=old.base;if(old.key===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=old.key;if(old.provider===undefined)delete process.env.SEARCH_PROVIDER;else process.env.SEARCH_PROVIDER=old.provider;}
  });
});
