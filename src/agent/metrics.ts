import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { Store } from '../storage/store.js';
import type { Scope } from '../domain/types.js';

type Identity={conversationId:string;scope:Scope;taskId?:string};
export function recordMetric(store:Store, identity:Identity, phase:string, name:string, started:number, result:unknown, status:'success'|'failed'):void {
  try {
    const usage=result instanceof AIMessage ? result.usage_metadata : result && typeof result==='object' && 'input_tokens' in result ? result as {input_tokens?:number;output_tokens?:number;total_tokens?:number} : undefined;
    store.db.prepare('INSERT INTO execution_metrics(conversation_id,scope,task_id,phase,name,duration_ms,status,input_tokens,output_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(identity.conversationId,identity.scope,identity.taskId ?? null,phase,name,Math.max(0,Date.now()-started),status,usage?.input_tokens ?? null,usage?.output_tokens ?? null,usage?.total_tokens ?? null,new Date().toISOString());
  } catch(error) {console.error('运行指标保存失败：',error instanceof Error?error.message:String(error));}
}

/** 仅记录耗时和服务商返回的用量，不保存提示词或回复。 */
export function metricsMiddleware(store:Store,identity:Identity,phase:string,modelName:string) {
  return createMiddleware({
    name:`指标_${phase}`,
    wrapModelCall:async(request,handler)=>{
      const started=Date.now();
      try {const result=await handler(request);recordMetric(store,identity,phase,modelName,started,result,'success');return result;}
      catch(error) {recordMetric(store,identity,phase,modelName,started,undefined,'failed');throw error;}
    },
    wrapToolCall:async(request,handler)=>{
      const started=Date.now();
      try {
        const result=await handler(request);let failed='status' in result && result.status==='error';
        if('content' in result && typeof result.content==='string')try {failed ||= JSON.parse(result.content)?.ok===false;} catch { /* 普通文本结果无需解析。 */ }
        recordMetric(store,identity,'工具',request.toolCall.name,started,undefined,failed?'failed':'success');return result;
      }
      catch(error) {recordMetric(store,identity,'工具',request.toolCall.name,started,undefined,'failed');throw error;}
    },
  });
}
