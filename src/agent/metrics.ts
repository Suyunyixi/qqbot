import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { Store } from '../storage/store.js';
import type { Scope } from '../domain/types.js';
import { startToolTrace, withModelTrace } from '../models/trace.js';

type Identity={conversationId:string;scope:Scope;taskId?:string;turnId?:string;personaVersion?:string};
type Usage={input_tokens?:number;output_tokens?:number;total_tokens?:number;cache_read_tokens?:number;cache_miss_tokens?:number;input_token_details?:{cache_read?:number};output_token_details?:{reasoning?:number}};
function numberValue(...values:unknown[]):number|null {
  return values.find((value)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0) as number|undefined ?? null;
}
export function recordMetric(store:Store, identity:Identity, phase:string, name:string, started:number, result:unknown, status:'success'|'failed'):void {
  try {
    const usage:Usage|undefined=result instanceof AIMessage ? result.usage_metadata : result && typeof result==='object' && 'input_tokens' in result ? result as Usage : undefined;
    const metadata=result instanceof AIMessage ? result.response_metadata as {usage?:{input_tokens?:unknown;cache_read_input_tokens?:unknown;prompt_cache_hit_tokens?:unknown;prompt_cache_miss_tokens?:unknown;prompt_tokens_details?:{cached_tokens?:unknown};completion_tokens_details?:{reasoning_tokens?:unknown}};tokenUsage?:{prompt_cache_hit_tokens?:unknown;prompt_cache_miss_tokens?:unknown}} : undefined;
    const raw=metadata?.usage;
    const cached=numberValue(usage?.cache_read_tokens,usage?.input_token_details?.cache_read,raw?.cache_read_input_tokens,raw?.prompt_cache_hit_tokens,raw?.prompt_tokens_details?.cached_tokens,metadata?.tokenUsage?.prompt_cache_hit_tokens);
    // Anthropic 兼容接口的原始 input_tokens 不包含缓存读取量。
    const anthropicMiss=typeof raw?.cache_read_input_tokens==='number'?raw.input_tokens:undefined;
    const missed=numberValue(usage?.cache_miss_tokens,raw?.prompt_cache_miss_tokens,metadata?.tokenUsage?.prompt_cache_miss_tokens,anthropicMiss);
    const reasoning=numberValue(usage?.output_token_details?.reasoning,raw?.completion_tokens_details?.reasoning_tokens);
    store.db.prepare('INSERT INTO execution_metrics(conversation_id,scope,task_id,turn_id,phase,name,duration_ms,status,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_miss_tokens,reasoning_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(identity.conversationId,identity.scope,identity.taskId ?? null,identity.turnId ?? null,phase,name,Math.max(0,Date.now()-started),status,usage?.input_tokens ?? null,usage?.output_tokens ?? null,usage?.total_tokens ?? null,cached,missed,reasoning,new Date().toISOString());
  } catch(error) {console.error('运行指标保存失败：',error instanceof Error?error.message:String(error));}
}

function startToolMetric(store:Store,identity:Identity,name:string):number|bigint|undefined {
  try {return store.db.prepare("INSERT INTO execution_metrics(conversation_id,scope,task_id,turn_id,phase,name,duration_ms,status,created_at) VALUES(?,?,?,?,'工具',?,0,'running',?)").run(identity.conversationId,identity.scope,identity.taskId ?? null,identity.turnId ?? null,name,new Date().toISOString()).lastInsertRowid;}
  catch(error){console.error('工具运行记录保存失败：',error instanceof Error?error.message:String(error));return undefined;}
}
function finishToolMetric(store:Store,id:number|bigint|undefined,started:number,status:'success'|'failed'|'partial',characters?:number):void {
  if(id===undefined)return;
  try {store.db.prepare('UPDATE execution_metrics SET duration_ms=?,status=?,result_characters=? WHERE seq=?').run(Math.max(0,Date.now()-started),status,characters ?? null,id);}
  catch(error){console.error('工具运行记录更新失败：',error instanceof Error?error.message:String(error));}
}

/** 仅记录耗时和服务商返回的用量，不保存提示词或回复。 */
export function metricsMiddleware(store:Store,identity:Identity,phase:string,modelName:string) {
  return createMiddleware({
    name:`指标_${phase}`,
    wrapModelCall:async(request,handler)=>{
      const started=Date.now();
      try {const result=await withModelTrace({...identity,store,phase},()=>Promise.resolve(handler(request)));recordMetric(store,identity,phase,modelName,started,result,'success');return result;}
      catch(error) {recordMetric(store,identity,phase,modelName,started,undefined,'failed');throw error;}
    },
    wrapToolCall:async(request,handler)=>{
      const started=Date.now();const metricId=startToolMetric(store,identity,request.toolCall.name);const trace=startToolTrace({...identity,store,phase},request.toolCall.name,request.toolCall.args);
      try {
        const result=await handler(request);let failed='status' in result && result.status==='error';let partial=false;
        if('content' in result && typeof result.content==='string')try {const parsed=JSON.parse(result.content);failed ||= parsed?.ok===false;partial=parsed?.status==='partial';} catch { /* 普通文本结果无需解析。 */ }
        finishToolMetric(store,metricId,started,failed?'failed':partial?'partial':'success','content' in result && typeof result.content==='string'?result.content.length:undefined);trace?.finish(result,failed);return result;
      }
      catch(error) {finishToolMetric(store,metricId,started,'failed');trace?.finish({error:error instanceof Error?error.message:String(error)},true);throw error;}
    },
  });
}
