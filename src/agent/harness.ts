import { readConfig } from '../config/settings.js';
import { effectiveTrigger, groupSettings } from '../config/group.js';
import { AgentRuntime } from './runtime.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { Store, type TaskRow } from '../storage/store.js';
import { TaskManager } from './task-manager.js';
import { shouldRespond } from './trigger.js';
import { isCommunityScope, type InboundEvent, type Sender } from '../domain/types.js';
import { createHash } from 'node:crypto';
import { BalanceAlert, balanceAlertText, isBalanceError } from './balance-alert.js';
import { AttachmentArchive } from '../storage/attachments.js';

export function replyForChatError(error: unknown): string {
  const status=typeof error==='object' && error!==null && 'status' in error ? Number(error.status) : undefined;
  const message=error instanceof Error ? error.message : String(error);
  if (status===402 || /\b402\b/.test(message)) {
    return isBalanceError(error)
      ? '模型服务余额或额度不足，暂时无法回复，请联系管理员检查。'
      : '模型服务返回计费错误，暂时无法回复，请联系管理员检查。';
  }
  return '抱歉，这次处理失败了，请稍后重试。';
}

export class Harness {
  readonly reply: ReplyRuntime;
  readonly tasks: TaskManager;
  readonly balanceAlert: BalanceAlert;
  readonly attachments: AttachmentArchive;
  private readonly agent: AgentRuntime;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(readonly store: Store, private readonly sender: Sender) {
    this.reply = new ReplyRuntime(store, sender);
    this.attachments=new AttachmentArchive(store);
    this.attachments.resumePending();
    this.attachments.backfillExisting();
    this.balanceAlert=new BalanceAlert(store,this.reply);
    this.agent = new AgentRuntime(store,(error)=>void this.balanceAlert.report(error),this.attachments);
    this.tasks = new TaskManager(store, async (task, signal) => {
      try {return await this.agent.runBackground({ conversationId: task.conversation_id, scope: task.scope, replyTo: task.reply_to ?? undefined, store, reply: this.reply, tasks: this.tasks, background: true, taskId: task.id,owner:!!task.actor_id && store.memory.isOwner(task.scope,task.conversation_id,task.actor_id),qqApi:this.sender.qqApi?.bind(this.sender) }, task, signal);}
      catch(error) {void this.balanceAlert.report(error);throw error;}
    }, (task) => this.callback(task));
  }
  start(): void { this.store.recoverSending(); this.tasks.start(); }
  async receive(event: InboundEvent): Promise<boolean> {
    if (!this.store.record(event)) return false;
    this.attachments.enqueue(event);
    // 在 Agent 图之前快速过滤，确保普通群消息只记录、不调用模型。
    if (isCommunityScope(event.scope) && !groupSettings(this.store, event.conversationId).enabled) return false;
    if (!shouldRespond(event, effectiveTrigger(this.store, event.scope, event.conversationId))) return false;
    const owner = this.store.memory.isOwner(event.scope, event.conversationId, event.senderId);
    void this.schedule(event.conversationId, async () => {
      await this.agent.respond({ conversationId: event.conversationId, scope: event.scope, replyTo: event.id, actorId:event.senderId, store: this.store, reply: this.reply, tasks: this.tasks, background: false, owner, qqApi:this.sender.qqApi?.bind(this.sender) }, event);
      this.agent.compactFinishedConversation(event.scope,event.conversationId);
      this.balanceAlert.recovered();
      this.agent.scheduleMemory(event.conversationId, this.store.eventSeq(event.conversationId, event.id));
    }).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('聊天回合失败：', message);
      const ownerBalance=owner && isBalanceError(err);
      if (!ownerBalance) void this.balanceAlert.report(err);
      const response=ownerBalance ? `${isCommunityScope(event.scope) ? `<@${event.senderId}> ` : ''}${balanceAlertText}` : replyForChatError(err);
      try {
        await this.reply.send(event.conversationId, event.scope, event.id, 'text', response);
        if (ownerBalance) this.balanceAlert.notified();
      } catch (sendError) {
        if (ownerBalance) void this.balanceAlert.report(err);
        console.error('错误提示发送失败：', sendError instanceof Error ? sendError.message : sendError);
      }
    });
    return true;
  }
  private async callback(task: TaskRow): Promise<void> {
    const instruction = task.status === 'waiting' ? '子 Agent 等待群友回答，请转述问题并说明可以@你回复；不要把等待中的任务当作完成。' : task.status === 'progress' ? '这是已安排向群友告知的进度，不代表任务已完成；结合上下文，用你的人格简短表达。' : '请根据原请求，使用 send_media 逐项真实发送要求的文件，再用你的人格回复。发送失败须说明实际情况。';
    const event: InboundEvent = { id: task.reply_to ?? '', conversationId: task.conversation_id, scope: task.scope, senderId: 'system', senderName: '后台任务', timestamp: new Date().toISOString(), isMention: false, attachments: [], content: `后台任务通知（这是系统事件，不是群友发言）。任务ID：${task.id}；原任务：${task.instruction}；状态：${task.status}；结果或问题：${task.result ?? ''}；错误：${task.error ?? ''}。${instruction}` };
    const notificationKey = `${task.status}:${createHash('sha256').update(task.result ?? task.error ?? '').digest('hex').slice(0, 16)}`;
    try {await this.schedule(task.conversation_id, async () => {await this.agent.respond({ conversationId: task.conversation_id, scope: task.scope, replyTo: task.reply_to ?? undefined, store: this.store, reply: this.reply, tasks: this.tasks, background: false, taskId: task.id, notificationKey }, event, true);this.agent.compactFinishedConversation(task.scope,task.conversation_id);});}
    catch(error) {void this.balanceAlert.report(error);throw error;}
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
