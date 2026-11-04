import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { tool } from 'langchain';
import { z } from 'zod';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-harness-test-'));
process.env.BOT_DATA_DIR = root;
process.env.MODEL_API_KEY = 'test-key';
process.env.MODEL_NAME = 'test-model';

const { initConfig, readConfig, configPath } = await import('../src/config/settings.js');
const { Store } = await import('../src/storage/store.js');
const { Harness } = await import('../src/agent/harness.js');
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
import type { DeliveryItem, InboundEvent } from '../src/domain/types.js';

function event(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return { id: 'm1', conversationId: 'group-a', scope: 'group', senderId: 'user-a', senderName: '小王', content: '刚买了 NAS', timestamp: new Date().toISOString(), isMention: false, attachments: [], ...overrides };
}

initConfig();

describe('沙箱与动态配置', () => {
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
    expect(shouldRespond(event({ content: '小助手在吗' }), readConfig())).toBe(true);
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
  const requests: Array<Record<string, unknown>> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown; name?: string; reasoning_content?: string }> };
        requests.push(parsed as unknown as Record<string, unknown>);
        if (req.url?.endsWith('/v1/messages')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg-test', type: 'message', role: 'assistant', model: 'test-model', content: [{ type: 'tool_use', id: 'probe-1', name: 'startup_probe', input: {} }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
          return;
        }
        const allText = JSON.stringify(parsed.messages);
        const asyncScenario = allText.includes('后台处理指定测试');
        const isChild = allText.includes('容器沙箱中的后台任务执行者');
        const callback = allText.includes('后台任务通知');
        const fileScenario = allText.includes('指定文件');
        const thinkingScenario = allText.includes('思考工具回放');
        const permissionScenario = allText.includes('尝试写入权限验证');
        const last = parsed.messages.at(-1);
        let reply: Record<string, unknown>;
        if (permissionScenario && last?.role !== 'tool') reply = { role: 'assistant', content: null, tool_calls: [{ id: 'denied-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: '/denied.txt', content: 'must not be written' }) } }] };
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
        else if (asyncScenario && last?.role !== 'tool') reply = { role: 'assistant', content: null, tool_calls: [{ id: `tool-start-${requests.length}`, type: 'function', function: { name: 'start_background_task', arguments: JSON.stringify({ instruction: '后台处理指定测试，并发送生成的文件' }) } }] };
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
    expect(requests).toHaveLength(before);
    await harness.receive(event({ id: 'trigger', senderId: 'user-b', senderName: '小李', content: '小王买了什么？', isMention: true }));
    await vi.waitFor(() => expect(delivered.length).toBe(1), { timeout: 15000 });
    expect(delivered[0]?.content).toContain('NAS');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('刚买了 NAS');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('小王');
    harness.stop(); store.close();
  }, 20000);
  it('积累大量静默消息后，触发时先生成摘要并保留全部原文', async () => {
    const store = new Store(':memory:');
    const delivered: DeliveryItem[] = [];
    const harness = new Harness(store, { send: async (item) => { delivered.push(item); return { id: 'qq-1' }; } });
    const before = requests.length;
    for (let i = 0; i < 85; i++) await harness.receive(event({ id: `silent-${i}`, conversationId: 'group-long', content: `项目讨论 ${i}` }));
    expect(requests).toHaveLength(before);
    await harness.receive(event({ id: 'long-trigger', conversationId: 'group-long', isMention: true, content: '回顾一下项目' }));
    await vi.waitFor(() => expect(delivered.length).toBe(1), { timeout: 15000 });
    expect(store.recent('group-long', 200).filter((row) => row.direction === 'in')).toHaveLength(86);
    expect(store.summary('group-long')?.summary).toContain('长期项目');
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('长期项目');
    harness.stop(); store.close();
  }, 20000);
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
    expect(store.listTasks('group-task')[0]?.status).toBe('completed');
    expect(store.listTasks('group-task')[0]?.result).toContain(fileToSend);
    harness.stop(); store.close();
  }, 20000);
});
