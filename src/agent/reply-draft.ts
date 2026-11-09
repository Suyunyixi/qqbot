export interface AgentReplyDraft { content:string; recipient?:string; remarks?:string }

/** 从执行结果读取交接信息；旧格式仍作为需要表达的内容处理。 */
export function parseAgentReplyDraft(text:string):AgentReplyDraft {
  const input=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try {
    const data=JSON.parse(input) as Record<string,unknown>;
    const content=data['内容'] ?? data.content;
    const recipient=data['回复对象'] ?? data.recipient;
    const remarks=data['备注'] ?? data.remarks;
    if(typeof content==='string' && content.trim())return {content:content.trim(),...(typeof recipient==='string' && recipient.trim()?{recipient:recipient.trim()}:{}),...(typeof remarks==='string' && remarks.trim()?{remarks:remarks.trim()}: {})};
  } catch { /* 兼容旧版模型返回的普通文字。 */ }
  return {content:text};
}
