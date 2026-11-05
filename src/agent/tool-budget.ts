import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

/** Bound tool loops while giving the model a chance to report or delegate. */
export function toolBudget(background: boolean) {
  let calls = 0;
  let warned = false;
  const soft = background ? 45 : 16;
  const hard = background ? 65 : 28;
  return createMiddleware({
    name: 'ToolBudget',
    beforeModel: { canJumpTo: ['end'], hook: () => {
      if (calls >= hard) {
        if (background) throw new Error('后台任务工具调用次数过多，已停止；请检查已有产物后重新执行');
        return { messages: [new AIMessage('刚才处理时步骤过多，我先停下来，避免反复操作。已完成的产物会保留，可以让我继续处理或换一种方式。')], jumpTo: 'end' as const };
      }
      if (!warned && calls >= soft) {
        warned = true;
        return { messages: [new HumanMessage(background
          ? '系统提醒：任务已经执行了较多步骤。请检查实际结果，尽快完成；遇到障碍应如实报告，不要反复尝试。'
          : '系统提醒：本轮已经执行了较多步骤。请尽快根据真实结果答复；剩余耗时工作可交给后台任务，不要反复操作。')] };
      }
      return undefined;
    } },
    wrapToolCall: async (request, handler) => { calls++; return handler(request); },
  });
}
