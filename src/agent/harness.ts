import { readConfig } from '../config/settings.js';
import { effectiveTrigger, groupSettings } from '../config/group.js';
import { AgentRuntime } from './runtime.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { Store, type TaskRow } from '../storage/store.js';
import { TaskManager } from './task-manager.js';
import { shouldRespond } from './trigger.js';
import { isCommunityScope, type InboundEvent, type Sender } from '../domain/types.js';
import { createHash } from 'node:crypto';

export class Harness {
  readonly reply: ReplyRuntime;
  readonly tasks: TaskManager;
  private readonly agent: AgentRuntime;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(readonly store: Store, private readonly sender: Sender) {
    this.reply = new ReplyRuntime(store, sender);
    this.agent = new AgentRuntime(store);
    this.tasks = new TaskManager(store, (task, signal) => this.agent.runBackground({ conversationId: task.conversation_id, scope: task.scope, replyTo: task.reply_to ?? undefined, store, reply: this.reply, tasks: this.tasks, background: true, taskId: task.id,owner:!!task.actor_id && store.memory.isOwner(task.scope,task.conversation_id,task.actor_id),qqApi:this.sender.qqApi?.bind(this.sender) }, task, signal), (task) => this.callback(task));
  }
  start(): void { this.store.recoverSending(); this.tasks.start(); }
  async receive(event: InboundEvent): Promise<boolean> {
    if (!this.store.record(event)) return false;
    // This fast gate is part of the Harness, before the Deep Agent graph. It
    // protects the zero-model guarantee even when another run holds the thread.
    if (isCommunityScope(event.scope) && !groupSettings(this.store, event.conversationId).enabled) return false;
    if (!shouldRespond(event, effectiveTrigger(this.store, event.scope, event.conversationId))) return false;
    const owner = this.store.memory.isOwner(event.scope, event.conversationId, event.senderId);
    void this.schedule(event.conversationId, () => this.agent.respond({ conversationId: event.conversationId, scope: event.scope, replyTo: event.id, actorId:event.senderId, store: this.store, reply: this.reply, tasks: this.tasks, background: false, owner, qqApi:this.sender.qqApi?.bind(this.sender) }, event)).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('聊天回合失败：', message);
      try { await this.reply.send(event.conversationId, event.scope, event.id, 'text', '抱歉，这次处理失败了，请稍后重试。'); }
      catch (sendError) { console.error('错误提示发送失败：', sendError instanceof Error ? sendError.message : sendError); }
    });
    return true;
  }
  private async callback(task: TaskRow): Promise<void> {
    const instruction = task.status === 'waiting' ? '子 Agent 等待群友回答，请转述问题并说明可以@你回复；不要把等待中的任务当作完成。' : task.status === 'progress' ? '这是进行中进度，不代表任务已完成；如果值得告知群友，请简短回复。' : '请根据原请求，使用 send_media 逐项真实发送要求的文件，再用你的人格回复。发送失败须说明实际情况。';
    const event: InboundEvent = { id: task.reply_to ?? '', conversationId: task.conversation_id, scope: task.scope, senderId: 'system', senderName: '后台任务', timestamp: new Date().toISOString(), isMention: false, attachments: [], content: `后台任务通知（这是系统事件，不是群友发言）。任务ID：${task.id}；原任务：${task.instruction}；状态：${task.status}；结果或问题：${task.result ?? ''}；错误：${task.error ?? ''}。${instruction}` };
    const notificationKey = `${task.status}:${createHash('sha256').update(task.result ?? task.error ?? '').digest('hex').slice(0, 16)}`;
    await this.schedule(task.conversation_id, () => this.agent.respond({ conversationId: task.conversation_id, scope: task.scope, replyTo: task.reply_to ?? undefined, store: this.store, reply: this.reply, tasks: this.tasks, background: false, taskId: task.id, notificationKey }, event, true));
  }
  private schedule(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
  stop(): void { this.tasks.stop(); }
}
