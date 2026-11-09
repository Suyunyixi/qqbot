import { HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import { checkpointImageDataUrl } from '../storage/checkpoints.js';

/** 历史图片保留引用；本轮需要的图片才读取并发送给模型。 */
export function checkpointMedia(previousMessageIds:Set<string>) {
  return createMiddleware({name:'CheckpointMedia',wrapModelCall:(request,handler)=>{
    const messages=request.messages.map((message)=>{
      if(!(message instanceof HumanMessage) || !Array.isArray(message.content))return message;
      let changed=false;
      const content=message.content.map((part)=>{
        if(!part || typeof part!=='object' || part.type!=='image_url' || !('image_url' in part))return part;
        if(message.id && previousMessageIds.has(message.id)) {
          changed=true;return {type:'text' as const,text:'[历史图片已归档，需要时可通过聊天记录和图片读取工具查看原图。]'};
        }
        const value=part.image_url;
        const url=typeof value==='string'?value:value && typeof value==='object' && 'url' in value?value.url:undefined;
        if(typeof url!=='string' || !url.startsWith('qqbot-image:'))return part;
        changed=true;
        const data=checkpointImageDataUrl(url);
        return {...part,image_url:typeof value==='object' && value!==null?{...value,url:data}:data};
      });
      return changed?new HumanMessage({id:message.id,name:message.name,content,additional_kwargs:message.additional_kwargs,response_metadata:message.response_metadata}):message;
    });
    return handler({...request,messages});
  }});
}
