import type { SubAgent } from 'deepagents';

/** Inline Deep Agents helpers may research and work on files but cannot speak or manage the bot. */
export function internalSubagentTools<T extends { name: string }>(tools: T[]): T[] {
  const excluded = new Set(['send_text','send_media','send_native_card','send_keyboard','send_embed','speak','deliver_media','remember_fact','start_background_task','cancel_background_task','update_background_task','retry_delivery','set_voice']);
  return tools.filter((tool) => !excluded.has(tool.name) && !tool.name.startsWith('owner_'));
}

/** 合并前台和后台能力，保留各自独有的工具，同名时优先使用执行环境版本。 */
export function executionAgentTools<T extends {name:string}>(foreground:T[],background:T[]):T[] {
  const unique=new Map<string,T>();
  for(const item of [...background,...foreground])if(!unique.has(item.name))unique.set(item.name,item);
  return internalSubagentTools([...unique.values()]);
}

export function internalSubagent<T extends { name: string }>(tools: T[]) {
  return {
    name: 'general-purpose',
    description: '执行联网搜索、查证、下载、脚本、视频和工作区文件处理，并把结果交回对话 Agent；不能直接向群里发言。任务描述需带上必要的用户目标、链接和上下文。',
    systemPrompt: '你是主 Agent 的内部执行助手。独立完成委托的查证、工具调用或文件处理，将事实、来源、产物路径、失败和不确定之处交回主 Agent。视频抽帧只覆盖采样画面，不代表听到了声音。不要替主 Agent 发言，不改变人格或权限。',
    // Deep Agents' declaration is narrower than the interfaces its runtime accepts.
    tools: internalSubagentTools(tools) as unknown as NonNullable<SubAgent['tools']>,
    mode: 'isolated' as const,
  };
}
