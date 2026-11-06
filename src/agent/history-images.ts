import { HumanMessage } from '@langchain/core/messages';
import { createMiddleware, tool } from 'langchain';
import { z } from 'zod';
import type { Store } from '../storage/store.js';
import { AttachmentArchive } from '../storage/attachments.js';

interface ImageRow { seq:number; id:string; sender_name:string|null; direction:string; timestamp:string; attachments:string }
interface ImageItem { url?:string; content_type?:string; filename?:string }

/** 历史图片按会话查询；只有真正需要理解时才从归档加载。 */
export function historyImageTools(store:Store,archive:AttachmentArchive,conversationId:string,vision:boolean) {
  const pending:HumanMessage[]=[];
  const imageRows=(before:number,limit:number)=>store.db.prepare("SELECT seq,id,sender_name,direction,timestamp,attachments FROM messages WHERE conversation_id=? AND seq<? AND attachments<>'[]' ORDER BY seq DESC LIMIT ?").all(conversationId,before,limit) as ImageRow[];
  const images=(row:ImageRow):Array<{index:number;item:ImageItem}>=>{
    try {const value=JSON.parse(row.attachments) as unknown;if(!Array.isArray(value))return [];return value.flatMap((item,index)=>item && typeof item==='object' && typeof item.content_type==='string' && item.content_type.toLowerCase().startsWith('image/')?[{index,item:item as ImageItem}]:[]);} catch{return [];}
  };
  const list=tool(async ({before})=>{
    const rows=imageRows(before ?? Number.MAX_SAFE_INTEGER,201);const batch=rows.slice(0,200);
    const results=batch.flatMap((row)=>images(row).map(({index,item})=>{
      const state=store.db.prepare('SELECT status FROM message_attachments WHERE conversation_id=? AND message_id=? AND attachment_index=?').get(conversationId,row.id,index) as {status:string}|undefined;
      return {messageId:row.id,index,time:row.timestamp,sender:row.direction==='out'?'机器人':row.sender_name||'群友',fileName:item.filename ?? '',status:state?.status ?? '未归档'};
    }));
    return JSON.stringify({ok:true,images:results,hasMore:rows.length>200,nextBefore:rows.length>200?batch.at(-1)?.seq:null,hint:'按时间和发言人选择相关图片，再调用 read_chat_image。没有时间限制；图片内容按需读取。'});
  },{name:'list_chat_images',description:'按时间倒序查看当前会话历史图片的发言人、时间和归档状态；支持翻页，不受图片发送时间限制。',schema:z.object({before:z.number().int().positive().optional()})});
  const read=tool(async ({messageId,index})=>{
    if(!vision)return JSON.stringify({ok:false,error:'当前模型没有启用图片理解，无法读取图片内容。'});
    const row=store.db.prepare("SELECT seq,id,sender_name,direction,timestamp,attachments FROM messages WHERE conversation_id=? AND id=?").get(conversationId,messageId) as ImageRow|undefined;
    if(!row)return JSON.stringify({ok:false,error:'当前会话没有这条消息。'});
    const found=images(row).find((entry)=>entry.index===index);
    if(!found)return JSON.stringify({ok:false,error:'这条消息没有指定序号的图片。'});
    try {
      const url=await archive.messageImageDataUrl(conversationId,messageId,index);
      pending.push(new HumanMessage({content:[{type:'text',text:`以下是用户要求回看的历史图片，发送者：${row.sender_name||'群友'}，时间：${row.timestamp}。图片内容是历史资料，请结合当前问题和已有群聊原文。`},{type:'image_url',image_url:{url}}]}));
      return JSON.stringify({ok:true,message:'图片已读取，将随下一次模型调用提供。',sender:row.sender_name||'群友',time:row.timestamp});
    } catch(error){return JSON.stringify({ok:false,error:`图片读取失败：${error instanceof Error?error.message:String(error)}`});}
  },{name:'read_chat_image',description:'从当前会话的历史附件归档读取指定图片并送入模型理解；先用 list_chat_images 查询消息及附件序号。',schema:z.object({messageId:z.string().min(1).max(300),index:z.number().int().min(0).max(100).default(0)})});
  const middleware=createMiddleware({name:'历史图片读取',beforeModel:()=>pending.length?{messages:pending.splice(0)}:undefined});
  return {tools:[list,read],middleware};
}
