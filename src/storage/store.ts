import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { sqlitePath } from '../config/settings.js';
import type { DeliveryItem, InboundEvent, Scope } from '../domain/types.js';
import { MemoryRepository } from './memory.js';
import { workspaceFor } from './workspace.js';

export class Store {
  readonly db: Database.Database;
  readonly memory: MemoryRepository;
  constructor(file = sqlitePath) {
    this.db = new Database(file);
    if (file !== ':memory:') {
      try { fs.chmodSync(file, 0o600); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') throw error;
        // Windows 或 SMB 挂载可能不支持 chmod；仍由宿主机控制权限并在启动时检查写入。
        console.warn('数据库挂载不支持 chmod；请通过宿主机权限保护数据目录。');
      }
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        scope TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT, content TEXT NOT NULL,
        timestamp TEXT NOT NULL, direction TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]',
        raw TEXT, is_mention INTEGER NOT NULL DEFAULT 0, UNIQUE(conversation_id, id)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_seq ON messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS message_attachments (
        conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, attachment_index INTEGER NOT NULL,
        source_hash TEXT NOT NULL, media_type TEXT NOT NULL, relative_path TEXT, status TEXT NOT NULL,
        error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(conversation_id,message_id,attachment_index)
      );
      CREATE INDEX IF NOT EXISTS message_attachments_source ON message_attachments(source_hash,status);
      CREATE TABLE IF NOT EXISTS execution_metrics (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, scope TEXT NOT NULL,
        task_id TEXT, phase TEXT NOT NULL, name TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_metrics_time ON execution_metrics(created_at);
      CREATE TABLE IF NOT EXISTS tool_discoveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, scope TEXT NOT NULL,
        task_id TEXT, query TEXT NOT NULL, candidates TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'search'
      );
      CREATE INDEX IF NOT EXISTS tool_discoveries_task ON tool_discoveries(task_id,seq);
      CREATE TABLE IF NOT EXISTS summaries (
        conversation_id TEXT PRIMARY KEY, summary TEXT NOT NULL, through_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, subject_id TEXT, content TEXT NOT NULL,
        source_start INTEGER, source_end INTEGER, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_settings (
        conversation_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(conversation_id, key)
      );
      CREATE TABLE IF NOT EXISTS conversation_profiles (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY(scope,conversation_id)
      );
      CREATE TABLE IF NOT EXISTS qq_group_profiles (
        conversation_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '{}',
        last_attempt_at TEXT NOT NULL, last_success_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS persona_revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source TEXT NOT NULL,
        actor_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qq_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1), app_id TEXT NOT NULL, app_secret TEXT NOT NULL,
        user_openid TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qq_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL,
        payload TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, scope TEXT NOT NULL, reply_to TEXT,
        instruction TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS task_updates (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, content TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS task_progress (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, content TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, scope TEXT NOT NULL, reply_to TEXT,
        kind TEXT NOT NULL, content TEXT NOT NULL, file_name TEXT, status TEXT NOT NULL,
        platform_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    this.db.prepare(`INSERT INTO persona_revisions(content,source,actor_id,created_at)
      SELECT value,'existing',NULL,updated_at FROM app_settings WHERE key='persona' AND NOT EXISTS (SELECT 1 FROM persona_revisions)`).run();
    const taskColumns=this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{name:string}>;
    if(!taskColumns.some((column)=>column.name==='actor_id'))this.db.exec('ALTER TABLE tasks ADD COLUMN actor_id TEXT');
    const discoveryColumns=this.db.prepare('PRAGMA table_info(tool_discoveries)').all() as Array<{name:string}>;
    if(!discoveryColumns.some((column)=>column.name==='kind'))this.db.exec("ALTER TABLE tool_discoveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'search'");
    this.memory = new MemoryRepository(this.db);
    this.memory.bootstrapOwner(this.qqCredentials()?.userOpenid);
  }
  qqCredentials(): { appId: string; appSecret: string; userOpenid?: string } | undefined {
    const row = this.db.prepare('SELECT app_id,app_secret,user_openid FROM qq_credentials WHERE id=1').get() as { app_id: string; app_secret: string; user_openid: string | null } | undefined;
    return row ? { appId: row.app_id, appSecret: row.app_secret, ...(row.user_openid ? { userOpenid: row.user_openid } : {}) } : undefined;
  }
  saveQQCredentials(value: { appId: string; appSecret: string; userOpenid?: string }): void {
    if (!value.appId || !value.appSecret) throw new Error('QQ 凭据不完整');
    this.db.prepare('INSERT INTO qq_credentials VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id,app_secret=excluded.app_secret,user_openid=excluded.user_openid,updated_at=excluded.updated_at').run(value.appId, value.appSecret, value.userOpenid ?? null, new Date().toISOString());
    this.memory.bootstrapOwner(value.userOpenid);
  }
  recordPlatformEvent(type:string,value:unknown):void {
    const payload=JSON.stringify(value ?? null);
    this.db.prepare('INSERT INTO qq_events(event_type,payload,received_at) VALUES (?,?,?)').run(type,payload,new Date().toISOString());
  }
  record(event: InboundEvent): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO messages (id,conversation_id,scope,sender_id,sender_name,content,timestamp,direction,attachments,raw,is_mention) VALUES (?,?,?,?,?,?,?,'in',?,?,?)`)
        .run(event.id, event.conversationId, event.scope, event.senderId, event.senderName ?? null, event.content, event.timestamp, JSON.stringify(event.attachments), event.raw === undefined ? null : JSON.stringify(event.raw), Number(event.isMention));
      const created = result.changes > 0;
      if (created) { this.memory.observe(event.scope, event.conversationId, event.senderId, event.senderName); this.memory.observePlatformRole(event.scope,event.conversationId,event.senderId,event.raw,Number(result.lastInsertRowid),event.timestamp); }
      return created;
    })();
  }
  recordSent(item: DeliveryItem, platformId?: string): void {
    let cardTitle = 'QQ 卡片';
    if (item.kind === 'card') {
      try { const value = JSON.parse(item.content) as { title?: unknown }; if (typeof value.title === 'string') cardTitle = value.title; } catch { /* Do not turn a successful send into a retry. */ }
    }
    const fileKind=['image','video','voice','file'].includes(item.kind);
    const extension=path.extname(item.content).toLowerCase();
    const mediaType=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.pdf':'application/pdf','.mp3':'audio/mpeg','.wav':'audio/wav'} as Record<string,string>)[extension] ?? 'application/octet-stream';
    const messageId=platformId ?? `sent:${item.id}`;
    this.db.transaction(()=>{
      const attachments=fileKind ? JSON.stringify([{filename:item.fileName ?? path.basename(item.content),content_type:mediaType}]) : '[]';
      this.db.prepare(`INSERT OR IGNORE INTO messages (id,conversation_id,scope,sender_id,sender_name,content,timestamp,direction,attachments) VALUES (?,?,?,?,?,?,?,'out',?)`)
        .run(messageId, item.conversationId, item.scope, 'bot', '机器人', item.kind === 'text' ? item.content : item.kind === 'card' ? `[card] ${cardTitle}` : item.kind === 'keyboard' ? '[keyboard] 交互按钮' : item.kind === 'embed' ? '[embed] 频道卡片' : `[${item.kind}] ${item.fileName ?? path.basename(item.content)}`, new Date().toISOString(), attachments);
      if(fileKind) {
        const relative=path.relative(workspaceFor(item.conversationId),item.content);
        if(relative && !relative.startsWith('..') && !path.isAbsolute(relative))this.db.prepare(`INSERT OR IGNORE INTO message_attachments(conversation_id,message_id,attachment_index,source_hash,media_type,relative_path,status,updated_at) VALUES(?,?,0,?,?,?,'saved',?)`).run(item.conversationId,messageId,`out:${item.id}`,mediaType,`workspace:${relative}`,new Date().toISOString());
      }
    })();
  }
  recent(conversationId: string, limit: number, through = Number.MAX_SAFE_INTEGER): MessageRow[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?').all(conversationId, through, limit) as MessageRow[]).reverse();
  }
  maxSeq(conversationId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n;
  }
  eventSeq(conversationId: string, id: string): number {
    return (this.db.prepare('SELECT seq FROM messages WHERE conversation_id=? AND id=?').get(conversationId, id) as { seq: number } | undefined)?.seq ?? this.maxSeq(conversationId);
  }
  memories(conversationId: string): Array<{ content: string; subject_id: string | null }> {
    return this.db.prepare('SELECT content,subject_id FROM memories WHERE conversation_id=? ORDER BY created_at DESC LIMIT 30').all(conversationId) as Array<{ content: string; subject_id: string | null }>;
  }
  addMemory(conversationId: string, content: string, subjectId: string | undefined, start: number, end: number): void {
    const duplicate = this.db.prepare('SELECT 1 FROM memories WHERE conversation_id=? AND content=?').get(conversationId, content);
    if (!duplicate) this.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?)').run(randomUUID(),conversationId,subjectId ?? null,content,start,end,new Date().toISOString());
  }
  getSetting(conversationId: string, key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM conversation_settings WHERE conversation_id=? AND key=?').get(conversationId, key) as { value: string } | undefined)?.value;
  }
  getAppSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setAppSetting(key: string, value: string): void {
    if (key === 'persona') { this.setPersona(value, 'system'); return; }
    this.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, new Date().toISOString());
  }
  setPersona(value: string, source: 'system' | 'admin', actorId?: string): boolean {
    if (source !== 'system' && source !== 'admin') throw new Error('主人格只能通过本机管理页面修改');
    return this.db.transaction(() => {
      if (this.getAppSetting('persona') === value) return false;
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run('persona',value,now);
      this.db.prepare('INSERT INTO persona_revisions(content,source,actor_id,created_at) VALUES (?,?,?,?)').run(value,source,actorId ?? null,now);
      return true;
    })();
  }
  personaRevisions(): Array<{seq:number;source:string;actor_id:string|null;created_at:string}> {
    return this.db.prepare('SELECT seq,source,actor_id,created_at FROM persona_revisions ORDER BY seq DESC LIMIT 50').all() as Array<{seq:number;source:string;actor_id:string|null;created_at:string}>;
  }
  setSetting(conversationId: string, key: string, value: string): void {
    this.db.prepare('INSERT INTO conversation_settings VALUES (?,?,?) ON CONFLICT(conversation_id,key) DO UPDATE SET value=excluded.value').run(conversationId, key, value);
  }
  search(conversationId: string, query: string, limit = 20): MessageRow[] {
    const q = query.replace(/[%_\\]/g, '\\$&');
    return this.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND content LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT ?").all(conversationId, `%${q}%`, limit) as MessageRow[];
  }
  summary(conversationId: string): { summary: string; through_seq: number } | undefined {
    return this.db.prepare('SELECT summary,through_seq FROM summaries WHERE conversation_id=?').get(conversationId) as { summary: string; through_seq: number } | undefined;
  }
  setSummary(conversationId: string, summary: string, through: number): void {
    this.db.prepare('INSERT INTO summaries VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,through_seq=excluded.through_seq,updated_at=excluded.updated_at WHERE excluded.through_seq > summaries.through_seq').run(conversationId, summary, through, new Date().toISOString());
  }
  addTask(conversationId: string, scope: Scope, replyTo: string | undefined, instruction: string, actorId?:string): string {
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO tasks(id,conversation_id,scope,reply_to,instruction,status,created_at,updated_at,actor_id) VALUES (?,?,?,?,?,'queued',?,?,?)").run(id, conversationId, scope, replyTo ?? null, instruction, now, now,actorId ?? null);
    return id;
  }
  task(id: string): TaskRow | undefined { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | undefined; }
  queuedTasks(): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at").all() as TaskRow[]; }
  pendingNotifications(): TaskRow[] { return this.db.prepare("SELECT * FROM tasks WHERE status IN ('waiting','completed','failed','interrupted') AND notified=0 ORDER BY updated_at").all() as TaskRow[]; }
  listTasks(conversationId: string): TaskRow[] { return this.db.prepare('SELECT * FROM tasks WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20').all(conversationId) as TaskRow[]; }
  addTaskUpdate(id: string, content: string): void { this.db.prepare('INSERT INTO task_updates(task_id,content) VALUES (?,?)').run(id, content); }
  setTaskInstruction(id:string,instruction:string):void { this.db.prepare('UPDATE tasks SET instruction=?,updated_at=? WHERE id=?').run(instruction,new Date().toISOString(),id); }
  addProgress(taskId: string, content: string): string { const id = randomUUID(); this.db.prepare('INSERT INTO task_progress(id,task_id,content,created_at) VALUES (?,?,?,?)').run(id, taskId, content, new Date().toISOString()); return id; }
  logTask(taskId: string, content: string): void { this.db.prepare('INSERT INTO task_progress(id,task_id,content,sent,created_at) VALUES (?,?,?,1,?)').run(randomUUID(), taskId, content.slice(0, 1000), new Date().toISOString()); }
  pendingProgress(): Array<{ id: string; task_id: string; content: string }> { return this.db.prepare("SELECT p.id,p.task_id,p.content FROM task_progress p JOIN tasks t ON t.id=p.task_id WHERE p.sent=0 AND t.status IN ('running','waiting') ORDER BY p.created_at").all() as Array<{ id: string; task_id: string; content: string }>; }
  markProgress(id: string): void { this.db.prepare('UPDATE task_progress SET sent=1 WHERE id=?').run(id); }
  takeTaskUpdates(id: string): string[] {
    return this.db.transaction(() => { const rows = this.db.prepare('SELECT content FROM task_updates WHERE task_id=? ORDER BY seq').all(id) as Array<{ content: string }>; this.db.prepare('DELETE FROM task_updates WHERE task_id=?').run(id); return rows.map((row) => row.content); })();
  }
  prepareTaskContinuation(id:string,original:string,result:string):string | undefined {
    return this.db.transaction(()=>{
      const rows=this.db.prepare('SELECT content FROM task_updates WHERE task_id=? ORDER BY seq').all(id) as Array<{content:string}>;
      if(!rows.length)return undefined;
      const next=`原任务：${original}\n此前执行结果：${result}\n用户追加要求：${rows.map((row)=>row.content).join('\n')}`;
      this.setTaskInstruction(id,next);
      this.db.prepare('DELETE FROM task_updates WHERE task_id=?').run(id);
      return next;
    })();
  }
  setTask(id: string, status: string, result?: string, error?: string): void { this.db.prepare("UPDATE tasks SET status=?,result=?,error=?,updated_at=?,notified=CASE WHEN ? IN ('waiting','completed','failed','interrupted') THEN 0 ELSE notified END WHERE id=?").run(status, result ?? null, error ?? null, new Date().toISOString(), status, id); }
  markNotified(id: string, status: string): void { this.db.prepare('UPDATE tasks SET notified=1 WHERE id=? AND status=?').run(id, status); }
  interruptRunning(): void { this.db.prepare("UPDATE tasks SET status='interrupted',error='程序重启中断了任务；可重新发起',updated_at=?,notified=0 WHERE status IN ('running','waiting')").run(new Date().toISOString()); }
  recoverTasks(): void {
    this.db.prepare("UPDATE tasks SET status='queued',error=NULL,updated_at=?,notified=0 WHERE status IN ('running','waiting') OR (status='interrupted' AND error='服务退出，等待自动恢复')").run(new Date().toISOString());
  }
  addOutbox(item: DeliveryItem): void { const now = new Date().toISOString(); this.db.prepare("INSERT INTO outbox VALUES (?,?,?,?,?,?,?,'queued',NULL,NULL,?,?)").run(item.id,item.conversationId,item.scope,item.replyTo ?? null,item.kind,item.content,item.fileName ?? null,now,now); }
  outboxState(id: string): string | undefined { return (this.db.prepare('SELECT status FROM outbox WHERE id=?').get(id) as { status: string } | undefined)?.status; }
  pendingOutbox(conversationId: string): Array<{ id: string; scope: Scope; reply_to: string | null; kind: DeliveryItem['kind']; content: string; file_name: string | null; status: string; error: string | null }> {
    return this.db.prepare("SELECT id,scope,reply_to,kind,content,file_name,status,error FROM outbox WHERE conversation_id=? AND status IN ('failed','unknown','queued') ORDER BY created_at DESC LIMIT 20").all(conversationId) as Array<{ id: string; scope: Scope; reply_to: string | null; kind: DeliveryItem['kind']; content: string; file_name: string | null; status: string; error: string | null }>;
  }
  setOutboxTarget(id: string, replyTo: string | undefined): void { this.db.prepare('UPDATE outbox SET reply_to=? WHERE id=?').run(replyTo ?? null, id); }
  setOutbox(id: string, status: string, platformId?: string, error?: string): void { this.db.prepare('UPDATE outbox SET status=?,platform_id=?,error=?,updated_at=? WHERE id=?').run(status, platformId ?? null, error ?? null, new Date().toISOString(), id); }
  recoverSending(): void { this.db.prepare("UPDATE outbox SET status='unknown',error='发送中断，结果未知，未自动重发' WHERE status='sending'").run(); }
  close(): void { this.db.close(); }
}
export interface MessageRow { seq: number; id: string; sender_id: string; sender_name: string | null; content: string; timestamp: string; direction: string; attachments: string }
export interface TaskRow { id: string; conversation_id: string; scope: Scope; reply_to: string | null; instruction: string; status: string; result: string | null; error: string | null; notified: number; actor_id?:string|null }
