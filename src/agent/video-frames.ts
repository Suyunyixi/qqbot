import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { createMiddleware, tool } from 'langchain';
import { z } from 'zod';
import { AttachmentArchive } from '../storage/attachments.js';
import { resolveWorkspaceFile } from '../storage/workspace.js';
import { runProcess } from '../tools/process.js';
import { quotedAttachmentArchiveId } from './quoted-message.js';

/** 将视频采样画面提供给视觉模型；声音不作为已理解内容。 */
export function videoFrameTools(archive:AttachmentArchive,conversationId:string,vision:boolean,signal?:AbortSignal) {
  const pending:HumanMessage[]=[];
  const read=tool(async ({input,messageId,index,source,frameCount,timestamps})=>{
    if(!vision)return JSON.stringify({ok:false,error:'当前模型未启用图片理解，不能读取视频画面。'});
    if((!!input)===(!!messageId))return JSON.stringify({ok:false,error:'请选择工作区文件路径或聊天消息标识，二者只能指定一个。'});
    let dir:string|undefined;
    try {
      const file=input ? resolveWorkspaceFile(conversationId,input) : (await archive.archivedFile(conversationId,source==='quote'?quotedAttachmentArchiveId(messageId!):messageId!,index)).path;
      const probe=await runProcess('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',file],{timeoutMs:20000,signal});
      const info=JSON.parse(probe.stdout) as {format?:{duration?:string};streams?:Array<{codec_type?:string;duration?:string}>};
      const video=info.streams?.find((stream)=>stream.codec_type==='video');
      if(!video)throw new Error('文件没有可读取的视频画面');
      const duration=Number(info.format?.duration ?? video.duration);
      if(!Number.isFinite(duration) || duration<=0)throw new Error('无法确定视频时长，不能可靠定位画面');
      const points=timestamps?.length ? timestamps : Array.from({length:frameCount},(_,i)=>duration*(i+0.5)/frameCount);
      if(points.some((point)=>point>=duration))throw new Error(`采样时间必须小于视频时长 ${duration.toFixed(2)} 秒`);
      dir=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-video-'));
      const blocks:Array<{type:'text';text:string}|{type:'image_url';image_url:{url:string}}>=[];
      blocks.push({type:'text',text:`视频画面抽样：视频时长 ${duration.toFixed(2)} 秒。以下画面只覆盖标出的时刻，未读取声音，不能据此声称看完全部画面或听到了说话内容；需要其他时刻可再次调用。`});
      for(const [i,point] of points.entries()) {
        const output=path.join(dir,`${i}.jpg`);
        await runProcess('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-ss',String(point),'-i',file,'-frames:v','1','-vf','scale=1280:1280:force_original_aspect_ratio=decrease','-q:v','4','-y',output],{timeoutMs:30000,signal});
        const data=fs.readFileSync(output);if(!data.length)throw new Error(`无法读取 ${point.toFixed(2)} 秒的画面`);
        blocks.push({type:'text',text:`时间 ${point.toFixed(2)} 秒`},{type:'image_url',image_url:{url:`data:image/jpeg;base64,${data.toString('base64')}`}});
      }
      pending.push(new HumanMessage({content:blocks}));
      return JSON.stringify({ok:true,duration,frameTimes:points,hasAudio:!!info.streams?.some((stream)=>stream.codec_type==='audio'),audioUnderstood:false,message:'采样画面已提供给模型；声音尚未识别，可选择其他时间继续查看。'});
    } catch(error) {return JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)});}
    finally {if(dir){for(const file of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,file));fs.rmdirSync(dir);}}
  },{name:'read_video_frames',description:'读取本会话工作区的视频，或按消息标识读取本会话已归档的视频附件；从指定时间或均匀抽帧送给视觉模型，可以多次查看。只看画面，不识别视频声音。',schema:z.object({input:z.string().min(1).max(1000).optional(),messageId:z.string().min(1).max(300).optional(),index:z.number().int().min(0).max(100).default(0),source:z.enum(['message','quote']).default('message'),frameCount:z.number().int().min(1).max(12).default(6),timestamps:z.array(z.number().min(0)).min(1).max(12).optional()})});
  const middleware=createMiddleware({name:'视频画面读取',beforeModel:()=>pending.length?{messages:pending.splice(0)}:undefined});
  return {tools:[read],middleware};
}
