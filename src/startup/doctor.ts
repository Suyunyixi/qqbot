import fs from 'node:fs';
import path from 'node:path';
import { tool } from 'langchain';
import { z } from 'zod';
import { checkpointPath, readConfig } from '../config/settings.js';
import { persona } from '../agent/runtime.js';
import { makeModel } from '../models/factory.js';
import { runProcess } from '../tools/process.js';
import { Store } from '../storage/store.js';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { HumanMessage } from '@langchain/core/messages';
import QRCode from 'qrcode';
import { registeredPlugins } from '../tools/plugins.js';
import { makeTools } from '../tools/registry.js';
import { workspaceFor } from '../storage/workspace.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { TaskManager } from '../agent/task-manager.js';
import { loadSilkWasm, pcmToSilk } from '@tencent-connect/qqbot-nodejs/protocol';
import { permitted } from '../tools/sandbox.js';
import { checkPythonRunner } from '../tools/python.js';
import { searchWeb } from '../tools/search.js';

export interface Check { name: string; ok: boolean; message: string }
export async function doctor(store: Store, full = true, only?: ReadonlySet<string>): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<string> | string) => {
    if (only && !only.has(name)) return;
    try { checks.push({ name, ok: true, message: await fn() }); }
    catch (error) { const value = error instanceof Error ? error.message : String(error); const secret = readConfig().model.apiKey; checks.push({ name, ok: false, message: secret ? value.replaceAll(secret, '[REDACTED]') : value }); }
  };
  const config = readConfig();
  await check('配置和人格', () => { if (!persona(store).trim()) throw new Error('人格配置为空'); return '配置有效（人格存储于 SQLite）'; });
  await check('数据库', () => {
    store.db.exec('CREATE TABLE IF NOT EXISTS doctor_test (value TEXT)');
    store.db.transaction(() => { store.db.prepare('DELETE FROM doctor_test').run(); store.db.prepare('INSERT INTO doctor_test VALUES (?)').run('ok'); })();
    if ((store.db.prepare('SELECT value FROM doctor_test').get() as { value: string }).value !== 'ok') throw new Error('数据库读写失败');
    return '事务读写正常';
  });
  await check('映射工作区', () => { const dir = workspaceFor('_startup_doctor'); fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); const probe = path.join(dir, '.check'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); return `可读写：${dir}`; });
  await check('QQ SDK / 扫码组件', async () => { await import('@tencent-connect/qqbot-nodejs'); await import('@tencent-connect/qqbot-connector'); return '模块加载成功'; });
  for (const plugin of registeredPlugins()) await check(`工具插件 ${plugin.name}`, async () => { if (!permitted(plugin.permissions, config)) return '所需权限未启用，工具不注册'; await plugin.selfCheck(); return '插件自检通过'; });
  await check('工具注册', () => {
    const reply = new ReplyRuntime(store, { send: async () => ({}) });
    const tasks = new TaskManager(store, async () => '', async () => {});
    for (const background of [false, true]) {
      const tools = makeTools({ conversationId: '_startup_doctor', scope: 'group', store, reply, tasks, background, taskId: background ? '00000000-0000-4000-8000-000000000000' : undefined });
      if (!tools.length || tools.some((item) => !item.name || typeof item.invoke !== 'function')) throw new Error('工具注册不完整');
    }
    return '主 Agent 与子 Agent 工具注册有效';
  });
  await check('Agent 组件与 checkpoint', async () => {
    await import('deepagents');
    const saver = SqliteSaver.fromConnString(checkpointPath);
    try { await saver.getTuple({ configurable: { thread_id: '_startup_doctor' } }); } finally { saver.db.close(); }
    return '模块与持久化可用';
  });
  if (config.tools.media) for (const executable of ['ffmpeg', 'ffprobe', 'yt-dlp']) await check(executable, async () => (await runProcess(executable, [executable === 'yt-dlp' ? '--version' : '-version'], { timeoutMs: 10000 })).stdout.split(/\r?\n/)[0] ?? '可用');
  if (full && config.tools.python && permitted(['process', 'workspaceRead', 'workspaceWrite'], config)) await check('Python 沙箱和中文绘图', async () => { await checkPythonRunner(); return '脚本及子进程执行、Pillow 和中文字体可用；联网取决于权限配置'; });
  if (config.tools.voice) await check('语音', async () => { await runProcess('edge-tts', ['--version'], { timeoutMs: 10000 }); const encoder = await loadSilkWasm(); if (!encoder) throw new Error('缺少 SILK 编码器'); const sample = await pcmToSilk(Buffer.alloc(4800), 24000); if (!encoder.isSilk(sample.silkBuffer)) throw new Error('SILK 编码自检失败'); if (full) { const v = await runProcess('edge-tts', ['--list-voices'], { timeoutMs: 30000 }); if (!v.stdout.split(/\s+/).includes(config.tools.voiceName)) throw new Error(`声线 ${config.tools.voiceName} 不可用`); } return `声线 ${config.tools.voiceName}，SILK 编码可用`; });
  if (full && config.tools.search) await check('搜索服务', async () => {
    const result = await searchWeb(['DeepSeek official website']);
    if (!result.sufficient) throw new Error(`搜索没有可用来源：${result.attempts.map((item) => `${item.provider}: ${item.error ?? '空结果'}`).join('；')}`);
    return `真实搜索可用：${result.attempts.filter((item) => item.count > 0).map((item) => item.provider).join(', ')}`;
  });
  if (full) await check('模型与工具调用', async () => {
    if (!config.model.apiKey.trim()) throw new Error('请在 .env 中填写 MODEL_API_KEY');
    const probe = tool(async () => 'ok', { name: 'startup_probe', description: '启动检查', schema: z.object({}) });
    const model = makeModel().bindTools([probe]);
    const response = await model.invoke('请调用 startup_probe 工具，不要回答其他内容。');
    if (!response.tool_calls?.some((call) => call.name === 'startup_probe')) throw new Error('模型未返回预期工具调用，请检查模型和兼容接口');
    return `模型 ${config.model.name} 可用`;
  });
  if (full && config.model.vision && config.model.apiKey.trim()) await check('图片理解', async () => {
    const image = await QRCode.toDataURL('startup-check');
    const response = await makeModel().invoke([new HumanMessage({ content: [{ type: 'text', text: '请简单描述这张图片。' }, { type: 'image_url', image_url: { url: image } }] })]);
    if (!response.content) throw new Error('视觉模型没有返回内容');
    return '模型支持图片输入';
  });
  return checks;
}
