import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tool } from 'langchain';
import { z } from 'zod';
import { HumanMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-harness-test-'));
process.env.BOT_DATA_DIR = root;
process.env.MODEL_API_KEY = 'test-key';
process.env.MODEL_NAME = 'test-model';

const { initConfig, readConfig, configPath, checkpointPath } = await import('../src/config/settings.js');
const { Store } = await import('../src/storage/store.js');
const { Harness } = await import('../src/agent/harness.js');
const { AgentRuntime } = await import('../src/agent/runtime.js');
const { ReplyRuntime, splitText } = await import('../src/delivery/reply.js');
const { shouldRespond } = await import('../src/agent/trigger.js');
const { TaskManager } = await import('../src/agent/task-manager.js');
const { makeTools, workspaceFor } = await import('../src/tools/registry.js');
const { resolveWorkspaceFile } = await import('../src/storage/workspace.js');
const { imageAttachments, qqImageDataUrl, voiceTranscripts } = await import('../src/platform/qq/attachments.js');
const { readPublicWebpage } = await import('../src/tools/web.js');
const { qqVoiceBuffer } = await import('../src/platform/qq/voice.js');
const { pcmToSilk, loadSilkWasm } = await import('@tencent-connect/qqbot-nodejs/protocol');
const { savedCredentials, QQAdapter } = await import('../src/platform/qq/adapter.js');
const { makeModel } = await import('../src/models/factory.js');
const { filesystemRules } = await import('../src/tools/sandbox.js');
const { liveContext, recheckBeforeReply } = await import('../src/agent/live-context.js');
import type { DeliveryItem, InboundEvent } from '../src/domain/types.js';

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return { id: 'm1', conversationId: 'group-a', scope: 'group', senderId: 'user-a', senderName: '小王', content: '刚买了 NAS', timestamp: new Date().toISOString(), isMention: false, attachments: [], ...overrides };
}

initConfig();

describe('沙箱与动态配置', () => {
  it('DeepSeek 的快速语义复核单独关闭思考，主对话仍使用原有配置', () => {
    const oldProvider=process.env.MODEL_PROVIDER,oldBase=process.env.MODEL_BASE_URL;
    process.env.MODEL_PROVIDER='anthropic';process.env.MODEL_BASE_URL='https://api.deepseek.com/anthropic';
    try {
      const main=makeModel() as {invocationParams(options:object):{thinking?:unknown;max_tokens?:number}};
      const review=makeModel({lightweightReview:true}) as {invocationParams(options:object):{thinking?:unknown;max_tokens?:number}};
      expect(main.invocationParams({}).thinking).toBeUndefined();
      expect(review.invocationParams({})).toMatchObject({thinking:{type:'disabled'},max_tokens:512});
    } finally {if(oldProvider===undefined)delete process.env.MODEL_PROVIDER;else process.env.MODEL_PROVIDER=oldProvider;if(oldBase===undefined)delete process.env.MODEL_BASE_URL;else process.env.MODEL_BASE_URL=oldBase;}
  });
  it('工作区映射按会话隔离，模型配置文件修改后即时读取', () => {
    const modelFile = path.join(root, 'runtime.env');
    process.env.BOT_MODEL_ENV_PATH = modelFile;
    process.env.BOT_WORKSPACE_DIR = path.join(root, 'host-workspace');
    try {
      fs.writeFileSync(modelFile, 'MODEL_PROVIDER=openai\nMODEL_NAME=first\nMODEL_API_KEY=key-one\n');
      expect(readConfig().model.name).toBe('first');
      fs.writeFileSync(modelFile, 'MODEL_PROVIDER=anthropic\nMODEL_NAME=second\nMODEL_API_KEY=key-two\n');
      expect(readConfig().model).toMatchObject({ provider: 'anthropic', name: 'second', apiKey: 'key-two' });
      expect(workspaceFor('group-a')).not.toBe(workspaceFor('group-b'));
      expect(workspaceFor('group-a').startsWith(process.env.BOT_WORKSPACE_DIR)).toBe(true);
    } finally { delete process.env.BOT_MODEL_ENV_PATH; delete process.env.BOT_WORKSPACE_DIR; }
  });
  it('禁用网络、进程和工作区读写后，相应工具不会注册', () => {
    const original = fs.readFileSync(configPath, 'utf8');
    const store = new Store(':memory:');
    const reply = new ReplyRuntime(store, { send: async () => ({}) });
    const tasks = new TaskManager(store, async () => '', async () => {});
    try {
      const config = parseYaml(original);
      config.sandbox = { permissions: { network: false, process: false, workspaceRead: false, workspaceWrite: false } };
      fs.writeFileSync(configPath, stringifyYaml(config));
      const names = makeTools({ conversationId: 'g', scope: 'group', store, reply, tasks, background: true, taskId: 'task' }).map((item) => item.name);
      expect(names).not.toContain('web_search'); expect(names).not.toContain('download_media');
      expect(names).not.toContain('inspect_media'); expect(names).not.toContain('send_media');
      expect(names).toContain('sandbox_capabilities');
      expect(filesystemRules(readConfig())).toHaveLength(2);
    } finally { fs.writeFileSync(configPath, original); tasks.stop(); store.close(); }
  });
});

describe('消息记录与触发', () => {
  it('发送前重新检查处理中收到的群友答复，静默消息本身不会唤醒模型', async () => {
    const store = new Store(':memory:');
    store.record(event({ id: 'trigger', isMention: true }));
    const live = liveContext(store, 'group', 'group-a', readConfig(), store.eventSeq('group-a', 'trigger'));
    store.record(event({ id: 'late', senderId: 'ez', senderName: 'EZ', content: '有两处要调整' }));
    const resume = vi.fn(async (message: { content: unknown }) => `采纳：${String(message.content)}`);
    const result = await recheckBeforeReply('旧答案', live.takePending, resume);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result).toContain('EZ [ez]');
    expect(result).toContain('有两处要调整');
    store.close();
  });
  it('查找群成员时返回真实身份与备注，同名成员不合并', async () => {
    const store = new Store(':memory:');
    const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      store.record(event({id:'one',senderId:'member-1',senderName:'兰林'}));
      store.memory.saveConversationMember('group','group-a','member-1','苍蓝','');
      store.record(event({id:'two',senderId:'member-2',senderName:'苍蓝'}));
      store.record(event({id:'renamed',senderId:'member-2',senderName:'新名字'}));
      store.record(event({id:'other',conversationId:'other-group',senderId:'member-3',senderName:'苍蓝'}));
      const lookup=makeTools({conversationId:'group-a',scope:'group',store,reply,tasks,background:false}).find((item)=>item.name==='find_chat_member')!;
      const result=JSON.parse(String(await lookup.invoke({query:'苍蓝'})));
      expect(result.result.members).toEqual(expect.arrayContaining([expect.objectContaining({memberId:'member-1',remark:'苍蓝'}),expect.objectContaining({memberId:'member-2',name:'新名字',matchingHistoricalNames:['苍蓝']})]));
      expect(result.result.members).toHaveLength(2);
      expect(result.result.hint).toContain('<qqbot-at-user');
    } finally {tasks.stop();store.close();}
  });
  it('QQ 绑定凭据保存在数据库中，重新打开后无需重新扫码', () => {
    const dbFile = path.join(root, 'qq-binding-test.sqlite');
    const initial = new Store(dbFile);
    initial.saveQQCredentials({ appId: 'test-app', appSecret: 'test-secret', userOpenid: 'test-user' });
    initial.close();
    const reopened = new Store(dbFile);
    expect(savedCredentials(reopened)).toEqual({ appId: 'test-app', appSecret: 'test-secret', userOpenid: 'test-user' });
    reopened.close();
  });
  it('旧版文件绑定可无损迁移到数据库', () => {
    const file = path.join(root, 'qq-credentials.json');
    fs.writeFileSync(file, JSON.stringify({ appId: 'legacy-app', appSecret: 'legacy-secret' }));
    const store = new Store(':memory:');
    expect(savedCredentials(store)?.appId).toBe('legacy-app');
    expect(fs.existsSync(file)).toBe(false);
    fs.unlinkSync(`${file}.migrated`);
    expect(savedCredentials(store)?.appId).toBe('legacy-app');
    store.close();
  });
  it('未触发消息只记录、不调用模型或发送，且去重、隔离群', async () => {
    const store = new Store(':memory:');
    const send = vi.fn(async () => ({ id: 'sent' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const harness = new Harness(store, { send });
    expect(await harness.receive(event())).toBe(false);
    expect(await harness.receive(event())).toBe(false);
    expect(await harness.receive(event({ id: 'm2', conversationId: 'group-b', senderId: 'user-b', senderName: '小李' }))).toBe(false);
    expect(store.recent('group-a', 20)).toHaveLength(1);
    expect(store.recent('group-b', 20)[0]?.sender_name).toBe('小李');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(shouldRespond(event({ isMention: true }), readConfig())).toBe(true);
    expect(shouldRespond(event({ content: '小助手在吗' }), readConfig())).toBe(false);
    expect(shouldRespond(event({ content: '小助手在吗' }), { ...readConfig(), trigger: { ...readConfig().trigger, keywords: ['小助手'] } })).toBe(true);
    fetchSpy.mockRestore(); harness.stop(); store.close();
  });
  it('QQ 接入层可以独立接收并记录静默群消息，不依赖模型', async () => {
    const store = new Store(':memory:');
    const send = vi.fn(async () => ({ id: 'sent' }));
    const harness = new Harness(store, { send });
    const adapter = new QQAdapter({ appId: 'test-app', appSecret: 'test-secret' }, store, () => {});
    adapter.listen(harness);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const emitter = adapter.bot as unknown as { emit(event: string, ...values: unknown[]): Promise<void> };
    await emitter.emit('message', {}, { kind: 'group', senderId: 'user-1', senderName: '群友', groupOpenid: 'group-1', messageId: 'message-1', content: '一条日常聊天', timestamp: new Date().toISOString(), rawEventType: 'GROUP_MESSAGE_CREATE', raw: { source: 'qq' } });
    await emitter.emit('message', {}, { kind: 'group', senderId: 'user-1', groupOpenid: 'group-1', messageId: 'message-2', attachments: [{ content_type: 'image/png' }], timestamp: new Date().toISOString(), rawEventType: 'GROUP_MESSAGE_CREATE' });
    await vi.waitFor(() => expect(store.recent('group-1', 10)).toHaveLength(2));
    expect(store.recent('group-1', 10)[1]?.attachments).toContain('image/png');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    fetchSpy.mockRestore(); harness.stop(); store.close();
  });
  it('提取语音识别文本、识别图片并拒绝非 QQ 图片地址', async () => {
    const input = [{ content_type: 'audio/silk', asr_refer_text: '你好' }, { content_type: 'image/png', url: 'https://example.com/x.png' }];
    expect(voiceTranscripts(input)).toEqual(['你好']);
    const images = imageAttachments(input, [], '看看');
    expect(images).toHaveLength(1);
    const store=new Store(':memory:');const now=Date.now();
    store.record(event({id:'near-image',content:'',timestamp:new Date(now-21000).toISOString(),attachments:[{content_type:'image/png',url:'https://example.qq.com/p.png'}]}));
    expect(imageAttachments([],store.recent('group-a',10),'这个人',new Date(now).toISOString())).toHaveLength(1);
    expect(imageAttachments([],store.recent('group-a',10),'普通聊天',new Date(now+600000).toISOString())).toHaveLength(1);
    store.record(event({id:'image-discussion',content:'你图片为什么加载不出来',timestamp:new Date(now+1000).toISOString()}));
    expect(imageAttachments([],store.recent('group-a',10),'认真看下',new Date(now+30*86400000).toISOString())).toHaveLength(1);
    store.close();
    await expect(qqImageDataUrl(images[0]!)).rejects.toThrow('QQ 媒体地址');
    await expect(readPublicWebpage('http://127.0.0.1/')).rejects.toThrow('内网或本机');
  });
  it('搜索历史时保留同名群友各自的身份标识', async () => {
    const store = new Store(':memory:');
    const reply = new ReplyRuntime(store, { send: async () => ({}) });
    const tasks = new TaskManager(store, async () => '', async () => {});
    store.record(event({ id: 'a', senderId: 'id-a', senderName: '小王', content: '参与项目' }));
    store.record(event({ id: 'b', senderId: 'id-b', senderName: '小王', content: '讨论项目' }));
    const search = makeTools({ conversationId: 'group-a', scope: 'group', store, reply, tasks, background: false }).find((item) => item.name === 'search_chat_history');
    const result = JSON.parse(String(await search!.invoke({ query: '项目' }))) as { result: Array<{ senderId: string }> };
    expect(result.result.map((row) => row.senderId).sort()).toEqual(['id-a', 'id-b']);
    tasks.stop(); store.close();
  });
  it('聊天记录搜索可以逐页查到更久以前的同关键词消息', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      for(let i=0;i<25;i++)store.record(event({id:`history-page-${i}`,conversationId:'history-pages',content:`旧项目记录 ${i}`}));
      const search=makeTools({conversationId:'history-pages',scope:'group',store,reply,tasks,background:false}).find((item)=>item.name==='search_chat_history')!;
      const first=JSON.parse(String(await search.invoke({query:'旧项目'}))) as {result:Array<{sequence:number;content:string}>};
      const next=JSON.parse(String(await search.invoke({query:'旧项目',before:first.result.at(-1)!.sequence}))) as {result:Array<{sequence:number;content:string}>};
      expect(first.result).toHaveLength(20);expect(next.result).toHaveLength(5);expect(next.result.at(-1)?.content).toBe('旧项目记录 0');
    } finally {tasks.stop();store.close();}
  });
  it('不输入关键词也能顺序翻阅历史并分段读取长消息', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      for(let i=0;i<6;i++)store.record(event({id:`history-browse-${i}`,conversationId:'browse',content:i===0?'甲'.repeat(7000)+'尾部':`群友消息${i}`}));
      const tools=makeTools({conversationId:'browse',scope:'group',store,reply,tasks,background:false});
      const history=tools.find((item)=>item.name==='read_chat_history')!,message=tools.find((item)=>item.name==='read_chat_message')!;
      const first=JSON.parse(String(await history.invoke({limit:3}))) as {result:{messages:Array<{sequence:number}>;hasMore:boolean;nextBefore:number}};
      const next=JSON.parse(String(await history.invoke({limit:3,before:first.result.nextBefore}))) as {result:{messages:Array<{messageId:string;contentTruncated:boolean}>;hasMore:boolean}};
      expect(first.result.hasMore).toBe(true);expect(next.result.hasMore).toBe(false);expect(next.result.messages[0]).toMatchObject({messageId:'history-browse-0',contentTruncated:true});
      const part=JSON.parse(String(await message.invoke({messageId:'history-browse-0',offset:6000}))) as {result:{content:string;nextOffset:number|null}};
      expect(part.result.content.endsWith('尾部')).toBe(true);expect(part.result.nextOffset).toBeNull();
      const denied=JSON.parse(String(await message.invoke({messageId:'不存在',offset:0}))) as {ok:boolean};expect(denied.ok).toBe(false);
    } finally {tasks.stop();store.close();}
  });
});

describe('有序回复', () => {
  it('使用腾讯 SDK 将 PCM 编码成 SILK，并保留已有 SILK 文件', async () => {
    const encoder = await loadSilkWasm();
    expect(encoder).not.toBeNull();
    const encoded = await pcmToSilk(Buffer.alloc(4800), 24000);
    expect(encoder?.isSilk(encoded.silkBuffer)).toBe(true);
    const file = path.join(root, 'voice.silk'); fs.writeFileSync(file, encoded.silkBuffer);
    expect(await qqVoiceBuffer(file)).toEqual(encoded.silkBuffer);
  });
  it('先发送文件再发送文字；重放同一交付不会重复', async () => {
    const store = new Store(':memory:');
    const directory = workspaceFor('g');
    const file = path.join(directory, 'x.mp4'); fs.writeFileSync(file, 'demo');
    const delivered: string[] = [];
    const reply = new ReplyRuntime(store, { send: async (item) => { delivered.push(item.kind); return { id: `qq-${delivered.length}` }; } });
    await reply.send('g', 'group', 'm', 'video', file, 'x.mp4', 'task-1-video');
    await reply.send('g', 'group', 'm', 'text', '已发送', undefined, 'task-1-text');
    await reply.send('g', 'group', 'm', 'video', file, 'x.mp4', 'task-1-video');
    expect(delivered).toEqual(['video', 'text']);
    expect(store.recent('g', 10).map((row) => row.content)).toEqual(['[video] x.mp4', '已发送']);
    expect(splitText('甲。乙。丙。', 3).length).toBeGreaterThan(1);
    store.close();
  });
  it('映射到宿主机的文件可以发送，其他群工作区的文件不能发送', async () => {
    process.env.BOT_WORKSPACE_DIR = path.join(root, 'mapped-delivery');
    const store = new Store(':memory:');
    const send = vi.fn(async () => ({ id: 'qq-1' }));
    const reply = new ReplyRuntime(store, { send });
    try {
      const file = path.join(workspaceFor('mapped-a'), 'result.txt'); fs.writeFileSync(file, 'mapped');
      await reply.send('mapped-a', 'group', 'm', 'file', file, 'result.txt');
      expect(resolveWorkspaceFile('mapped-a', '/result.txt')).toBe(fs.realpathSync(file));
      expect(resolveWorkspaceFile('mapped-a', 'result.txt')).toBe(fs.realpathSync(file));
      const nested = path.join(workspaceFor('mapped-a'), 'app'); fs.mkdirSync(nested);
      const virtual = path.join(nested, 'diag.sh'); fs.writeFileSync(virtual, 'test');
      expect(resolveWorkspaceFile('mapped-a', '/app/diag.sh')).toBe(fs.realpathSync(virtual));
      await expect(reply.send('mapped-b', 'group', 'm', 'file', file, 'result.txt')).rejects.toThrow('当前会话');
      expect(send).toHaveBeenCalledTimes(1);
    } finally { delete process.env.BOT_WORKSPACE_DIR; store.close(); }
  });
  it('超时被记录为结果未知，不自动重复发送', async () => {
    const store = new Store(':memory:');
    const send = vi.fn(async () => { throw new Error('ETIMEDOUT'); });
    const reply = new ReplyRuntime(store, { send });
    await expect(reply.send('g', 'group', 'm', 'text', '内容', undefined, 'fixed')).rejects.toThrow('ETIMEDOUT');
    await expect(reply.send('g', 'group', 'm', 'text', '内容', undefined, 'fixed')).rejects.toThrow('结果未知');
    expect(send).toHaveBeenCalledTimes(1);
    store.close();
  });
});

describe('后台任务', () => {
  it('重启时恢复同一个中断任务并保留追加要求', async () => {
    const store=new Store(':memory:');
    const first=new TaskManager(store,async(_task,signal)=>new Promise<string>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true})}),async()=>{});
    const id=first.enqueue('recover-group','group','message','长任务');
    first.update(id,'recover-group','补充要求');
    first.stop();
    await new Promise((resolve)=>setTimeout(resolve,20));
    expect(store.task(id)?.status).toBe('interrupted');
    const calls:string[]=[];
    const second=new TaskManager(store,async(task)=>{calls.push(task.instruction);return '恢复结果'},async()=>{});
    second.start();
    await vi.waitFor(()=>expect(store.task(id)?.status).toBe('completed'));
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('补充要求');
    second.stop();store.close();
  });
  it('子 Agent 可直接发送文件，主 Agent 回调重放同一文件不会重复投递', async () => {
    const store = new Store(':memory:');
    const sent: string[] = [];
    const reply = new ReplyRuntime(store, { send: async (item) => { sent.push(item.kind); return { id: `qq-${sent.length}` }; } });
    const tasks = new TaskManager(store, async () => '', async () => {});
    const file = path.join(workspaceFor('group-direct'), 'result.txt'); fs.writeFileSync(file, 'ok');
    const ctx = { conversationId: 'group-direct', scope: 'group' as const, replyTo: 'msg', store, reply, tasks, taskId: 'task-test' };
    const child = makeTools({ ...ctx, background: true }).find((item) => item.name === 'send_media');
    const parent = makeTools({ ...ctx, background: false }).find((item) => item.name === 'send_media');
    expect(child).toBeDefined(); expect(parent).toBeDefined();
    await child!.invoke({ file, kind: 'file' });
    await parent!.invoke({ file, kind: 'file' });
    expect(sent).toEqual(['file']);
    tasks.stop(); store.close();
  });
  it('启动立即返回，完成后回调且记录状态', async () => {
    const store = new Store(':memory:');
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const callback = vi.fn(async () => {});
    const manager = new TaskManager(store, async () => { await wait; return 'result'; }, callback);
    const id = manager.enqueue('g', 'group', 'msg', '下载');
    expect(store.task(id)?.status).toBe('running');
    release();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(store.task(id)?.notified).toBe(1));
    expect(store.task(id)?.result).toBe('result');
    manager.stop(); store.close();
  });
  it('子 Agent 可提出问题、唤醒主流程并接收补充答复', async () => {
    const store = new Store(':memory:');
    const callback = vi.fn(async () => {});
    let manager!: InstanceType<typeof TaskManager>;
    manager = new TaskManager(store, async (task, signal) => {
      const answer = await manager.requestInput(task.id, '需要哪种格式？', signal);
      return `用户选择了 ${answer}`;
    }, callback);
    const id = manager.enqueue('g', 'group', 'msg', '转换');
    await vi.waitFor(() => expect(store.task(id)?.status).toBe('waiting'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(manager.update(id, 'g', 'MP3')).toContain('答复');
    await vi.waitFor(() => expect(store.task(id)?.status).toBe('completed'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(store.task(id)?.result).toContain('MP3');
    manager.stop(); store.close();
  });
  it('执行中的子 Agent 可以把进度作为独立事件回调', async () => {
    const store = new Store(':memory:');
    const callback = vi.fn(async () => {});
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let manager!: InstanceType<typeof TaskManager>;
    manager = new TaskManager(store, async (task) => { manager.reportProgress(task.id, '下载完成，正在转换'); await wait; return '完成'; }, callback);
    const id = manager.enqueue('g', 'group', 'msg', '下载');
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback.mock.calls[0]?.[0]).toMatchObject({ id, status: 'progress', result: '下载完成，正在转换' });
    release();
    await vi.waitFor(() => expect(store.task(id)?.status).toBe('completed'));
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    manager.stop(); store.close();
  });
});

describe('真实 LangChain + Deep Agents 调用链', () => {
  let server: http.Server;
  let port = 0;
  let fileToSend = '';
  let releaseInterjection: (() => void) | undefined;
  let releaseQueued: (() => void) | undefined;
  let releaseReview: (() => void) | undefined;
  let releaseRecovery: (() => void) | undefined;
  let releaseSummary: (() => void) | undefined;
  let resumeRecovery = false;
  const requests: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown; name?: string; reasoning_content?: string }> };
        requests.push(parsed as unknown as Record<string, unknown>);
        if (req.url?.endsWith('/v1/messages')) {
          const text=JSON.stringify(parsed.messages);
          if(text.includes('兼容接口历史图片测试')) {
            const content=text.includes('anthropic-image-read')?[{type:'text',text:text.includes('"type":"image"')?'已收到历史图片':'没有收到历史图片'}]:text.includes('anthropic-image-list')?[{type:'tool_use',id:'anthropic-image-read',name:'read_chat_image',input:{messageId:'anthropic-picture',index:0}}]:[{type:'tool_use',id:'anthropic-image-list',name:'list_chat_images',input:{}}];
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({id:`anthropic-test-${requests.length}`,type:'message',role:'assistant',model:'test-model',content,stop_reason:content[0]?.type==='tool_use'?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:5}}));return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg-test', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'tool_use', id: 'probe-1', name: 'startup_probe', input: {} }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
          return;
        }
        const allText = JSON.stringify(parsed.messages);
        if (allText.includes('模型余额错误测试')) {
          res.writeHead(402,{'Content-Type':'application/json'});
          res.end(JSON.stringify({error:{message:'Insufficient Balance',type:'insufficient_balance_error',code:'invalid_request_error'}}));
          return;
        }
        if (allText.includes('群聊答复语义复核器')) {
          if (allText.includes('复核期间插话测试')) {
            releaseReview=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'held-review',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({needsRevision:false,reason:''})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))};
            return;
          }
          const issue=allText.includes('语义复核测试标记') || allText.includes('无关插话复核测试');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({id:'review',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({needsRevision:issue,reason:issue?(allText.includes('无关插话复核测试')?'把无关群聊带进了答复':'没有向群友提出实际问题'):''})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
          return;
        }
        if (allText.includes('累计群聊摘要') && allText.includes('项目讨论 0')) {
          releaseSummary = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id:'summary',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify({summary:'群友曾谈论长期项目',memories:[]})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} })); };
          return;
        }
        if (allText.includes('插话整合测试') && !allText.includes('关键补充')) {
          releaseInterjection = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id:'held',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'旧答案'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} })); };
          return;
        }
        if (allText.includes('队列首轮测试') && !allText.includes('队列次轮测试')) {
          releaseQueued=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'queued-held',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'上一轮刚刚发出的答复'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))};return;
        }
        const asyncScenario = allText.includes('后台处理指定测试');
        const isChild = allText.includes('容器沙箱中的后台任务执行者');
        const callback = allText.includes('后台任务通知');
        const fileScenario = allText.includes('指定文件');
        const thinkingScenario = allText.includes('思考工具回放');
        const internalScenario = allText.includes('内部子助手隔离测试');
        const isInternalAgent = allText.includes('你是主 Agent 的内部执行助手');
        const permissionScenario = allText.includes('尝试写入权限验证');
        const last = parsed.messages.at(-1);
        if (allText.includes('恢复中途测试') && isChild && last?.role === 'tool' && !resumeRecovery) {
          releaseRecovery=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'resume-held',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message:{role:'assistant',content:'任务恢复完成'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))};
          return;
        }
        let reply: Record<string, unknown>;
        if (allText.includes('工具死循环模拟')) reply={role:'assistant',content:null,tool_calls:[{id:`loop-${requests.length}`,type:'function',function:{name:'sandbox_capabilities',arguments:'{}'}}]};
        else if (allText.includes('视觉自主测试')) reply=allText.includes('data:image/png;base64,')?{role:'assistant',content:'已结合图片继续回答'}:{role:'assistant',content:null,tool_calls:[{id:'autonomous-image',type:'function',function:{name:'read_chat_image',arguments:JSON.stringify({messageId:'autonomous-picture',index:0})}}]};
        else if (allText.includes('历史图片回查测试')) {
          const toolMessages=parsed.messages.filter((message)=>message.role==='tool');
          if(!toolMessages.some((message)=>message.name==='list_chat_images')) reply={role:'assistant',content:null,tool_calls:[{id:'image-list',type:'function',function:{name:'list_chat_images',arguments:'{}'}}]};
          else if(!toolMessages.some((message)=>message.name==='read_chat_image')) reply={role:'assistant',content:null,tool_calls:[{id:'image-read',type:'function',function:{name:'read_chat_image',arguments:JSON.stringify({messageId:'history-picture',index:0})}}]};
          else reply={role:'assistant',content:allText.includes('data:image/png;base64,')?'已读取历史图片':'没有收到图片'};
        }
        else if (allText.includes('工具按需加载测试') && last?.role !== 'tool') reply={role:'assistant',content:null,tool_calls:[{id:'discover-test',type:'function',function:{name:'find_tools',arguments:JSON.stringify({names:['inspect_media']})}}]};
        else if (allText.includes('工具按需加载测试') && last?.name==='find_tools') reply={role:'assistant',content:null,tool_calls:[{id:'inspect-test',type:'function',function:{name:'inspect_media',arguments:JSON.stringify({input:'/不存在的测试文件'})}}]};
        else if (allText.includes('工具按需加载测试')) reply={role:'assistant',content:'已核实工具调用结果'};
        else if (allText.includes('复核期间插话测试') && allText.includes('插话发生在复核期间')) reply={role:'assistant',content:'已考虑复核期间的插话'};
        else if (allText.includes('复核期间插话测试')) reply={role:'assistant',content:'最初草稿'};
        else if (allText.includes('无关插话复核测试') && allText.includes('上一条只是尚未发送')) reply={role:'assistant',content:'7 加 5 等于 12。'};
        else if (allText.includes('无关插话复核测试')) reply={role:'assistant',content:'7 加 5 等于 12。乙，你去哪里旅游？'};
        else if (allText.includes('语义复核测试标记') && allText.includes('上一条只是尚未发送')) reply={role:'assistant',content:'群友们，你们觉得呢？'};
        else if (allText.includes('语义复核测试标记')) reply={role:'assistant',content:'好，我去问问。'};
        else if (internalScenario && isInternalAgent) reply = {role:'assistant',content:'查证完成'};
        else if (internalScenario && last?.role !== 'tool') reply = {role:'assistant',content:null,tool_calls:[{id:'internal-task',type:'function',function:{name:'task',arguments:JSON.stringify({description:'内部子助手隔离测试',subagent_type:'general-purpose'})}}]};
        else if (internalScenario) reply = {role:'assistant',content:'主 Agent 已收到结果'};
        else if (allText.includes('插话整合测试') && allText.includes('关键补充')) reply = { role:'assistant',content:'已看到群友的关键补充' };
        else if (allText.includes('恢复中途测试') && isChild && last?.role !== 'tool') reply={role:'assistant',content:null,tool_calls:[{id:'recovery-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({file_path:'/recovery.txt',content:'checkpoint'})}}]};
        else if (allText.includes('恢复中途测试') && isChild) reply={role:'assistant',content:'任务恢复完成'};
        else if (permissionScenario && last?.role !== 'tool') reply = { role: 'assistant', content: null, tool_calls: [{ id: 'denied-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: '/denied.txt', content: 'must not be written' }) } }] };
        else if (permissionScenario) reply = { role: 'assistant', content: '权限测试完成' };
        else if (thinkingScenario && last?.role !== 'tool') reply = { role: 'assistant', content: null, reasoning_content: 'provider-thinking-token', tool_calls: [{ id: 'thinking-call', type: 'function', function: { name: 'send_text', arguments: JSON.stringify({ text: '处理中' }) } }] };
        else if (thinkingScenario) {
          const prior = parsed.messages.find((message) => message.role === 'assistant' && message.reasoning_content === 'provider-thinking-token');
          reply = { role: 'assistant', content: prior ? '回放成功' : '回放丢失' };
        }
        else if (allText.includes('累计群聊摘要')) reply = { role: 'assistant', content: JSON.stringify({ summary: '群友曾谈论长期项目', memories: [{ subjectId: 'user-a', content: '小王负责长期项目' }] }) };
        else if (asyncScenario && isChild) reply = { role: 'assistant', content: `任务完成，文件位于 ${fileToSend}` };
        else if (asyncScenario && callback && last?.role !== 'tool') reply = { role: 'assistant', content: null, tool_calls: [{ id: `tool-send-${requests.length}`, type: 'function', function: { name: 'send_media', arguments: JSON.stringify({ file: fileToSend, kind: 'file' }) } }] };
        else if (asyncScenario && callback) reply = { role: 'assistant', content: '后台处理完成，文件已发送。' };
        else if (asyncScenario && last?.role !== 'tool') reply = { role: 'assistant', content: null, tool_calls: [{ id: `tool-start-${requests.length}`, type: 'function', function: { name: 'start_background_task', arguments: JSON.stringify({ instruction: '后台处理指定测试，并发送生成的文件', acknowledgement:'好呀，我去后台处理～' }) } }] };
        else if (asyncScenario) reply = { role: 'assistant', content: '已开始后台处理。' };
        else reply = fileScenario && last?.role !== 'tool'
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'send_media', arguments: JSON.stringify({ file: fileToSend, kind: 'file' }) } }] }
          : { role: 'assistant', content: fileScenario ? '文件已发送。' : '记得，小王刚买了 NAS。' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `chatcmpl-test-${requests.length}`, object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: reply, finish_reason: 'tool_calls' in reply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    process.env.MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  it('可使用 Anthropic 兼容接口并解析工具调用', async () => {
    const oldUrl = process.env.MODEL_BASE_URL;
    process.env.MODEL_PROVIDER = 'anthropic'; process.env.MODEL_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const probe = tool(async () => 'ok', { name: 'startup_probe', description: 'test', schema: z.object({}) });
      const result = await makeModel().bindTools([probe]).invoke('请调用工具');
      expect(result.tool_calls?.[0]?.name).toBe('startup_probe');
    } finally { delete process.env.MODEL_PROVIDER; process.env.MODEL_BASE_URL = oldUrl; }
  });
  it('OpenAI 兼容思考字段在工具调用后的下一次请求中被保留', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: `qq-${delivered.length}` }; } });
    await harness.receive(event({ id: 'thinking', conversationId: 'group-thinking', content: '思考工具回放', isMention: true }));
    await vi.waitFor(() => expect(delivered.length).toBe(2), { timeout: 15000 });
    expect(delivered.map((item) => item.content)).toEqual(['处理中', '回放成功']);
    expect(delivered.some((item) => item.content.includes('provider-thinking-token'))).toBe(false);
    harness.stop(); store.close();
  }, 20000);
  it('禁用工作区写权限后，Deep Agents 文件工具不能写入', async () => {
    const original = fs.readFileSync(configPath, 'utf8');
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: 'qq-1' }; } });
    const file = path.join(workspaceFor('group-denied'), 'denied.txt');
    try {
      const config = parseYaml(original); config.sandbox.permissions.workspaceWrite = false;
      fs.writeFileSync(configPath, stringifyYaml(config));
      await harness.receive(event({ id: 'permission', conversationId: 'group-denied', content: '尝试写入权限验证', isMention: true }));
      await vi.waitFor(() => expect(delivered.length).toBe(1), { timeout: 15000 });
      expect(fs.existsSync(file)).toBe(false);
      expect(delivered[0]?.content).toBe('权限测试完成');
    } finally { fs.writeFileSync(configPath, original); harness.stop(); store.close(); }
  }, 20000);
  it('触发后将此前静默消息及说话人交给模型并发送结果', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: 'qq-1' }; } });
    const before = requests.length;
    await harness.receive(event({ id: 'old' }));
    store.memory.saveConversationMember('group','group-a','user-a','小王备注','负责存储设备');
    expect(requests).toHaveLength(before);
    await harness.receive(event({ id: 'trigger', senderId: 'user-b', senderName: '小李', content: '小王买了什么？', isMention: true }));
    await vi.waitFor(() => expect(delivered.length).toBe(1), { timeout: 15000 });
    expect(delivered[0]?.content).toContain('NAS');
    const mainRequest=requests.slice(before).find((request)=>!JSON.stringify(request.messages).includes('群聊答复语义复核器'));
    expect(JSON.stringify(mainRequest?.messages)).toContain('刚买了 NAS');
    expect(JSON.stringify(mainRequest?.messages)).toContain('小王');
    expect(JSON.stringify(mainRequest?.messages)).toContain('小王备注');
    expect(JSON.stringify(mainRequest?.messages)).toContain('负责存储设备');
    expect(JSON.stringify(mainRequest?.messages)).toContain('当前已加载的聊天原文（按时间顺序');
    const modelMessages=mainRequest?.messages as Array<{role:string;content:unknown}>;
    const system=JSON.stringify(modelMessages.filter((message)=>message.role==='system'));
    const user=JSON.stringify(modelMessages.filter((message)=>message.role==='user'));
    expect(system).toContain('持续生效的核心人格');expect(system).toContain('自行判断是否需要 @ 某人');expect(system).toContain('尽量用合适的格式突出重点');expect(system).toContain('由你根据表达需要决定');
    expect(system).not.toContain('负责存储设备');expect(user).toContain('负责存储设备');
    harness.stop(); store.close();
  }, 20000);
  it('模型返回余额不足时保留原始消息并向群里说明', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'balance-error'}}});
    await harness.receive(event({id:'balance-fail',conversationId:'group-balance',content:'模型余额错误测试',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toContain('余额或额度不足');
    expect(store.recent('group-balance',10).some((row)=>row.content==='模型余额错误测试')).toBe(true);
    harness.stop();store.close();
  },20000);
  it('创建者主动触发且余额不足时直接艾特创建者，即使已主动提醒过', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    store.record(event({id:'owner-seed',conversationId:'group-owner-balance',senderId:'owner',content:'之前的消息'}));
    store.memory.setOwner(store.memory.lookup('group','group-owner-balance','owner')!);
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'owner-balance-error'}}});
    harness.balanceAlert.notified();
    await harness.receive(event({id:'owner-balance-fail',conversationId:'group-owner-balance',senderId:'owner',content:'模型余额错误测试',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toBe('<qqbot-at-user id="owner" /> 主人，我的饭饭吃光啦，呜呜……');
    harness.stop();store.close();
  },20000);
  it('前台工具循环在递归上限之前停止并说明情况', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'loop-response'}}});
    const before=requests.length;
    await harness.receive(event({id:'loop',conversationId:'group-tool-loop',content:'工具死循环模拟',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toContain('步骤过多');
    expect(requests.length-before).toBeLessThanOrEqual(12);
    harness.stop();store.close();
  },20000);
  it('旧摘要的截断位置不会裁掉新一轮用户消息', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:`stale-${delivered.length}`}}});
    await harness.receive(event({id:'stale-first',conversationId:'group-stale-summary',content:'第一轮',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    const saver=SqliteSaver.fromConnString(checkpointPath);
    const tuple=await saver.getTuple({configurable:{thread_id:'group:group-stale-summary'}});
    expect(tuple).toBeDefined();
    tuple!.checkpoint.channel_values._summarizationEvent={cutoffIndex:153,summaryMessage:new HumanMessage('过期的旧摘要'),filePath:'/conversation_history/old.md'};
    tuple!.checkpoint.channel_versions._summarizationEvent=tuple!.checkpoint.channel_versions.messages!;
    await saver.put(tuple!.config,tuple!.checkpoint,tuple!.metadata!);
    const before=requests.length;
    await harness.receive(event({id:'stale-second',conversationId:'group-stale-summary',content:'这是新一轮真实请求',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(2),{timeout:15000});
    const main=requests.slice(before).find((request)=>!JSON.stringify(request.messages).includes('群聊答复语义复核器'));
    expect(JSON.stringify(main?.messages)).toContain('这是新一轮真实请求');
    expect(JSON.stringify(main?.messages)).not.toContain('过期的旧摘要');
    harness.stop();store.close();
  },20000);
  it('单独 @ 唤醒时把此前连续发言作为同一段对话，同时保留不同发言人', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'focus-response'}}});
    const now=Date.now();const at=(offset:number)=>new Date(now+offset).toISOString();
    await harness.receive(event({id:'old-focus',conversationId:'group-focus',content:'之前已经结束的讨论',timestamp:at(-20000)}));
    store.recordSent({id:'old-reply',conversationId:'group-focus',scope:'group',kind:'text',content:'上一轮已经回答'},'old-reply');
    const before=requests.length;
    expect(await harness.receive(event({id:'focus-1',conversationId:'group-focus',senderId:'user-a',senderName:'甲',content:'你就是大肥鱼啊',timestamp:at(1000)}))).toBe(false);
    expect(await harness.receive(event({id:'focus-other',conversationId:'group-focus',senderId:'user-b',senderName:'乙',content:'另一位群友插话',timestamp:at(2000)}))).toBe(false);
    expect(await harness.receive(event({id:'focus-2',conversationId:'group-focus',senderId:'user-a',senderName:'甲',content:'你不信问问其他人',timestamp:at(3000)}))).toBe(false);
    expect(requests).toHaveLength(before);
    await harness.receive(event({id:'focus-trigger',conversationId:'group-focus',senderId:'user-a',senderName:'甲',content:'<@bot>',isMention:true,timestamp:at(4000)}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    const messages=requests.slice(before).find((request)=>!JSON.stringify(request.messages).includes('群聊答复语义复核器'))?.messages as Array<{role:string;content:unknown}>;
    const content=String(messages.find((message)=>message.role==='user' && String(message.content).includes('当前已加载的聊天原文'))?.content);
    const context=content.split('当前已加载的聊天原文')[1]!.split('当前请求：')[0]!;
    expect(context).toContain('之前已经结束的讨论');expect(context).toContain('上一轮已经回答');expect(context).toContain('你就是大肥鱼啊');expect(context).toContain('另一位群友插话');expect(context).toContain('你不信问问其他人');
    expect(content).toContain('这次只有 @ 没有附带文字');
    expect(store.recent('group-focus',20).filter((row)=>row.direction==='in')).toHaveLength(5);
    harness.stop();store.close();
  },20000);
  it('间隔很久后单独 @ 仍保留上一轮之后的发起人消息', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'delayed-focus'}}});
    try {
      const before=requests.length,now=Date.now();
      await harness.receive(event({id:'delayed-text',conversationId:'delayed-focus',content:'这是我之前说的重要问题',timestamp:new Date(now-86400000).toISOString()}));
      await harness.receive(event({id:'delayed-at',conversationId:'delayed-focus',content:'<@bot>',isMention:true,timestamp:new Date(now).toISOString()}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const request=JSON.stringify(requests.slice(before).find((item)=>JSON.stringify(item.messages).includes('这是我之前说的重要问题'))?.messages);
      expect(request).toContain('发起人在上一条机器人回复之后分段说的话');expect(request).toContain('这是我之前说的重要问题');
    } finally {harness.stop();store.close();}
  },20000);
  it('单独 @ 的多句对话漏掉明确互动时先复核再生成，只发送修正后的回复', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'reviewed'}}});const now=Date.now();const at=(n:number)=>new Date(now+n).toISOString();
    store.recordSent({id:'review-old',conversationId:'group-review',scope:'group',kind:'text',content:'我在'},'review-old');
    const before=requests.length;
    await harness.receive(event({id:'review-1',conversationId:'group-review',content:'语义复核测试标记',timestamp:at(1000)}));
    await harness.receive(event({id:'review-2',conversationId:'group-review',content:'问问大家怎么看',timestamp:at(2000)}));
    expect(requests).toHaveLength(before);
    await harness.receive(event({id:'review-trigger',conversationId:'group-review',content:'<@bot>',isMention:true,timestamp:at(3000)}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toBe('群友们，你们觉得呢？');
    expect(requests.slice(before)).toHaveLength(3);
    expect(store.recent('group-review',10).filter((row)=>row.direction==='in')).toHaveLength(3);
    harness.stop();store.close();
  },20000);
  it('发起人只说一句、其他群友接话后单独 @ 时也触发复核', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'review-bare'}}});
    const now=Date.now();store.recordSent({id:'bare-old',conversationId:'group-bare',scope:'group',kind:'text',content:'我在'},'bare-old');
    await harness.receive(event({id:'bare-1',conversationId:'group-bare',senderId:'user-a',content:'你听到他的回答了吗',timestamp:new Date(now+1000).toISOString()}));
    await harness.receive(event({id:'bare-2',conversationId:'group-bare',senderId:'user-b',content:'我已经回答了',timestamp:new Date(now+2000).toISOString()}));
    const before=requests.length;
    await harness.receive(event({id:'bare-3',conversationId:'group-bare',senderId:'user-a',content:'<@bot>',isMention:true,timestamp:new Date(now+3000).toISOString()}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(requests.slice(before).some((request)=>JSON.stringify(request.messages).includes('群聊答复语义复核器'))).toBe(true);
    harness.stop();store.close();
  },20000);
  it('多群友场景复核明显无关的插话，不把其他人的闲聊强行当成当前请求', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'review-other'}}});
    const now=Date.now();store.recordSent({id:'unrelated-old',conversationId:'group-unrelated',scope:'group',kind:'text',content:'我在'},'unrelated-old');
    await harness.receive(event({id:'unrelated-1',conversationId:'group-unrelated',senderId:'other',senderName:'乙',content:'无关插话复核测试：明天去旅游',timestamp:new Date(now+1000).toISOString()}));
    await harness.receive(event({id:'unrelated-trigger',conversationId:'group-unrelated',content:'<@bot> 7 加 5 等于多少？',isMention:true,timestamp:new Date(now+2000).toISOString()}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});expect(delivered[0]?.content).toBe('7 加 5 等于 12。');
    harness.stop();store.close();
  },20000);
  it('关闭语义复核后多人聊天不增加复核模型调用', async () => {
    const original=fs.readFileSync(configPath,'utf8');const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'review-disabled'}}});
    try {
      const config=parseYaml(original);config.model.semanticReview=false;fs.writeFileSync(configPath,stringifyYaml(config));
      const now=Date.now();store.recordSent({id:'disabled-old',conversationId:'group-review-disabled',scope:'group',kind:'text',content:'我在'},'disabled-old');
      await harness.receive(event({id:'disabled-other',conversationId:'group-review-disabled',senderId:'other',content:'无关插话复核测试：明天去旅游',timestamp:new Date(now+1000).toISOString()}));
      const before=requests.length;
      await harness.receive(event({id:'disabled-trigger',conversationId:'group-review-disabled',content:'7 加 5 等于多少',isMention:true,timestamp:new Date(now+2000).toISOString()}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      expect(requests.slice(before).some((request)=>JSON.stringify(request.messages).includes('群聊答复语义复核器'))).toBe(false);
      expect(delivered[0]?.content).toContain('旅游');
    } finally {fs.writeFileSync(configPath,original);harness.stop();store.close();}
  },20000);
  it('语义复核期间收到的新群消息，在发送前再次纳入本轮', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'review-late'}}});
    const now=Date.now();releaseReview=undefined;store.recordSent({id:'late-old',conversationId:'group-review-late',scope:'group',kind:'text',content:'我在'},'late-old');
    await harness.receive(event({id:'late-1',conversationId:'group-review-late',content:'复核期间插话测试',timestamp:new Date(now+1000).toISOString()}));
    await harness.receive(event({id:'late-2',conversationId:'group-review-late',content:'请一起看看',timestamp:new Date(now+2000).toISOString()}));
    await harness.receive(event({id:'late-trigger',conversationId:'group-review-late',content:'<@bot>',isMention:true,timestamp:new Date(now+3000).toISOString()}));
    await vi.waitFor(()=>expect(releaseReview).toBeDefined(),{timeout:15000});
    expect(await harness.receive(event({id:'late-3',conversationId:'group-review-late',senderId:'other',senderName:'乙',content:'插话发生在复核期间',timestamp:new Date(now+4000).toISOString()}))).toBe(false);
    releaseReview!();await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toBe('已考虑复核期间的插话');
    harness.stop();store.close();
  },20000);
  it('将真实引用和可委派的后台下载能力交给主 Agent', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'qq-quote'}}});
    await harness.receive(event({id:'quoted-trigger',conversationId:'group-quote',content:'你现在能下载吗',isMention:true,raw:{refMsgIdx:'quoted',msgElements:[{message_type:103,msg_idx:'quoted',content:'此前关于下载能力的消息'}]}}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    const request=JSON.stringify(requests.at(-1)?.messages);
    expect(request).toContain('用户引用的消息');expect(request).toContain('此前关于下载能力的消息');expect(request).toContain('backgroundOnlyTools');expect(request).toContain('download_media');expect(request).toContain('supportedMediaSites');
    harness.stop();store.close();
  },20000);
  it('真实 Agent 先发现工具，再动态加载并执行，普通消息不触发', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'dynamic-ok'}}});
    try {
      const before=requests.length;
      expect(await harness.receive(event({id:'dynamic-silent',conversationId:'dynamic-group',content:'不触发'}))).toBe(false);
      expect(requests).toHaveLength(before);
      await harness.receive(event({id:'dynamic-trigger',conversationId:'dynamic-group',content:'工具按需加载测试',isMention:true}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const calls=requests.slice(before).filter((item)=>JSON.stringify(item.messages).includes('工具按需加载测试'));
      const names=(item:Record<string,unknown>)=>((item.tools ?? []) as Array<{function?:{name?:string}}>).map((entry)=>entry.function?.name);
      expect(calls.length).toBeGreaterThanOrEqual(3);
      expect(names(calls[0]!)).toContain('find_tools');expect(names(calls[0]!)).not.toContain('inspect_media');
      expect(names(calls[1]!)).toContain('inspect_media');
      expect(store.db.prepare("SELECT candidates FROM tool_discoveries WHERE conversation_id='dynamic-group' AND kind='search'").get()).toMatchObject({candidates:'["inspect_media"]'});
      expect((store.db.prepare("SELECT COUNT(*) AS n FROM execution_metrics WHERE conversation_id='dynamic-group' AND name='inspect_media'").get() as {n:number}).n).toBe(1);
    } finally {harness.stop();store.close();}
  },20000);
  it('模型根据连续聊天里的附件线索自主选择回看图片', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'autonomous-response'}}});
    const original=globalThis.fetch;const imageFetch=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Buffer.from('测试图片'),{headers:{'content-type':'image/png'}})):original(input,init));
    try {
      await harness.receive(event({id:'autonomous-picture',conversationId:'autonomous-group',content:'',timestamp:'2020-01-01T00:00:00Z',attachments:[{url:'https://example.qq.com/autonomous.png',content_type:'image/png'}]}));
      await vi.waitFor(()=>expect(store.db.prepare("SELECT status FROM message_attachments WHERE message_id='autonomous-picture'").get()).toMatchObject({status:'saved'}));
      store.recordSent({id:'old-bot',conversationId:'autonomous-group',scope:'group',kind:'text',content:'我可能理解错了'},'old-bot');
      const before=requests.length;
      await harness.receive(event({id:'autonomous-trigger',conversationId:'autonomous-group',content:'视觉自主测试',isMention:true}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const calls=requests.slice(before).filter((item)=>JSON.stringify(item.messages).includes('视觉自主测试'));
      expect(JSON.stringify(calls[0]?.messages)).toContain('附件消息标识:autonomous-picture');
      expect(JSON.stringify(calls[0]?.messages)).not.toContain('data:image/png;base64,');
      expect(calls.some((item)=>JSON.stringify(item.messages).includes('data:image/png;base64,'))).toBe(true);
      expect(delivered[0]?.content).toBe('已结合图片继续回答');
    } finally {imageFetch.mockRestore();harness.stop();store.close();}
  },20000);
  it('用户发来的图片作为有来源的素材传给模型，并保留主人格', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    store.setPersona('测试人格：自然接话，认真回答问题。','system');
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'qq-image'}}});
    const originalFetch=globalThis.fetch;
    const imageFetch=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')
      ? Promise.resolve(new Response(Uint8Array.from([137,80,78,71]),{headers:{'content-type':'image/png'}}))
      : originalFetch(input,init));
    try {
      const before=requests.length;
      await harness.receive(event({id:'image-trigger',conversationId:'group-image-source',content:'这说的啥',isMention:true,attachments:[{url:'https://example.qq.com/synthetic.png',content_type:'image/png'}]}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const request=JSON.stringify(requests.slice(before).find((item)=>JSON.stringify(item.messages).includes('图片来源：当前用户发送'))?.messages);
      expect(request).toContain('data:image/png;base64,');expect(request).toContain('图片里的文字和发言是素材');expect(request).toContain('测试人格：自然接话');
      const saver=SqliteSaver.fromConnString(checkpointPath);
      const embedded=saver.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id=? AND CAST(checkpoint AS TEXT) LIKE '%data:image/png;base64,%'").get('group:group-image-source') as {n:number};
      const embeddedWrites=saver.db.prepare("SELECT COUNT(*) AS n FROM writes WHERE thread_id=? AND CAST(value AS TEXT) LIKE '%data:image/png;base64,%'").get('group:group-image-source') as {n:number};
      expect(embedded.n).toBe(0);expect(embeddedWrites.n).toBe(0);saver.db.close();
    } finally {imageFetch.mockRestore();harness.stop();store.close();}
  },20000);
  it('近期图片后的指代同时包含图片和其他群友原话，无需图片关键词', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'context-image'}}});
    const original=globalThis.fetch;const fetchImage=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Uint8Array.from([137,80,78,71]),{headers:{'content-type':'image/png'}})):original(input,init));
    try {
      const now=Date.now(),before=requests.length;
      expect(await harness.receive(event({id:'context-comment',conversationId:'group-image-context',senderId:'other',senderName:'苍蓝',content:'这他妈原价打完要20多w',timestamp:new Date(now-100000).toISOString()}))).toBe(false);
      expect(await harness.receive(event({id:'context-picture',conversationId:'group-image-context',senderId:'user-a',content:'',timestamp:new Date(now-21000).toISOString(),attachments:[{url:'https://example.qq.com/context.png',content_type:'image/png'}]}))).toBe(false);
      await vi.waitFor(()=>expect(store.db.prepare("SELECT status FROM message_attachments WHERE message_id='context-picture'").get()).toMatchObject({status:'saved'}));
      expect(requests).toHaveLength(before);
      await harness.receive(event({id:'context-trigger',conversationId:'group-image-context',content:'大肥鱼说说这个吐脏话的人',isMention:true,timestamp:new Date(now).toISOString()}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const request=requests.slice(before).find((item)=>JSON.stringify(item.messages).includes('大肥鱼说说这个吐脏话的人'));
      const text=JSON.stringify(request?.messages);
      expect(text).toContain('data:image/png;base64,');expect(text).toContain('图片来源：聊天记录中已加载的图片');
      expect(text).toContain('苍蓝');expect(text).toContain('这他妈原价打完要20多w');
      expect(text).toContain('不要把当前消息无附件');
      expect(requests.slice(before).some((item)=>JSON.stringify(item.messages).includes('群聊答复语义复核器'))).toBe(false);
    } finally {fetchImage.mockRestore();harness.stop();store.close();}
  },20000);
  it('明确引用多年前的图片时，不会误选附近其他图片', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'quoted-image'}}});
    const original=globalThis.fetch;const imageFetch=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?Promise.resolve(new Response(Buffer.from(String(input).endsWith('old.png')?'old-image':'new-image'),{headers:{'content-type':'image/png'}})):original(input,init));
    try {
      await harness.receive(event({id:'quoted-old',conversationId:'quoted-image-group',content:'',timestamp:'2020-01-01T00:00:00Z',attachments:[{url:'https://example.qq.com/old.png',content_type:'image/png'}]}));
      await vi.waitFor(()=>expect(store.db.prepare("SELECT status FROM message_attachments WHERE message_id='quoted-old'").get()).toMatchObject({status:'saved'}));
      for(let i=0;i<65;i++)await harness.receive(event({id:`quoted-filler-${i}`,conversationId:'quoted-image-group',content:`消息 ${i}`}));
      await harness.receive(event({id:'quoted-new',conversationId:'quoted-image-group',content:'',attachments:[{url:'https://example.qq.com/new.png',content_type:'image/png'}]}));
      const before=requests.length;
      await harness.receive(event({id:'quoted-request',conversationId:'quoted-image-group',content:'这里面是谁',isMention:true,raw:{refMsgIdx:'quoted-old'}}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      const request=JSON.stringify(requests.slice(before).find((item)=>JSON.stringify(item.messages).includes('这里面是谁'))?.messages);
      expect(request).toContain(Buffer.from('old-image').toString('base64'));expect(request).not.toContain(Buffer.from('new-image').toString('base64'));
    } finally {imageFetch.mockRestore();harness.stop();store.close();}
  },20000);
  it('很久以前且超出近期消息窗口的图片能自动回查并送入模型', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'history-image'}}});
    const original=globalThis.fetch;let online=true;const imageFetch=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?(online?Promise.resolve(new Response(Uint8Array.from([137,80,78,71]),{headers:{'content-type':'image/png'}})):Promise.reject(new Error('原地址已过期'))):original(input,init));
    try {
      const before=requests.length;
      await harness.receive(event({id:'history-picture',conversationId:'history-image-group',content:'',timestamp:'2020-01-01T00:00:00Z',attachments:[{url:'https://example.qq.com/old.png',content_type:'image/png'}]}));
      await vi.waitFor(()=>expect(store.db.prepare("SELECT status FROM message_attachments WHERE message_id='history-picture'").get()).toMatchObject({status:'saved'}));online=false;
      for(let i=0;i<75;i++)await harness.receive(event({id:`history-filler-${i}`,conversationId:'history-image-group',content:`群聊 ${i}`}));
      expect(requests).toHaveLength(before);
      await harness.receive(event({id:'history-trigger',conversationId:'history-image-group',content:'历史图片回查测试',isMention:true}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      expect(delivered[0]?.content).toBe('已读取历史图片');
      const calls=requests.slice(before).filter((item)=>JSON.stringify(item.messages).includes('历史图片回查测试'));
      expect(calls.some((item)=>JSON.stringify(item.messages).includes('data:image/png;base64,'))).toBe(true);
      expect(calls.some((item)=>JSON.stringify(item.messages).includes('history-picture'))).toBe(true);
    } finally {imageFetch.mockRestore();harness.stop();store.close();}
  },20000);
  it('Anthropic 兼容接口也能接收回查的历史图片', async () => {
    const previous=process.env.MODEL_PROVIDER;process.env.MODEL_PROVIDER='anthropic';
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'anthropic-image'}}});
    const original=globalThis.fetch;let online=true;const imageFetch=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>String(input).startsWith('https://example.qq.com/')?(online?Promise.resolve(new Response(Uint8Array.from([137,80,78,71]),{headers:{'content-type':'image/png'}})):Promise.reject(new Error('原地址已过期'))):original(input,init));
    try {
      await harness.receive(event({id:'anthropic-picture',conversationId:'anthropic-image-group',content:'',timestamp:'2020-01-01T00:00:00Z',attachments:[{url:'https://example.qq.com/anthropic.png',content_type:'image/png'}]}));
      await vi.waitFor(()=>expect(store.db.prepare("SELECT status FROM message_attachments WHERE message_id='anthropic-picture'").get()).toMatchObject({status:'saved'}));online=false;
      for(let i=0;i<75;i++)await harness.receive(event({id:`anthropic-filler-${i}`,conversationId:'anthropic-image-group',content:`群聊 ${i}`}));
      await harness.receive(event({id:'anthropic-trigger',conversationId:'anthropic-image-group',content:'兼容接口历史图片测试',isMention:true}));
      await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
      expect(delivered[0]?.content).toBe('已收到历史图片');
    } finally {imageFetch.mockRestore();harness.stop();store.close();if(previous===undefined)delete process.env.MODEL_PROVIDER;else process.env.MODEL_PROVIDER=previous;}
  },20000);
  it('Deep Agents 内部子助手不能直接调用消息发送或人格修改工具', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'qq-subagent'}}});
    const before=requests.length;
    await harness.receive(event({id:'internal-trigger',conversationId:'group-internal',content:'内部子助手隔离测试',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toBe('主 Agent 已收到结果');
    const child=requests.slice(before).find((request)=>JSON.stringify(request.messages).includes('你是主 Agent 的内部执行助手'));
    expect(child).toBeDefined();
    const tools=(child!.tools ?? []) as Array<{function?:{name?:string}}>;
    const names=tools.map((entry)=>entry.function?.name);
    expect(names).toContain('web_search');expect(names).not.toContain('send_text');expect(names).not.toContain('send_media');expect(names).not.toContain('owner_set_persona');
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM execution_metrics WHERE conversation_id='group-internal' AND phase='内部子助手'").get() as {n:number}).n).toBeGreaterThan(0);
    harness.stop();store.close();
  },20000);
  it('本地对话中的最新图片不会被关键词规则强制联网', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'qq-research'}}});
    await harness.receive(event({id:'research-gate',conversationId:'group-research-gate',content:'把刚才那张最新图片给我看看',isMention:true}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).not.toContain('没有取得能核对的来源原文');
    harness.stop();store.close();
  },20000);
  it('正在处理时吸收群友插话，未触发消息本身不启动模型', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];
    const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'ok'}}});
    const before=requests.length;releaseInterjection=undefined;
    await harness.receive(event({id:'first',conversationId:'group-interject',content:'插话整合测试',isMention:true}));
    await vi.waitFor(()=>expect(releaseInterjection).toBeDefined(),{timeout:15000});
    expect(await harness.receive(event({id:'aside',conversationId:'group-interject',senderId:'other',senderName:'另一位群友',content:'关键补充',isMention:false}))).toBe(false);
    expect(await harness.receive(event({id:'earlier-aside',conversationId:'group-interject',senderId:'third',senderName:'第三位群友',content:'长任务期间的纠正',timestamp:new Date(Date.now()-600000).toISOString(),isMention:false}))).toBe(false);
    expect(requests.length).toBe(before+1);
    releaseInterjection!();
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(delivered[0]?.content).toBe('已看到群友的关键补充');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('另一位群友');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('长任务期间的纠正');
    expect(requests.length).toBe(before+2);
    harness.stop();store.close();
  },20000);
  it('排队触发的下一轮看到上一轮在等待期间发出的答复', async () => {
    const store=new Store(':memory:');const sent:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{sent.push(item);return {id:`queued-${sent.length}`}}});
    try {
      releaseQueued=undefined;const before=requests.length;
      await harness.receive(event({id:'queued-first',conversationId:'queued-context',content:'队列首轮测试',isMention:true}));
      await vi.waitFor(()=>expect(releaseQueued).toBeDefined(),{timeout:15000});
      await harness.receive(event({id:'queued-second',conversationId:'queued-context',content:'队列次轮测试',isMention:true}));
      releaseQueued!();await vi.waitFor(()=>expect(sent.length).toBe(2),{timeout:15000});
      const second=requests.slice(before).find((item)=>JSON.stringify(item.messages).includes('队列次轮测试'));
      const context=JSON.stringify(second?.messages);expect(context).toContain('上一轮刚刚发出的答复');expect(context).toContain('发生在当前消息之后');
    } finally {harness.stop();store.close();}
  },20000);
  it('积累静默消息后先回复，后台整理摘要并保留全部原文', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: 'qq-1' }; } });
    const before = requests.length;
    for (let i = 0; i < 85; i++) await harness.receive(event({ id: `silent-${i}`, conversationId: 'group-long', content: `${'项目讨论 '.repeat(12)}${i}` }));
    expect(requests).toHaveLength(before);
    await harness.receive(event({ id: 'long-trigger', conversationId: 'group-long', isMention: true, content: '回顾一下项目' }));
    await vi.waitFor(() => expect(delivered.length).toBe(1), { timeout: 15000 });
    expect(store.recent('group-long', 200).filter((row) => row.direction === 'in')).toHaveLength(86);
    await vi.waitFor(() => expect(releaseSummary).toBeDefined(), { timeout: 15000 });
    expect(store.summary('group-long')).toBeUndefined();
    releaseSummary!();
    await vi.waitFor(() => expect(store.summary('group-long')?.summary).toContain('长期项目'), { timeout: 15000 });
    expect(store.summary('group-long')?.summary).toContain('长期项目');
    harness.stop(); store.close();
  }, 20000);
  it('单条超长消息分段整理完整内容后才推进摘要位置', async () => {
    const store=new Store(':memory:');const runtime=new AgentRuntime(store);
    try {
      store.record(event({id:'long-single',conversationId:'long-summary',content:`${'甲'.repeat(10000)}中间标记${'乙'.repeat(10000)}尾部标记`}));
      const before=requests.length,through=store.maxSeq('long-summary');
      expect(await (runtime as unknown as {updateMemory:(id:string,seq:number)=>Promise<boolean>}).updateMemory('long-summary',through)).toBe(true);
      const calls=requests.slice(before).map((item)=>JSON.stringify(item.messages));
      expect(calls.length).toBeGreaterThan(1);expect(calls.some((item)=>item.includes('中间标记'))).toBe(true);expect(calls.some((item)=>item.includes('尾部标记'))).toBe(true);
      expect(store.summary('long-summary')?.through_seq).toBe(through);expect(store.recent('long-summary',1)[0]?.content.endsWith('尾部标记')).toBe(true);
    } finally {store.close();}
  },20000);
  it('先提出问题再单独艾特，原话交由模型理解，静默消息不调用模型', async () => {
    const store=new Store(':memory:');const delivered:DeliveryItem[]=[];const harness=new Harness(store,{send:async(item)=>{delivered.push(item);return {id:'research-bare'}}});
    const now=Date.now();const before=requests.length;
    expect(await harness.receive(event({id:'research-silent',conversationId:'group-research-bare',content:'查一下最新排行榜',timestamp:new Date(now+1000).toISOString()}))).toBe(false);
    expect(requests).toHaveLength(before);
    await harness.receive(event({id:'research-trigger',conversationId:'group-research-bare',content:'<@bot>',isMention:true,timestamp:new Date(now+2000).toISOString()}));
    await vi.waitFor(()=>expect(delivered.length).toBe(1),{timeout:15000});
    expect(JSON.stringify(requests.slice(before).map((item)=>item.messages))).toContain('查一下最新排行榜');
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM execution_metrics WHERE conversation_id='group-research-bare' AND phase='主回复'").get() as {n:number}).n).toBeGreaterThan(0);
    harness.stop();store.close();
  },20000);
  it('同一群重复触发不会累积旧检查点消息，原始聊天仍保留', async () => {
    const { SqliteSaver } = await import('@langchain/langgraph-checkpoint-sqlite');
    const { checkpointPath } = await import('../src/config/settings.js');
    const store = new Store(':memory:'); const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: `qq-checkpoint-${delivered.length}` }; } });
    for (let i = 0; i < 3; i++) {
      await harness.receive(event({ id: `turn-${i}`, conversationId: 'group-compact', content: `普通对话 ${i}`, isMention: true }));
      await vi.waitFor(() => expect(delivered.length).toBe(i + 1), { timeout: 15000 });
    }
    const saver = SqliteSaver.fromConnString(checkpointPath);
    const checkpoint = await saver.getTuple({ configurable: { thread_id: 'group:group-compact' } });
    const messages = checkpoint?.checkpoint.channel_values.messages as unknown[];
    expect(messages.length).toBeLessThanOrEqual(3);
    expect(store.recent('group-compact', 20).filter((row) => row.direction === 'in')).toHaveLength(3);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('普通对话 0');
    harness.stop(); store.close();
  }, 30000);
  it('Agent 调用文件工具后，再发送说明文字', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: `qq-${delivered.length}` }; } });
    const folder = workspaceFor('group-file'); fileToSend = path.join(folder, 'sample.txt'); fs.writeFileSync(fileToSend, 'hello');
    await harness.receive(event({ id: 'file-request', conversationId: 'group-file', content: '请发送指定文件，再说明', isMention: true }));
    await vi.waitFor(() => expect(delivered.length).toBe(2), { timeout: 15000 });
    expect(delivered.map((item) => item.kind)).toEqual(['file', 'text']);
    expect(delivered[1]?.content).toContain('发送');
    harness.stop(); store.close();
  }, 20000);
  it('主 Agent 派发后台子 Agent，结果回调后先发文件再说明', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: `qq-${delivered.length}` }; } });
    const folder = workspaceFor('group-task'); fileToSend = path.join(folder, 'task-result.txt'); fs.writeFileSync(fileToSend, 'done');
    await harness.receive(event({ id: 'task-request', conversationId: 'group-task', content: '请后台处理指定测试并把结果发群里', isMention: true }));
    await vi.waitFor(() => expect(delivered.length).toBe(3), { timeout: 15000 });
    expect(delivered.map((item) => item.kind)).toEqual(['text', 'file', 'text']);
    expect(delivered[0]?.content).toBe('好呀，我去后台处理～');
    expect(store.listTasks('group-task')[0]?.status).toBe('completed');
    expect(store.listTasks('group-task')[0]?.result).toContain(fileToSend);
    harness.stop(); store.close();
  }, 20000);
  it('后台任务使用独立检查点，恢复已完成步骤时不再次请求模型', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({id:'test'})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const id=store.addTask('checkpoint-group','group',undefined,'后台处理指定测试');const task=store.task(id)!;
    const runtime=new AgentRuntime(store);const ctx={conversationId:task.conversation_id,scope:task.scope,store,reply,tasks,background:true,taskId:id};
    const first=await runtime.runBackground(ctx,task,new AbortController().signal);const count=requests.length;
    const second=await runtime.runBackground(ctx,task,new AbortController().signal);
    expect(second).toBe(first);expect(requests.length).toBe(count);
    tasks.stop();store.close();
  },20000);
  it('中途终止的后台任务从检查点继续，不重复已完成的文件步骤', async () => {
    const store=new Store(':memory:');const reply=new ReplyRuntime(store,{send:async()=>({})});const tasks=new TaskManager(store,async()=>'',async()=>{});
    const id=store.addTask('checkpoint-interrupted','group',undefined,'恢复中途测试');const task=store.task(id)!;const runtime=new AgentRuntime(store);
    const ctx={conversationId:task.conversation_id,scope:task.scope,store,reply,tasks,background:true,taskId:id};const controller=new AbortController();releaseRecovery=undefined;resumeRecovery=false;
    const running=runtime.runBackground(ctx,task,controller.signal).catch(()=>undefined);
    await vi.waitFor(()=>expect(releaseRecovery).toBeDefined(),{timeout:15000});controller.abort();resumeRecovery=true;releaseRecovery!();await running;
    const priorRequests=requests.length;const result=await runtime.runBackground(ctx,task,new AbortController().signal);
    expect(result).toContain('任务恢复完成');expect(fs.readFileSync(path.join(workspaceFor('checkpoint-interrupted'),'recovery.txt'),'utf8')).toBe('checkpoint');
    expect(requests.slice(priorRequests).length).toBeLessThanOrEqual(2);
    tasks.stop();store.close();
  },30000);
});
