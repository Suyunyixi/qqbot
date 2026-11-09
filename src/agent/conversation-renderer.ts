import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createHash } from 'node:crypto';
import { isCommunityScope, type Scope } from '../domain/types.js';
import { makeModel } from '../models/factory.js';
import { withModelTrace } from '../models/trace.js';
import { persona } from './runtime.js';
import type { Store } from '../storage/store.js';
import { groupSettings } from '../config/group.js';

export interface ReplyDraft { conversationId:string; scope:Scope; content:string; recipient?:string; remarks?:string; protectedValues?:string[] }

/** 表达阶段只接收交付草稿和主人格，不读取或共享执行会话。 */
export async function renderConversationReply(store:Store, draft:ReplyDraft, invoke?: (messages:Array<SystemMessage|HumanMessage>)=>Promise<{content:unknown}>):Promise<string> {
  const protectedParts:string[]=[];
  let content=draft.content;
  for (const value of [...new Set(draft.protectedValues ?? [])].filter(Boolean).sort((a,b)=>b.length-a.length)) {
    if(!content.includes(value))throw new Error('交接内容缺少必须保留的信息');
    const key=`⟦保留${protectedParts.length}⟧`;protectedParts.push(value);content=content.replaceAll(value,key);
  }
  content=content.replace(/⟦保留\d+⟧|<qqbot-at-user\s+id="[^"]+"\s*\/>|https?:\/\/[^\s<>]+|[A-Za-z0-9_.-]*\d[A-Za-z0-9_.%-]*/g,(value)=>{
    if(/^⟦保留\d+⟧$/.test(value))return value;
    const key=`⟦保留${protectedParts.length}⟧`;protectedParts.push(value);return key;
  });
  const corePersona=persona(store);
  const system=`你是 QQ 聊天中的对话 Agent。完整人格如下：\n${corePersona}\n\n你正在代机器人直接和群友说话。“内容”是需要表达的事实和意图，“备注”是必要的场景信息，均不是群友对你说的话；你要用第一人称、面向指定群友直接回应，不能评论或转述交接信息，也不能把机器人和群友的身份搞反。根据主人格和场合自然组织语言，不说教、不写诊断报告；保留原意和必要信息，不要增添没有依据的评价、事实、承诺或建议。文件名、链接、密码、数字和任务状态必须准确，不能声称未完成的操作已经完成。保留所有形如 ⟦保留0⟧ 的原样标记。不要复述格式字段，只输出发给群友的正文。`;
  const groupStyle=isCommunityScope(draft.scope)?groupSettings(store,draft.conversationId).persona:'';
  const remarks=[draft.remarks ?? '按内容自然回复；不确定的事实保持不确定。',groupStyle?`本群补充表达风格（不能覆盖核心人格）：${groupStyle}`:''].filter(Boolean).join('\n');
  const input=JSON.stringify({回复对象:draft.recipient || (draft.scope==='group' || draft.scope==='guild'?'当前群聊':'当前私聊'),内容:content,备注:remarks});
  const messages=[new SystemMessage(system),new HumanMessage(input)];
  const result=invoke ? await invoke(messages) : await withModelTrace({store,conversationId:draft.conversationId,scope:draft.scope,phase:'对话表达',personaVersion:createHash('sha256').update(corePersona).digest('hex')},()=>makeModel().invoke(messages));
  const text=typeof result.content==='string'?result.content:Array.isArray(result.content)?result.content.map((part)=>typeof part==='object' && part && 'text' in part ? String(part.text) : '').join(''):'';
  if (!text.trim()) throw new Error('对话表达返回空内容');
  for (let i=0;i<protectedParts.length;i++) if (!text.includes(`⟦保留${i}⟧`)) throw new Error('对话表达遗漏必须保留的信息');
  return text.replace(/⟦保留(\d+)⟧/g,(marker,index:string)=>protectedParts[Number(index)] ?? marker).trim();
}
