import { Store, type TaskRow } from '../storage/store.js';
import { readConfig } from '../config/settings.js';
import type { Scope } from '../domain/types.js';

type TaskRunner = (task: TaskRow, signal: AbortSignal) => Promise<string>;
type Callback = (task: TaskRow) => Promise<void>;

/** SQLite-backed local async worker. This is not the hosted AsyncSubAgent API. */
export class TaskManager {
  private running = new Map<string, AbortController>();
  private delivering = new Set<string>();
  private waiting = new Map<string, (answer: string) => void>();
  private stopping = false;
  constructor(private readonly store: Store, private readonly runTask: TaskRunner, private readonly onResult: Callback) {}
  start(): void { this.store.interruptRunning(); this.pump(); }
  enqueue(conversationId: string, scope: Scope, replyTo: string | undefined, instruction: string): string {
    const id = this.store.addTask(conversationId, scope, replyTo, instruction); this.pump(); return id;
  }
  cancel(id: string, conversationId: string): string {
    const task = this.store.task(id);
    if (!task || task.conversation_id !== conversationId) throw new Error('找不到该群的任务');
    if (!['queued', 'running', 'waiting'].includes(task.status)) return `任务当前状态：${task.status}`;
    this.running.get(id)?.abort();
    this.store.setTask(id, 'cancelled');
    return '已取消任务';
  }
  update(id: string, conversationId: string, instruction: string): string {
    const task = this.store.task(id);
    if (!task || task.conversation_id !== conversationId) throw new Error('找不到该会话的任务');
    if (!['queued', 'running', 'waiting'].includes(task.status)) throw new Error(`任务已经${task.status}，无法追加`);
    const resolve = this.waiting.get(id);
    if (task.status === 'waiting' && resolve) { this.waiting.delete(id); this.store.setTask(id, 'running'); resolve(instruction); return '已将答复交给子 Agent'; }
    this.store.addTaskUpdate(id, instruction);
    return '已记录补充要求，当前步骤完成后继续执行';
  }
  async requestInput(id: string, question: string, signal?: AbortSignal): Promise<string> {
    if (!this.running.has(id)) throw new Error('任务不在运行中');
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiting.delete(id); reject(new Error('任务已取消或超时')); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.set(id, (answer) => { signal?.removeEventListener('abort', abort); resolve(answer); });
      this.store.setTask(id, 'waiting', question);
      this.notifyPending();
    });
  }
  reportProgress(id: string, content: string): void {
    const task = this.store.task(id);
    if (!task || !['running', 'waiting'].includes(task.status)) throw new Error('任务不在运行中');
    this.store.addProgress(id, content); this.notifyPending();
  }
  notifyPending(): void {
    if (this.stopping) return;
    for (const progress of this.store.pendingProgress()) {
      const key = `progress:${progress.id}`;
      if (this.delivering.has(key)) continue;
      const task = this.store.task(progress.task_id); if (!task) continue;
      this.delivering.add(key);
      void this.onResult({ ...task, status: 'progress', result: progress.content }).then(() => this.store.markProgress(progress.id)).catch((err: unknown) => {
        console.error(`任务 ${task.id} 进度通知失败：`, err instanceof Error ? err.message : err);
      }).finally(() => this.delivering.delete(key));
    }
    for (const task of this.store.pendingNotifications()) {
      if (this.delivering.has(task.id)) continue;
      this.delivering.add(task.id);
      void this.onResult(task).then(() => this.store.markNotified(task.id, task.status)).catch((err: unknown) => {
        console.error(`任务 ${task.id} 回调失败，将保留待处理：`, err instanceof Error ? err.message : err);
      }).finally(() => {
        this.delivering.delete(task.id);
        if (this.store.task(task.id)?.status !== task.status) this.notifyPending();
      });
    }
  }
  private pump(): void {
    if (this.stopping) return;
    const capacity = readConfig().tasks.concurrency - this.running.size;
    for (const task of this.store.queuedTasks().slice(0, Math.max(0, capacity))) {
      if (this.running.has(task.id)) continue;
      const controller = new AbortController();
      this.running.set(task.id, controller);
      this.store.setTask(task.id, 'running');
      const timer = setTimeout(() => controller.abort(), readConfig().tasks.timeoutMs);
      void this.runWithUpdates(task, controller.signal).then((result) => {
        if (this.store.task(task.id)?.status !== 'cancelled') this.store.setTask(task.id, 'completed', result);
      }).catch((err: unknown) => {
        if (this.store.task(task.id)?.status !== 'cancelled') this.store.setTask(task.id, 'failed', undefined, err instanceof Error ? err.message : String(err));
      }).finally(() => {
        clearTimeout(timer); this.running.delete(task.id); this.notifyPending(); this.pump();
      });
    }
  }
  private async runWithUpdates(task: TaskRow, signal: AbortSignal): Promise<string> {
    let current = task;
    let result = '';
    do {
      result = await this.runTask(current, signal);
      const updates = this.store.takeTaskUpdates(task.id);
      if (!updates.length) return result;
      current = { ...task, instruction: `原任务：${task.instruction}\n此前执行结果：${result}\n用户追加要求：${updates.join('\n')}` };
    } while (!signal.aborted);
    throw new Error('任务已取消或超时');
  }
  stop(): void { this.stopping = true; for (const controller of this.running.values()) controller.abort(); }
}
