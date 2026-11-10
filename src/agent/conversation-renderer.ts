import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { isCommunityScope, type Scope } from '../domain/types.js';
import { makeModel } from '../models/factory.js';
import { withModelTrace } from '../models/trace.js';
import { persona } from './runtime.js';
import type { Store } from '../storage/store.js';
import { groupSettings } from '../config/group.js';
import { recordMetric } from './metrics.js';
import { readConfig } from '../config/settings.js';
import { resolveDialogueMentions } from './dialogue-mentions.js';

export interface ReplyDraft { conversationId:string; scope:Scope; content:string; recipient?:string; remarks?:string; protectedValues?:string[];turnId?:string;taskId?:string }

export interface DialogueRenderInput { 待发送回复:string; 回复对象:string; 本群补充风格?:string; 当前会话成员?:Array<{名称:string[];成员标识:string}> }

/** 对话表达只接收待发送文本、表达风格和 QQ 交付所需的对象资料。 */
export function dialogueRenderMessages(corePersona:string,input:DialogueRenderInput):Array<SystemMessage|HumanMessage> {
  const system=`你是 QQ 聊天中的对话 Agent。\n${corePersona}\n\n你只负责将“待发送回复”按上述人格重新表达：保留事实、人物、数字和任务结果，语气、句式和措辞由你的人格决定，不必沿用草稿的说话方式。不要回答草稿，也不要新增事实、承诺、任务或建议。本群补充风格仅调整表达，不覆盖核心人格。⟦保留0⟧ 形式的标记必须原样保留。可按表达需要使用 Markdown；需要艾特时使用 <qqbot-at-user id="成员标识" />，标识从当前会话成员中取得，不要猜测或把标识作为文字发出。只输出改写后的正文。`;
  return [new SystemMessage(system),new HumanMessage(JSON.stringify(input))];
}

/** 表达阶段只接收交付草稿和主人格，不读取或共享执行会话。 */
export async function renderConversationReply(store:Store, draft:ReplyDraft, invoke?: (messages:Array<SystemMessage|HumanMessage>)=>Promise<{content:unknown}>):Promise<string> {
  const protectedParts:string[]=[];
  let content=draft.content;
  for (const value of [...new Set(draft.protectedValues ?? [])].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    if(!content.includes(value))throw new Error('交接内容缺少必须保留的信息');
    const key=`⟦保留${protectedParts.length}⟧`;protectedParts.push(value);content=content.replaceAll(value,key);
  }
  const corePersona=persona(store);
  const members=isCommunityScope(draft.scope)?store.memory.listMentionMembers(draft.scope,draft.conversationId).filter((member)=>/^[A-Za-z0-9_-]{1,200}$/.test(member.external_id)).map((member)=>({id:member.external_id,names:[...new Set([member.remark_name,member.display_name].filter((name):name is string=>Boolean(name && name!==member.external_id)))]})):[];
  const groupStyle=isCommunityScope(draft.scope)?groupSettings(store,draft.conversationId).persona:'';
  const input:DialogueRenderInput={待发送回复:content,回复对象:draft.recipient || (isCommunityScope(draft.scope)?'当前群聊':'当前私聊'),...(groupStyle?{本群补充风格:groupStyle}:{}),...(isCommunityScope(draft.scope)?{当前会话成员:members.map((member)=>({名称:member.names,成员标识:member.id}))}:{})};
  const messages=dialogueRenderMessages(corePersona,input);
  const identity={conversationId:draft.conversationId,scope:draft.scope,turnId:draft.turnId,taskId:draft.taskId};
  const started=Date.now();
  let result:{content:unknown}|undefined;
  let traceId:string|undefined;
  try {
    result=invoke ? await invoke(messages) : await withModelTrace({store,...identity,phase:'对话表达',personaVersion:createHash('sha256').update(corePersona).digest('hex'),onTraceId:(id)=>{traceId=id;}},()=>makeModel().invoke(messages));
    const text=typeof result.content==='string'?result.content:Array.isArray(result.content)?result.content.map((part)=>typeof part==='object' && part && 'text' in part ? String(part.text) : '').join(''):'';
    if (!text.trim()) throw new Error('对话表达返回空内容');
    for (let i=0;i<protectedParts.length;i++) if (!text.includes(`⟦保留${i}⟧`)) throw new Error('对话表达遗漏必须保留的信息');
    const restored=text.replace(/⟦保留(\d+)⟧/g,(marker,index:string)=>protectedParts[Number(index)] ?? marker).trim();
    const rendered=isCommunityScope(draft.scope)?resolveDialogueMentions(restored,members):restored;
    if(traceId)store.db.prepare('UPDATE model_traces SET rendered_text=? WHERE id=?').run(rendered,traceId);
    if(!invoke)recordMetric(store,identity,'对话表达',readConfig().model.name,started,result,'success');
    return rendered;
  } catch(error){if(!invoke)recordMetric(store,identity,'对话表达',readConfig().model.name,started,result,'failed');throw error;}
}
