import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzip, createGzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dataDir } from '../config/settings.js';
import type { Store } from '../storage/store.js';
import type { Scope } from '../domain/types.js';

type Context={store:Store;conversationId:string;scope:Scope;turnId?:string;taskId?:string;phase:string;personaVersion?:string;onTraceId?:(id:string)=>void};
const traceContext=new AsyncLocalStorage<Context>();
const compress=promisify(gzip);
const traceRoot=path.join(dataDir,'traces');
const secretKey=/^(authorization|api[_-]?key|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|sessdata)$/i;

function redactJson(value:unknown):string {
  return JSON.stringify(value,(key,item)=>key && secretKey.test(key)?'[已隐藏敏感字段]':item);
}
function requestSecrets(init?:RequestInit):string[] {
  const headers=new Headers(init?.headers);const auth=headers.get('authorization') ?? '';
  return [...new Set([headers.get('x-api-key') ?? '',headers.get('api-key') ?? '',auth.replace(/^Bearer\s+/i,'')].filter((value)=>value.length>=8))];
}
function redactText(text:string,secrets:string[]):string {for(const secret of secrets)text=text.replaceAll(secret,'[已隐藏密钥]');return text;}

/** 并发模型调用各自关联当前回合，不保存认证请求头。 */
export function withModelTrace<T>(context:Context,run:()=>Promise<T>):Promise<T> {return traceContext.run(context,run);}

/** 工具输入和结果按回合归档，与模型网络请求分开保存。 */
export function startToolTrace(context:Context,name:string,input:unknown) {
  const id=randomUUID();const db=context.store.db;
  try {db.prepare("INSERT INTO model_traces(id,conversation_id,scope,turn_id,task_id,phase,tool_name,started_at,status) VALUES(?,?,?,?,?,'工具',?,?,'running')").run(id,context.conversationId,context.scope,context.turnId ?? null,context.taskId ?? null,name,new Date().toISOString());}
  catch(error){console.error('工具调用记录创建失败：',error instanceof Error?error.message:String(error));return undefined;}
  let encoded:string;try{encoded=redactJson(input ?? null);}catch{encoded=JSON.stringify({error:'工具输入无法序列化'});}
  void writeTrace(`${id}.request.gz`,Buffer.from(encoded)).then((file)=>{if(db.open)db.prepare('UPDATE model_traces SET request_path=? WHERE id=?').run(file,id);}).catch((error)=>{if(db.open)db.prepare('UPDATE model_traces SET error=? WHERE id=?').run(`输入记录失败：${String(error)}`,id);});
  return {finish:(output:unknown,failed:boolean)=>{
    let content:string;try{content=redactJson(output ?? null);}catch{content=JSON.stringify({error:'工具结果无法序列化'});}
    void writeTrace(`${id}.response.gz`,Buffer.from(content)).then((file)=>{if(db.open)db.prepare('UPDATE model_traces SET response_path=?,status=?,finished_at=? WHERE id=?').run(file,failed?'failed':'completed',new Date().toISOString(),id);}).catch((error)=>{if(db.open)db.prepare("UPDATE model_traces SET status='failed',error=?,finished_at=? WHERE id=?").run(`结果记录失败：${String(error)}`,new Date().toISOString(),id);});
  }};
}

async function writeTrace(name:string,content:Buffer):Promise<string> {
  await fs.promises.mkdir(traceRoot,{recursive:true,mode:0o700});
  await fs.promises.writeFile(path.join(traceRoot,name),await compress(content),{mode:0o600,flag:'wx'});
  return name;
}

async function writeResponse(name:string,response:Response,secrets:string[]):Promise<string> {
  await fs.promises.mkdir(traceRoot,{recursive:true,mode:0o700});
  const body=response.body;
  if(!body)return writeTrace(name,Buffer.alloc(0));
  const source=Readable.from((async function*(){const reader=body.getReader();const decoder=new TextDecoder();const keep=Math.max(0,...secrets.map((secret)=>secret.length-1));let pending='';try {for(;;){const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});pending=redactText(pending,secrets);if(done){if(pending)yield Buffer.from(pending);break;}if(pending.length>keep){const end=pending.length-keep;yield Buffer.from(pending.slice(0,end));pending=pending.slice(end);}}}finally{reader.releaseLock();}})());
  await pipeline(source,createGzip(),fs.createWriteStream(path.join(traceRoot,name),{mode:0o600,flags:'wx'}));
  return name;
}

/** 记录实际模型 HTTP 请求与原始响应；读取响应副本，不改变发送给 SDK 的流。 */
export async function tracedModelFetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response> {
  const context=traceContext.getStore();
  if(!context)return globalThis.fetch(input,init);
  const id=randomUUID();const db=context.store.db;const started=new Date().toISOString();
  try {db.prepare("INSERT INTO model_traces(id,conversation_id,scope,turn_id,task_id,phase,started_at,status,persona_version) VALUES(?,?,?,?,?,?,?,'running',?)").run(id,context.conversationId,context.scope,context.turnId ?? null,context.taskId ?? null,context.phase,started,context.personaVersion ?? null);}
  catch(error){console.error('模型调用记录创建失败：',error instanceof Error?error.message:String(error));return globalThis.fetch(input,init);}
  context.onTraceId?.(id);
  const secrets=requestSecrets(init);
  let inputBody=typeof init?.body==='string'?init.body:undefined;
  if(inputBody)try{inputBody=redactJson(JSON.parse(inputBody));}catch{/* 非 JSON 请求原样记录，但仍会隐藏当前认证密钥。 */}
  const request=inputBody===undefined?undefined:Buffer.from(redactText(inputBody,secrets));
  const requestSaved=request?writeTrace(`${id}.request.gz`,request):Promise.reject(new Error('无法记录该请求体类型'));
  void requestSaved.then((name)=>{if(db.open)db.prepare('UPDATE model_traces SET request_path=? WHERE id=?').run(name,id);}).catch((error)=>{if(db.open)db.prepare('UPDATE model_traces SET error=? WHERE id=?').run(`输入记录失败：${String(error)}`,id);});
  try {
    const response=await globalThis.fetch(input,init);
    const contentType=response.headers.get('content-type') ?? '';
    if(db.open)db.prepare('UPDATE model_traces SET http_status=?,content_type=? WHERE id=?').run(response.status,contentType,id);
    void writeResponse(`${id}.response.gz`,response.clone(),secrets).then((name)=>{if(db.open)db.prepare('UPDATE model_traces SET response_path=?,status=?,finished_at=? WHERE id=?').run(name,response.ok?'completed':'failed',new Date().toISOString(),id);}).catch((error)=>{if(db.open)db.prepare("UPDATE model_traces SET status='failed',error=?,finished_at=? WHERE id=?").run(`响应记录失败：${String(error)}`,new Date().toISOString(),id);});
    return response;
  } catch(error) {if(db.open)db.prepare("UPDATE model_traces SET status='failed',error=?,finished_at=? WHERE id=?").run(String(error).slice(0,1000),new Date().toISOString(),id);throw error;}
}

/** 仅从本地归档目录读取指定调用的输入或响应。 */
export function traceFile(name:string):string {
  if(!/^[0-9a-f-]{36}\.(request|response)\.gz$/.test(name))throw new Error('调用记录路径无效');
  return path.join(traceRoot,name);
}
