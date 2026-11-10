import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { traceFile } from '../models/trace.js';

/** 仅提取最终文字；思考内容仍留在原始归档，不混入页面正文。 */
export function responseText(raw:string):string {
  const read=(item:unknown):string=>{
    if(!item || typeof item!=='object')return '';
    const value=item as {content?:unknown;choices?:Array<{message?:{content?:unknown};delta?:{content?:unknown}}>;type?:string;delta?:{type?:string;text?:unknown};content_block?:{type?:string;text?:unknown}};
    if(Array.isArray(value.content))return value.content.filter((part)=>part && typeof part==='object' && part.type==='text' && typeof part.text==='string').map((part)=>part.text).join('');
    if(typeof value.choices?.[0]?.message?.content==='string')return value.choices[0].message!.content as string;
    if(typeof value.choices?.[0]?.delta?.content==='string')return value.choices[0].delta!.content as string;
    if(value.delta?.type==='text_delta' && typeof value.delta.text==='string')return value.delta.text;
    if(value.type==='content_block_start' && value.content_block?.type==='text' && typeof value.content_block.text==='string')return value.content_block.text;
    return '';
  };
  try{return read(JSON.parse(raw));}catch{/* 流式归档按事件拼接。 */}
  return raw.split('\n').filter((line)=>line.startsWith('data:')).map((line)=>{try{return read(JSON.parse(line.slice(5).trim()));}catch{return '';}}).join('');
}

export function dialogueInput(raw:string):{content:string;recipient:string;remarks:string}|undefined {
  try {
    const request=JSON.parse(raw) as {messages?:Array<{role?:string;content?:unknown}>};
    const value=request.messages?.filter((message)=>message.role==='user').at(-1)?.content;
    const text=typeof value==='string'?value:Array.isArray(value)?value.filter((item)=>item && typeof item==='object' && item.type==='text').map((item)=>item.text).join(''):'';
    const parsed=JSON.parse(text) as Record<string,unknown>;
    if(typeof parsed['内容']!=='string')return undefined;
    return {content:parsed['内容'],recipient:typeof parsed['回复对象']==='string'?parsed['回复对象']:'',remarks:typeof parsed['备注']==='string'?parsed['备注']:''};
  } catch {return undefined;}
}

/** 直接检查实际请求的系统字段，而不是仅凭版本号推测。 */
export function requestIncludesPersona(raw:string,persona:string):boolean|null {
  try {
    const request=JSON.parse(raw) as {system?:unknown;messages?:Array<{role?:string;content?:unknown}>};
    const parts=(value:unknown):string=>typeof value==='string'?value:Array.isArray(value)?value.filter((item)=>item && typeof item==='object' && typeof item.text==='string').map((item)=>item.text).join(''):'';
    const system=parts(request.system) || (request.messages ?? []).filter((item)=>item.role==='system').map((item)=>parts(item.content)).join('');
    return !!persona && system.includes(persona);
  } catch {return null;}
}

/** 限制单个归档的解压体积，避免图片或异常大响应拖慢管理页。 */
export function readTraceText(name:string|null):string|undefined {
  if(!name)return undefined;
  try {const file=traceFile(name);if(fs.statSync(file).size>4*1024*1024)return undefined;return gunzipSync(fs.readFileSync(file),{maxOutputLength:4*1024*1024}).toString('utf8');}catch{return undefined;}
}
