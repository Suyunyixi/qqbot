import type { SubAgent } from 'deepagents';

/** Inline Deep Agents helpers may research and work on files but cannot speak or manage the bot. */
export function internalSubagentTools<T extends { name: string }>(tools: T[]): T[] {
  const excluded = new Set(['send_text','send_media','send_native_card','send_keyboard','send_embed','speak','deliver_media','remember_fact','start_background_task','cancel_background_task','update_background_task','retry_delivery','set_voice']);
  return tools.filter((tool) => !excluded.has(tool.name) && !tool.name.startsWith('owner_'));
}

export function internalSubagent<T extends { name: string }>(tools: T[]) {
  return {
    name: 'general-purpose',
    description: '处理受委托的查证、分析和工作区文件任务，将结果交回主 Agent；不能直接向群里发言。',
    systemPrompt: '你是主 Agent 的内部执行助手。完成明确的查证、分析或工作区文件任务，将事实和结果交回主 Agent。不要替主 Agent 发言，不改变人格或权限。',
    // Deep Agents' declaration is narrower than the interfaces its runtime accepts.
    tools: internalSubagentTools(tools) as unknown as NonNullable<SubAgent['tools']>,
    mode: 'isolated' as const,
  };
}
