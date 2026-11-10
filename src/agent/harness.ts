import { readConfig } from '../config/settings.js';
import { effectiveTrigger, groupSettings } from '../config/group.js';
import { AgentRuntime } from './runtime.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { Store, type TaskRow } from '../storage/store.js';
import { TaskManager } from './task-manager.js';
import { shouldRespond } from './trigger.js';
import { isCommunityScope, type InboundEvent, type Sender } from '../domain/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { BalanceAlert, balanceAlertText, isBalanceError } from './balance-alert.js';
import { AttachmentArchive } from '../storage/attachments.js';
import { quotedAttachmentArchiveId, quotedMessageAttachments } from './quoted-message.js';
import { renderConversationReply } from './conversation-renderer.js';
import { runJmTask } from '../tools/jm.js';

export function replyForChatError(error: unknown): string {
  const status=typeof error==='object' && error!==null && 'status' in error ? Number(error.status) : undefined;
  const message=error instanceof Error ? error.message : String(error);
  if (/recursion limit.*reached/i.test(message)) return '这次处理步骤超过上限，没能完成；可以让我缩小范围再试一次。';
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
    this.reply = new ReplyRuntime(store, sender, (draft)=>renderConversationReply(store,draft));
    this.attachments=new AttachmentArchive(store);
    this.attachments.resumePending();
    this.attachments.backfillExisting();
    this.balanceAlert=new BalanceAlert(store,this.reply);
    this.agent = new AgentRuntime(store,(error)=>void this.balanceAlert.report(error),this.attachments);
    this.tasks = new TaskManager(store, async (task, signal) => {
      try {if(task.kind==='jm_pdf')return await runJmTask(task,this.reply,signal);return await this.agent.runBackground({ conversationId: task.conversation_id, scope: task.scope, replyTo: task.reply_to ?? undefined, store, reply: this.reply, tasks: this.tasks, background: true, taskId: task.id,owner:!!task.actor_id && store.memory.isOwner(task.scope,task.conversation_id,task.actor_id),qqApi:this.sender.qqApi?.bind(this.sender) }, task, signal);}
      catch(error) {void this.balanceAlert.report(error);throw error;}
    }, (task) => this.callback(task));
  }
  start(): void { this.store.db.prepare("UPDATE execution_metrics SET status='interrupted' WHERE phase='工具' AND status='running'").run();this.store.db.prepare("UPDATE model_traces SET status='interrupted',finished_at=? WHERE status='running'").run(new Date().toISOString());this.store.db.prepare("UPDATE chat_turns SET status='interrupted',finished_at=? WHERE status IN ('queued','running')").run(new Date().toISOString());this.store.recoverSending(); this.tasks.start(); }
  async receive(event: InboundEvent, commitCursor?:()=>void, onPersistFailure?:(error:unknown)=>void): Promise<boolean> {
    let recorded:boolean;
    try {recorded=commitCursor?this.store.db.transaction(()=>{const created=this.store.record(event);commitCursor();return created;})():this.store.record(event);}
    catch(error){onPersistFailure?.(error);throw error;}
    if (!recorded) return false;
    this.attachments.enqueue(event);
    const quotedAttachments=quotedMessageAttachments(event.raw);
    if(quotedAttachments.length)this.attachments.enqueue({...event,id:quotedAttachmentArchiveId(event.id),attachments:quotedAttachments});
    // 在 Agent 图之前快速过滤，确保普通群消息只记录、不调用模型。
    if (isCommunityScope(event.scope) && !groupSettings(this.store, event.conversationId).enabled) return false;
    if (!shouldRespond(event, effectiveTrigger(this.store, event.scope, event.conversationId))) return false;
    const owner = this.store.memory.isOwner(event.scope, event.conversationId, event.senderId);
    const turnId=randomUUID();const received=Date.now();
    try {this.store.db.prepare("INSERT INTO chat_turns(id,conversation_id,scope,message_id,status,received_at) VALUES(?,?,?,?,'queued',?)").run(turnId,event.conversationId,event.scope,event.id,new Date(received).toISOString());}
    catch(error){console.error('记录会话回合失败：',error instanceof Error?error.message:String(error));}
    void this.schedule(event.conversationId, async () => {
      const started=Date.now();
      try {this.store.db.prepare("UPDATE chat_turns SET status='running',started_at=?,queue_ms=? WHERE id=?").run(new Date(started).toISOString(),started-received,turnId);}catch(error){console.error('记录回合开始失败：',error instanceof Error?error.message:String(error));}
      await this.agent.respond({ conversationId: event.conversationId, scope: event.scope, replyTo: event.id, actorId:event.senderId, store: this.store, reply: this.reply, tasks: this.tasks, background: false, owner, turnId, qqApi:this.sender.qqApi?.bind(this.sender) }, event);
      try {this.store.db.prepare("UPDATE chat_turns SET status='completed',finished_at=?,duration_ms=? WHERE id=?").run(new Date().toISOString(),Date.now()-received,turnId);}catch(error){console.error('记录回合完成失败：',error instanceof Error?error.message:String(error));}
      this.agent.compactFinishedConversation(event.scope,event.conversationId);
      this.balanceAlert.recovered();
      this.agent.scheduleMemory(event.conversationId, this.store.eventSeq(event.conversationId, event.id));
    }).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('聊天回合失败：', message);
      const ownerBalance=owner && isBalanceError(err);
      if (!ownerBalance) void this.balanceAlert.report(err);
      const response=ownerBalance ? `${isCommunityScope(event.scope) ? `<qqbot-at-user id="${event.senderId}" /> ` : ''}${balanceAlertText}` : replyForChatError(err);
      try {
        await this.reply.sendSystemText(event.conversationId,event.scope,event.id,response);
        if (ownerBalance) this.balanceAlert.notified();
      } catch (sendError) {
        if (ownerBalance) void this.balanceAlert.report(err);
        console.error('错误提示发送失败：', sendError instanceof Error ? sendError.message : sendError);
      }
      try {this.store.db.prepare("UPDATE chat_turns SET status='failed',finished_at=?,duration_ms=? WHERE id=?").run(new Date().toISOString(),Date.now()-received,turnId);}catch(error){console.error('记录回合失败状态失败：',error instanceof Error?error.message:String(error));}
    });
    return true;
  }
  private async callback(task: TaskRow): Promise<void> {
    const instruction = task.status === 'waiting' ? '任务正在等待答复，尚未完成。' : task.status === 'progress' ? '这是任务进度，尚未完成。' : '根据原请求和实际结果处理；需要交付的文件确认发送后再说已发送，已交付的内容不要重复发送。';
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
