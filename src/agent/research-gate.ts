import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

/** Explicitly time-sensitive research must read at least one real source. */
export function needsCurrentResearch(text:string):boolean {
  if (/(刚才|上一条|上面|前面|群聊|聊天记录|本群|你发的|我发的|那张|这张)/.test(text) && !/(联网|上网|网络|网页|官网|官方资料|搜索引擎)/.test(text)) return false;
  const explicitSearch=/(联网|上网|搜索|搜一下|搜搜|查一下|查查|查询|查证|核实)/.test(text);
  const current=/(最新|实时|排行榜|热榜|热门|强度榜|版本更新|今天|今日|今年|近期|本周|本月)/.test(text);
  return explicitSearch && current && !(/(群聊|聊天记录|本群)/.test(text) && !/(联网|上网|网页|网络)/.test(text));
}
export function hasEvidence(message:unknown):boolean {
  if(!(message instanceof ToolMessage) || !['read_webpage','research_web'].includes(message.name ?? '')) return false;
  try {
    const data=JSON.parse(typeof message.content==='string'?message.content:'') as {ok?:boolean;result?:{text?:string;reads?:Array<{document?:{text?:string}}>}};
    return Boolean(data.ok && (data.result?.text?.trim() || data.result?.reads?.some((entry)=>entry.document?.text?.trim())));
  } catch { return false; }
}
export function researchGate(required:boolean, resumeInstruction?:string) {
  let verified=false; let reminders=0;
  return createMiddleware({
    name:'ResearchEvidenceGate',
    afterModel:{canJumpTo:['model','end'],hook:(state)=>{
      if(required && !verified && resumeInstruction) {
        let start=-1;for(let i=state.messages.length-1;i>=0;i--){const message=state.messages[i];if(message instanceof HumanMessage && message.content===resumeInstruction){start=i;break;}}
        if(start>=0)verified=state.messages.slice(start+1).some(hasEvidence);
      }
      const last=state.messages.at(-1);
      if(!required || verified || !(last instanceof AIMessage) || (last.tool_calls?.length ?? 0)>0) return undefined;
      if(reminders++<2) return {messages:[new HumanMessage('系统提醒：这个请求需要最新资料。请先联网搜索，并用 research_web 或 read_webpage 读取至少一个相关来源原文、核对日期；不能把搜索摘要当成已核实。若无法取得来源，请说明无法确认，不要猜测。')],jumpTo:'model' as const};
      return {messages:[new AIMessage('这次我没有取得能核对的来源原文，暂时无法确认最新情况；请稍后让我重新查询。')],jumpTo:'end' as const};
    }},
    wrapToolCall:async(request,handler)=>{
      const name=request.toolCall.name;
      if(required && !verified && ['send_text','send_media','send_native_card','send_keyboard','send_embed','deliver_media'].includes(name)) return new ToolMessage({tool_call_id:request.toolCall.id!,name,status:'error',content:'最新信息尚未读取来源原文，请先检索并核对；如果无法核实，请如实说明。'});
      const result=await handler(request);
      if(required && hasEvidence(result)) verified=true;
      return result;
    },
  });
}
