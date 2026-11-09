import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getMaxUploadSize, MediaFileType } from '@tencent-connect/qqbot-nodejs';
import type { ToolContext } from './registry.js';
import { runProcess } from './process.js';
import { validateUrl } from './web.js';
import { resolveWorkspaceFile, workspaceFor } from '../storage/workspace.js';
import { readConfig } from '../config/settings.js';

type Format = 'original' | 'mp4' | 'mp3' | 'm4a' | 'wav';
type Mode = 'auto' | 'file' | 'video';
export async function deliverMedia(ctx: ToolContext, request: { source: string; format: Format; mode: Mode; note?: string }) {
  if (!ctx.background) throw new Error('媒体下载和转换需要由后台任务执行');
  const root = workspaceFor(ctx.conversationId); const dir = path.join(root, 'media', randomUUID());
  const log = (message:string) => { if (ctx.taskId && ctx.store.task(ctx.taskId)) ctx.store.logTask(ctx.taskId, message); };
  fs.mkdirSync(dir, { recursive: true });
  let file: string;
  if (/^https?:\/\//i.test(request.source)) {
    log('正在下载媒体');
    if (!readConfig().sandbox.permissions.network) throw new Error('当前沙箱未启用网络权限');
    const url = await validateUrl(request.source);
    const result = await runProcess('yt-dlp', ['--no-playlist', '--no-progress', '--no-part', '--max-filesize', '1G', '--merge-output-format', 'mp4', '-o', path.join(dir, '%(title).100B [%(id)s].%(ext)s'), '--print', 'after_move:filepath', '--', url.toString()], { timeoutMs: readConfig().tasks.timeoutMs, signal: ctx.signal });
    const output = result.stdout.trim().split(/\r?\n/).at(-1); if (!output) throw new Error('下载完成但没有返回文件路径');
    file = resolveWorkspaceFile(ctx.conversationId, output);
  } else file = resolveWorkspaceFile(ctx.conversationId, request.source);
  const original = file;
  if (request.format !== 'original') {
    log(`正在转换为 ${request.format}`);
    const output = path.join(dir, `output.${request.format}`);
    const codec = request.format === 'mp4' ? ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart'] : ['-vn'];
    await runProcess('ffmpeg', ['-nostdin', '-n', '-i', file, ...codec, output], { timeoutMs: readConfig().tasks.timeoutMs, signal: ctx.signal });
    file = resolveWorkspaceFile(ctx.conversationId, output);
  }
  const ext = path.extname(file).toLowerCase();
  const kind = request.mode === 'file' ? 'file' : request.mode === 'video' ? 'video' : ['.mp4', '.mov', '.m4v', '.webm'].includes(ext) ? 'video' : 'file';
  const size = fs.statSync(file).size; const max = getMaxUploadSize(kind === 'video' ? MediaFileType.VIDEO : MediaFileType.FILE);
  if (!size) { log('生成文件为空'); return { path: file, original, size, kind, delivered: false, error: '生成文件为空' }; }
  if (size > max) { log(`文件超过 QQ 上传上限，已保留产物：${file}`); return { path: file, original, size, kind, delivered: false, error: `文件超过 QQ SDK 的 ${kind} 上传上限 ${max} 字节，产物已保留在工作区` }; }
  const key = ctx.taskId ? `task:${ctx.taskId}:media:${createHash('sha256').update(`${request.source}\0${request.format}\0${kind}`).digest('hex')}` : undefined;
  try {
    log(`准备发送 ${kind}，大小 ${size} 字节`);
    await ctx.reply.send(ctx.conversationId, ctx.scope, ctx.replyTo, kind, file, path.basename(file), key);
  } catch (error) {
    log(`发送失败，产物已保留：${error instanceof Error ? error.message : String(error)}`);
    return { path: file, original, size, kind, delivered: false, error: error instanceof Error ? error.message : String(error) };
  }
  log('平台已确认媒体消息发送');
  let noteRelayed = false; let noteError: string | undefined;
  if (request.note?.trim()) {
    try { if (!ctx.taskId) throw new Error('后台任务缺少标识'); await ctx.tasks.reportProgressAndWait(ctx.taskId, request.note); noteRelayed = true; }
    catch (error) { noteError = error instanceof Error ? error.message : String(error); }
  }
  return { path: file, original, size, kind, delivered: true, noteRelayed, ...(noteError ? { noteError } : {}) };
}
