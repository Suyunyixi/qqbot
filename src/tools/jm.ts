import { createHash } from 'node:crypto';
import { getMaxUploadSize, MediaFileType } from '@tencent-connect/qqbot-nodejs';
import { readConfig } from '../config/settings.js';
import type { TaskRow } from '../storage/store.js';
import type { ReplyRuntime } from '../delivery/reply.js';
import { runBundledJson, runBundledPython } from './python.js';

export type JmQuery = { action:'search'|'ranking'|'detail'; query?:string; albumId?:string; searchBy?:'site'|'work'|'author'|'tag'|'actor'; period?:'day'|'week'|'month'|'all'; order?:'latest'|'views'|'likes'|'comments'|'score'|'pictures'; page?:number };

export async function queryJm(input:JmQuery, signal?:AbortSignal):Promise<unknown> {
  if (!readConfig().tools.python || !readConfig().sandbox.permissions.process) throw new Error('JM 查询需要启用脚本执行');
  if (input.action==='search' && !input.query?.trim()) throw new Error('请提供搜索词');
  if (input.action==='detail' && !/^\d{3,12}$/.test(input.albumId ?? '')) throw new Error('请提供有效的 JM 编号');
  return runBundledJson('jm_query.py',input,signal);
}

export async function runJmTask(task:TaskRow, reply:ReplyRuntime, signal:AbortSignal):Promise<string> {
  const config=readConfig();
  if (!config.tools.python || !config.sandbox.permissions.process || !config.sandbox.permissions.workspaceWrite || !config.sandbox.permissions.workspaceRead)
    throw new Error('JM 任务需要启用脚本执行和工作区读写权限');
  const data=JSON.parse(task.payload ?? '{}') as {albumId?:unknown;password?:unknown};
  if (typeof data.albumId!=='string' || !/^\d{3,12}$/.test(data.albumId) || (data.password!==undefined && typeof data.password!=='string')) throw new Error('JM 任务参数无效');
  const password=typeof data.password==='string' ? data.password : createHash('sha256').update(`jm-pdf:${task.id}`).digest('hex').slice(0,12);
  const result=await runBundledPython(task.conversation_id,'jm_pdf.py',{albumId:data.albumId,password},'result.pdf',signal);
  const max=getMaxUploadSize(MediaFileType.FILE);
  if (!result.size || result.size>max) throw new Error(`PDF 已保存到工作区 ${result.virtualPath}，但大小 ${result.size} 字节超过 QQ 文件上限 ${max} 字节`);
  if (signal.aborted) throw new Error('任务已取消或超时，PDF 已保存在工作区');
  await reply.send(task.conversation_id,task.scope,task.reply_to ?? undefined,'file',result.path,`JM${data.albumId}.pdf`,`task:${task.id}:jm-pdf`);
  return JSON.stringify({albumId:data.albumId,delivered:true,file:`JM${data.albumId}.pdf`,workspace:result.virtualPath,password,notice:'文件已实际发送；请自然告知群友 PDF 打开密码，勿重复发送文件。'});
}
