import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { workspaceFor } from '../storage/workspace.js';

const threshold=32000;
const directory='.qqbot-tool-results';

/** 大结果完整保存在会话工作区，并提供可分页读取的标识。 */
export function archiveToolResult(conversationId:string,content:string):string {
  const root=fs.realpathSync(workspaceFor(conversationId));
  const dir=path.join(root,directory);
  fs.mkdirSync(dir,{recursive:true});
  if(fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir)!==dir) throw new Error('工具结果目录不在当前工作区');
  const id=createHash('sha256').update(content).digest('hex');
  try {fs.writeFileSync(path.join(dir,`${id}.txt`),content,{encoding:'utf8',flag:'wx'});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  return id;
}

export function readToolResult(conversationId:string,id:string,offset:number,limit:number) {
  if(!/^[0-9a-f]{64}$/.test(id))throw new Error('工具结果标识无效');
  const root=fs.realpathSync(workspaceFor(conversationId));
  const file=fs.realpathSync(path.join(root,directory,`${id}.txt`));
  if(!file.startsWith(root+path.sep))throw new Error('只能读取当前会话的工具结果');
  const content=fs.readFileSync(file,'utf8');
  if(createHash('sha256').update(content).digest('hex')!==id)throw new Error('工具结果内容校验失败');
  return {content:content.slice(offset,offset+limit),totalCharacters:content.length,nextOffset:offset+limit<content.length?offset+limit:null};
}

export function largeToolResults(conversationId:string) {
  const compact=(result:unknown)=>{
    if(!(result instanceof ToolMessage) || typeof result.content!=='string' || result.content.length<=threshold || result.status==='error')return result;
    try {
      const id=archiveToolResult(conversationId,result.content);
      const preview=result.content.slice(0,1800);
      return new ToolMessage({id:result.id,name:result.name,tool_call_id:result.tool_call_id,status:result.status,additional_kwargs:result.additional_kwargs,response_metadata:result.response_metadata,artifact:result.artifact,content:`工具结果较长（${result.content.length} 字符），已完整保存。调用 read_tool_result 并提供标识 ${id}，可按偏移分段读取全部内容。以下为开头节选：\n${preview}`});
    } catch(error) {
      console.error('工具结果归档失败，保留原结果：',error instanceof Error?error.message:String(error));
      return result;
    }
  };
  return createMiddleware({name:'大工具结果归档',wrapToolCall:async(request,handler)=>compact(await handler(request)) as Awaited<ReturnType<typeof handler>>,
    wrapModelCall:(request,handler)=>handler({...request,messages:request.messages.map((message)=>compact(message) as typeof message)}),
  });
}
