import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tool } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { readConfig } from '../config/settings.js';
import { runProcess } from './process.js';
import { Store } from '../storage/store.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { TaskManager } from '../agent/task-manager.js';
import type { DeliveryKind, Scope } from '../domain/types.js';
import { readPublicWebpage } from './web.js';
import { registeredPlugins } from './plugins.js';
import { permitted, toolPermissions } from './sandbox.js';
import { workspaceFor, resolveWorkspaceFile } from '../storage/workspace.js';
import { buildNativeArk, nativeCardSchema } from '../domain/card.js';
import { rasterizeSvg, renderImageCard, runPythonScript } from './python.js';
export { workspaceFor } from '../storage/workspace.js';

export interface ToolContext {
  conversationId: string;
  scope: Scope;
  replyTo?: string;
  store: Store;
  reply: ReplyRuntime;
  tasks: TaskManager;
  background: boolean;
  taskId?: string;
  notificationKey?: string;
  signal?: AbortSignal;
  sentText?: boolean;
}
const safeFile = resolveWorkspaceFile;
function wrap<T>(fn: (value: T) => Promise<unknown>): (value: T) => Promise<string> {
  return async (value) => {
    try { return JSON.stringify({ ok: true, result: await fn(value) }); }
    catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
}
function httpUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持无凭据的 HTTP(S) 链接');
  return url.toString();
}

export function makeTools(ctx: ToolContext) {
  const config = readConfig();
  const tools: StructuredToolInterface[] = [
    tool(wrap(async () => ({ sandbox: 'docker-container', workspace: workspaceFor(ctx.conversationId), permissions: readConfig().sandbox.permissions, toolPermissions })), { name: 'sandbox_capabilities', description: '查看当前容器沙箱、会话工作目录和工具权限；主机上的工作区由管理员映射。', schema: z.object({}) }),
    tool(wrap(async ({ query }: { query: string }) => {
      const rows = ctx.store.search(ctx.conversationId, query, 20);
      return rows.map((row) => ({ senderId: row.sender_id, senderName: row.sender_name, time: row.timestamp, content: row.content }));
    }), { name: 'search_chat_history', description: '按关键词搜索当前会话的历史原文，返回发言人和时间。', schema: z.object({ query: z.string().min(1).max(200) }) }),
    tool(wrap(async ({ query }: { query: string }) => {
      const config = readConfig();
      if (!config.tools.search) throw new Error('联网搜索未启用');
      const url = new URL('/search', config.tools.searchUrl); url.searchParams.set('q', query); url.searchParams.set('format', 'json');
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`搜索服务 HTTP ${response.status}`);
      const body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (body.results ?? []).slice(0, 8).map(({ title, url: link, content }) => ({ title, url: link, snippet: content?.slice(0, 1000) }));
    }), { name: 'web_search', description: '联网搜索资料，返回标题、链接和摘要；需要最新信息时使用。', schema: z.object({ query: z.string().min(1).max(500) }) }),
    tool(wrap(async ({ url, offset }: { url: string; offset: number }) => readPublicWebpage(url, offset)), { name: 'read_webpage', description: '读取公开网页正文；长网页可用 nextOffset 继续读取。搜索摘要不足时访问原文。', schema: z.object({ url: z.string().url(), offset: z.number().int().min(0).default(0) }) }),
    tool(wrap(async ({ url }: { url: string }) => {
      if (!readConfig().tools.media) throw new Error('媒体下载未启用');
      const dir = path.join(workspaceFor(ctx.conversationId), randomUUID()); fs.mkdirSync(dir, { recursive: true });
      const result = await runProcess('yt-dlp', ['--no-playlist', '--no-progress', '--no-part', '--merge-output-format', 'mp4', '-o', path.join(dir, '%(title).120B [%(id)s].%(ext)s'), '--print', 'after_move:filepath', '--', httpUrl(url)], { timeoutMs: readConfig().tasks.timeoutMs, signal: ctx.signal });
      const file = result.stdout.trim().split(/\r?\n/).at(-1);
      if (!file) throw new Error('下载程序未返回文件路径');
      const actual = safeFile(ctx.conversationId, file);
      return { path: actual, size: fs.statSync(actual).size, name: path.basename(actual) };
    }), { name: 'download_media', description: '通过链接下载 B 站及其他支持站点的视频到当前会话工作目录。长任务应交给后台任务执行。', schema: z.object({ url: z.string().url() }) }),
    tool(wrap(async ({ input, format }: { input: string; format: 'mp3' | 'm4a' | 'wav' }) => {
      if (!readConfig().tools.media) throw new Error('媒体处理未启用');
      const file = safeFile(ctx.conversationId, input);
      const output = path.join(path.dirname(file), `${path.parse(file).name}.${format}`);
      if (path.resolve(output) === path.resolve(file)) throw new Error('输入输出路径相同');
      await runProcess('ffmpeg', ['-nostdin', '-y', '-i', file, '-vn', output], { timeoutMs: readConfig().tasks.timeoutMs, signal: ctx.signal });
      return { path: safeFile(ctx.conversationId, output), size: fs.statSync(output).size, format };
    }), { name: 'extract_audio', description: '从当前会话工作目录中的视频或音频提取音频文件。', schema: z.object({ input: z.string(), format: z.enum(['mp3', 'm4a', 'wav']).default('mp3') }) }),
    tool(wrap(async ({ input }: { input: string }) => {
      const file = safeFile(ctx.conversationId, input);
      const result = await runProcess('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeoutMs: 15000, signal: ctx.signal });
      return JSON.parse(result.stdout) as unknown;
    }), { name: 'inspect_media', description: '检查当前会话媒体文件的大小、容器格式、音视频编码和时长。', schema: z.object({ input: z.string() }) }),
  ];
  // Both the main agent and a delegated worker use the same ordered delivery path.
  tools.push(
    tool(wrap(async ({ script, inputs, timeoutSeconds }: { script: string; inputs: string[]; timeoutSeconds: number }) => {
      if (!ctx.background && timeoutSeconds > 20) throw new Error('超过 20 秒的脚本请交给后台任务');
      return runPythonScript(ctx.conversationId, script, inputs, timeoutSeconds, ctx.signal);
    }), { name: 'run_python_script', description: '在独立受限 Python 容器中执行当前会话工作区的 .py 脚本，指定所需输入文件；返回退出码、输出及写回当前工作区的文件。预装 Pillow 和中文字体；不能联网、运行子进程或访问凭据。先检查 exitCode，再发送生成的文件。耗时任务交给后台。', schema: z.object({ script: z.string().min(1), inputs: z.array(z.string()).max(31).default([]), timeoutSeconds: z.number().int().min(1).max(120).default(20) }) }),
    tool(wrap(async (data: { title: string; subtitle?: string; items: Array<{ title: string; description?: string }> }) => renderImageCard(ctx.conversationId, data, ctx.signal)), { name: 'render_image_card', description: '只有用户明确要求图片、海报或榜单图时，使用结构化数据渲染带中文的 PNG；返回路径后用 send_media 发送。普通“卡片”默认调用 send_native_card，不使用本工具。', schema: z.object({ title: z.string().min(1).max(100), subtitle: z.string().max(200).optional(), items: z.array(z.object({ title: z.string().min(1).max(200), description: z.string().max(300).optional() })).min(1).max(10) }) }),
    tool(wrap(async (card: z.infer<typeof nativeCardSchema>) => {
      buildNativeArk(card); // Validate before any delivery is queued.
      const payload = JSON.stringify(card);
      const key = ctx.taskId ? `task:${ctx.taskId}:card:${createHash('sha256').update(payload).digest('hex')}` : undefined;
      await ctx.reply.send(ctx.conversationId, ctx.scope, ctx.replyTo, 'card', payload, undefined, key);
      return { sent: true, kind: 'qq_ark_card' };
    }), { name: 'send_native_card', description: '发送 QQ 原生 ARK 卡片。用户说“卡片”时默认使用此工具；单条链接用 link，多条榜单用 list。链接必须是真实来源，禁止猜造；受 QQ 卡片权限和 URL 白名单限制，失败必须如实说明。', schema: nativeCardSchema }),
    tool(wrap(async ({ text }: { text: string }) => {
      const key = ctx.taskId ? `task:${ctx.taskId}:${ctx.notificationKey ?? (ctx.background ? 'worker' : 'callback')}:text:${createHash('sha256').update(text).digest('hex')}` : undefined;
      await ctx.reply.send(ctx.conversationId, ctx.scope, ctx.replyTo, 'text', text, undefined, key);
        ctx.sentText = true;
      return { sent: true };
    }), { name: 'send_text', description: '立即向当前会话发送一段文字，用于必要的进度沟通或文件前后分段交流；不要重复发送。', schema: z.object({ text: z.string().min(1).max(4000) }) }),
    tool(wrap(async ({ file, kind }: { file: string; kind: DeliveryKind }) => {
      let actual = safeFile(ctx.conversationId, file);
      const deliveryKey = ctx.taskId ? `task:${ctx.taskId}:${kind}:${createHash('sha256').update(actual).digest('hex')}` : undefined;
      if (kind === 'image' && path.extname(actual).toLowerCase() === '.svg') {
        if (!config.tools.python || !permitted(['process', 'workspaceRead', 'workspaceWrite'], config)) throw new Error('SVG 图片需要启用 Python 沙箱和工作区读写权限才能转换发送');
        actual = (await rasterizeSvg(ctx.conversationId, actual, ctx.signal)).path;
      }
      await ctx.reply.send(ctx.conversationId, ctx.scope, ctx.replyTo, kind, actual, path.basename(actual), deliveryKey);
      return { sent: true, file: path.basename(actual), kind };
    }), { name: 'send_media', description: '立即向当前会话发送本会话工作目录的文件、图片或视频；成功后才能说已发送。', schema: z.object({ file: z.string(), kind: config.tools.voice ? z.enum(['image', 'voice', 'video', 'file']) : z.enum(['image', 'video', 'file']) }) }),
  );
  if (!ctx.background) {
    // Long media operations must run in the background, not block the group thread.
    for (const name of ['download_media', 'extract_audio']) {
      const index = tools.findIndex((item) => item.name === name);
      if (index >= 0) tools.splice(index, 1);
    }
    tools.push(
      tool(wrap(async ({ instruction }: { instruction: string }) => {
        const id = ctx.tasks.enqueue(ctx.conversationId, ctx.scope, ctx.replyTo, instruction);
        return { taskId: id, status: 'queued', message: '任务已在后台开始；完成或失败后会回到当前会话。' };
      }), { name: 'start_background_task', description: '启动独立子 Agent 执行耗时任务，随后结束当前回合；完成、进度或问题会自动回调。将用户要求、链接及交付格式完整写进 instruction。', returnDirect: true, schema: z.object({ instruction: z.string().min(1).max(5000) }) }),
      tool(wrap(async ({ taskId }: { taskId: string }) => {
        const task = ctx.store.task(taskId); if (!task || task.conversation_id !== ctx.conversationId) throw new Error('找不到当前会话的任务');
        return { taskId, status: task.status, result: task.result, error: task.error };
      }), { name: 'check_background_task', description: '查看本会话后台任务状态。', schema: z.object({ taskId: z.string().uuid() }) }),
      tool(wrap(async ({ taskId }: { taskId: string }) => ctx.tasks.cancel(taskId, ctx.conversationId)), { name: 'cancel_background_task', description: '取消当前会话后台任务。', schema: z.object({ taskId: z.string().uuid() }) }),
      tool(wrap(async () => ctx.store.listTasks(ctx.conversationId).map((task) => ({ taskId: task.id, instruction: task.instruction, status: task.status, result: task.result, error: task.error }))), { name: 'list_background_tasks', description: '列出当前会话的后台任务及其状态，用于关联用户的后续问题或答复。', schema: z.object({}) }),
      tool(wrap(async ({ taskId, instruction }: { taskId: string; instruction: string }) => ctx.tasks.update(taskId, ctx.conversationId, instruction)), { name: 'update_background_task', description: '向当前会话的任务补充要求，或答复等待用户输入的子 Agent。', schema: z.object({ taskId: z.string().uuid(), instruction: z.string().min(1).max(5000) }) }),
      tool(wrap(async () => ctx.store.pendingOutbox(ctx.conversationId).map((item) => ({ id: item.id, kind: item.kind, name: item.file_name, status: item.status, error: item.error }))), { name: 'list_pending_deliveries', description: '查看当前会话发送失败、待发送或发送结果未知的消息。', schema: z.object({}) }),
      tool(wrap(async ({ deliveryId }: { deliveryId: string }) => { await ctx.reply.retry(ctx.conversationId, deliveryId, ctx.replyTo); return { sent: true }; }), { name: 'retry_delivery', description: '重新发送本会话之前明确失败或尚未发送的消息；结果未知的消息不能自动重发。', schema: z.object({ deliveryId: z.string().min(1) }) }),
      tool(wrap(async ({ text }: { text: string }) => {
        const config = readConfig(); if (!config.tools.voice) throw new Error('语音功能未启用');
        const output = path.join(workspaceFor(ctx.conversationId), `${randomUUID()}.mp3`);
        const voice = ctx.store.getSetting(ctx.conversationId, 'voiceName') ?? config.tools.voiceName;
        await runProcess('edge-tts', ['--voice', voice, '--text', text, '--write-media', output], { timeoutMs: 120000 });
        await ctx.reply.send(ctx.conversationId, ctx.scope, ctx.replyTo, 'voice', output, path.basename(output));
        return { sent: true };
      }), { name: 'speak', description: '使用当前配置声线合成语音并立即发送给当前会话。', schema: z.object({ text: z.string().min(1).max(1000) }) }),
      tool(wrap(async ({ key, value }: { key: string; value: string }) => {
        if (key !== 'tools.voiceName') throw new Error('只能调整声线');
        const voices = await runProcess('edge-tts', ['--list-voices'], { timeoutMs: 30000 });
        if (!voices.stdout.split(/\s+/).includes(value)) throw new Error('声线不可用，请先使用 list_voices 查看');
        ctx.store.setSetting(ctx.conversationId, 'voiceName', value); return { key, value, scope: 'current conversation', effective: 'next call' };
      }), { name: 'set_voice', description: '验证并切换当前会话的语音声线，立即生效，不影响其他群。', schema: z.object({ key: z.literal('tools.voiceName'), value: z.string().min(1) }) }),
      tool(wrap(async () => {
        const result = await runProcess('edge-tts', ['--list-voices'], { timeoutMs: 30000 });
        return result.stdout.split('\n').filter((line) => line.includes('zh-CN-')).slice(0, 80).join('\n');
      }), { name: 'list_voices', description: '列出可用的中文语音声线。', schema: z.object({}) }),
    );
  } else if (ctx.taskId) {
    const id = ctx.taskId;
    tools.push(tool(wrap(async ({ question }: { question: string }) => ({ answer: await ctx.tasks.requestInput(id, question, ctx.signal) })), { name: 'ask_user', description: '任务无法继续且确实需要群友补充信息时，向主 Agent 提问并等待答复。', schema: z.object({ question: z.string().min(1).max(1000) }) }));
    tools.push(tool(wrap(async ({ progress }: { progress: string }) => { ctx.tasks.reportProgress(id, progress); return { queued: true }; }), { name: 'report_progress', description: '向主 Agent 报告值得告知群友的重大进展，不要为每个细节刷屏。', schema: z.object({ progress: z.string().min(1).max(1000) }) }));
  }
  const disabled = new Set<string>();
  if (!config.tools.search) { disabled.add('web_search'); disabled.add('read_webpage'); }
  if (!config.tools.media) { disabled.add('download_media'); disabled.add('extract_audio'); disabled.add('inspect_media'); }
  if (!config.tools.voice) { disabled.add('speak'); disabled.add('list_voices'); disabled.add('set_voice'); }
  if (!config.tools.python) { disabled.add('run_python_script'); disabled.add('render_image_card'); }
  const selected = tools.filter((item) => {
    const required = toolPermissions[item.name];
    if (!required) throw new Error(`工具未声明沙箱权限：${item.name}`);
    return !disabled.has(item.name) && permitted(required, config);
  });
  for (const plugin of registeredPlugins()) if (permitted(plugin.permissions, config)) selected.push(...plugin.createTools(ctx));
  const names = new Set<string>();
  for (const item of selected) { if (names.has(item.name)) throw new Error(`工具名称重复：${item.name}`); names.add(item.name); }
  return selected;
}
