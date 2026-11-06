import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCommunityScope, type Scope } from '../domain/types.js';

export type SubjectType = 'user' | 'group';
export interface MemoryEntry { id: string; subject_type: SubjectType; subject_id: string; content: string; source_conversation_id: string; source_start: number | null; source_end: number | null; created_at: string; updated_at: string }
export interface IdentityAlias { scope: Scope; conversation_id: string; external_id: string; user_id: string; display_name: string | null; remark_name?: string; alias_order?: number }
export type PlatformMemberRole = 'owner' | 'admin' | 'member';
export function platformRoleFromRaw(raw: unknown): PlatformMemberRole | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event=raw as {raw?:{author?:{member_role?:unknown}};author?:{member_role?:unknown}};
  const value=event.raw?.author?.member_role ?? event.author?.member_role;
  return value==='owner' || value==='admin' || value==='member' ? value : undefined;
}

/** 用户身份与群记忆分开，不同身份可由用户明确关联。 */
export class MemoryRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_aliases (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, external_id TEXT NOT NULL,
        user_id TEXT NOT NULL, display_name TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, conversation_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS identity_user ON identity_aliases(user_id);
      CREATE TABLE IF NOT EXISTS conversation_member_profiles (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, external_id TEXT NOT NULL,
        remark_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        PRIMARY KEY(scope,conversation_id,external_id)
      );
      CREATE TABLE IF NOT EXISTS conversation_member_platform_roles (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, external_id TEXT NOT NULL,
        platform_role TEXT NOT NULL, source_seq INTEGER NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(scope,conversation_id,external_id)
      );
      CREATE TABLE IF NOT EXISTS subject_memories (
        id TEXT PRIMARY KEY, subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
        subject_id TEXT NOT NULL, content TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
        source_start INTEGER, source_end INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subject_memories_subject ON subject_memories(subject_type,subject_id,updated_at);
      CREATE TABLE IF NOT EXISTS legacy_memory_actions (
        legacy_id TEXT PRIMARY KEY, action TEXT NOT NULL, resolved_memory_id TEXT, updated_at TEXT NOT NULL
      );
    `);
    const prior = db.prepare("SELECT DISTINCT scope,conversation_id,sender_id,sender_name FROM messages WHERE direction='in'").all() as Array<{scope: Scope; conversation_id: string; sender_id: string; sender_name: string | null}>;
    for (const row of prior) this.observe(row.scope, row.conversation_id, row.sender_id, row.sender_name ?? undefined);
    if (!db.prepare("SELECT 1 FROM app_settings WHERE key='member_platform_roles_migrated_v1'").get()) db.transaction(() => {
      const select=db.prepare("SELECT seq,scope,conversation_id,sender_id,raw,timestamp FROM messages WHERE direction='in' AND scope IN ('group','guild') AND raw IS NOT NULL AND seq>? ORDER BY seq LIMIT 100");
      let after=0;
      while (true) {
        const rows=select.all(after) as Array<{seq:number;scope:Scope;conversation_id:string;sender_id:string;raw:string;timestamp:string}>;
        if (!rows.length) break;
        for (const row of rows) { let raw:unknown;try { raw=JSON.parse(row.raw); } catch { continue; } this.observePlatformRole(row.scope,row.conversation_id,row.sender_id,raw,row.seq,row.timestamp); }
        after=rows[rows.length-1]!.seq;
      }
      db.prepare("INSERT INTO app_settings VALUES ('member_platform_roles_migrated_v1','1',?)").run(new Date().toISOString());
    })();
    // 修复旧版把未确认用户归为群记忆的问题，保留原记录供以后核对。
    db.prepare(`DELETE FROM subject_memories WHERE subject_type='group' AND id IN
      (SELECT id FROM memories WHERE subject_id IS NOT NULL AND subject_id <> '')`).run();
    const migrated = db.prepare("SELECT 1 FROM app_settings WHERE key='subject_memories_migrated'").get();
    if (migrated) return;
    const old = db.prepare('SELECT * FROM memories').all() as Array<{ id: string; conversation_id: string; subject_id: string | null; content: string; source_start: number | null; source_end: number | null; created_at: string }>;
    const insert = db.prepare('INSERT OR IGNORE INTO subject_memories VALUES (?,?,?,?,?,?,?,?,?)');
    for (const row of old) {
      const msg = db.prepare("SELECT scope FROM messages WHERE conversation_id=? AND direction='in' LIMIT 1").get(row.conversation_id) as { scope: Scope } | undefined;
      if (!msg) continue;
      const person = row.subject_id ? this.lookup(msg.scope, row.conversation_id, row.subject_id) : undefined;
      // 未确认的用户不能静默转成群记忆，保留旧记录供以后核对。
      if (row.subject_id && !person) continue;
      if (!person && !isCommunityScope(msg.scope)) continue;
      insert.run(row.id, person ? 'user' : 'group', person ?? row.conversation_id, row.content, row.conversation_id, row.source_start, row.source_end, row.created_at, row.created_at);
    }
    db.prepare("INSERT OR IGNORE INTO app_settings VALUES ('subject_memories_migrated','1',?)").run(new Date().toISOString());
  }
  observe(scope: Scope, conversationId: string, externalId: string, displayName?: string): string {
    const existing = this.lookup(scope, conversationId, externalId);
    // 同一命名空间的相同 QQ 标识可共享身份；群和私聊身份须明确关联。
    const id = existing ?? `user:${createHash('sha256').update(`${scope}\0${externalId}`).digest('hex').slice(0, 32)}`;
    this.db.prepare(`INSERT INTO identity_aliases VALUES (?,?,?,?,?,?) ON CONFLICT(scope,conversation_id,external_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,identity_aliases.display_name),updated_at=excluded.updated_at`).run(scope, conversationId, externalId, id, displayName ?? null, new Date().toISOString());
    return id;
  }
  lookup(scope: Scope, conversationId: string, externalId: string): string | undefined {
    return (this.db.prepare('SELECT user_id FROM identity_aliases WHERE scope=? AND conversation_id=? AND external_id=?').get(scope, conversationId, externalId) as { user_id: string } | undefined)?.user_id;
  }
  listIdentities(): IdentityAlias[] {
    return this.db.prepare(`SELECT a.scope,a.conversation_id,a.external_id,a.user_id,a.display_name,
      COALESCE(p.remark_name,'') AS remark_name,a.rowid AS alias_order FROM identity_aliases a
      LEFT JOIN conversation_member_profiles p ON p.scope=a.scope AND p.conversation_id=a.conversation_id AND p.external_id=a.external_id
      ORDER BY a.updated_at DESC LIMIT 1000`).all() as IdentityAlias[];
  }
  observePlatformRole(scope: Scope, conversationId: string, externalId: string, raw: unknown, seq: number, timestamp: string): void {
    if (!isCommunityScope(scope)) return;
    const role=platformRoleFromRaw(raw);if (!role) return;
    this.db.prepare(`INSERT INTO conversation_member_platform_roles VALUES (?,?,?,?,?,?) ON CONFLICT(scope,conversation_id,external_id) DO UPDATE SET platform_role=excluded.platform_role,source_seq=excluded.source_seq,observed_at=excluded.observed_at WHERE excluded.source_seq>conversation_member_platform_roles.source_seq`).run(scope,conversationId,externalId,role,seq,timestamp);
  }
  listConversationMembers(scope: Scope, conversationId: string): ConversationMember[] {
    return this.db.prepare(`SELECT a.scope,a.conversation_id,a.external_id,a.user_id,a.display_name,
      COALESCE(p.remark_name,'') AS remark_name,COALESCE(p.note,'') AS note,
      COUNT(m.seq) AS message_count,MIN(m.timestamp) AS first_message,MAX(m.timestamp) AS last_message,r.platform_role,r.observed_at AS platform_role_at,
      CASE WHEN a.user_id=? THEN 'owner' ELSE 'ordinary' END AS bot_role
      FROM identity_aliases a LEFT JOIN conversation_member_profiles p ON p.scope=a.scope AND p.conversation_id=a.conversation_id AND p.external_id=a.external_id
      LEFT JOIN conversation_member_platform_roles r ON r.scope=a.scope AND r.conversation_id=a.conversation_id AND r.external_id=a.external_id
      LEFT JOIN messages m ON m.scope=a.scope AND m.conversation_id=a.conversation_id AND m.sender_id=a.external_id AND m.direction='in'
      WHERE a.scope=? AND a.conversation_id=? GROUP BY a.scope,a.conversation_id,a.external_id ORDER BY last_message DESC,a.external_id`).all(this.owner() ?? '',scope,conversationId) as ConversationMember[];
  }
  saveConversationMember(scope: Scope, conversationId: string, externalId: string, remarkName: string, note: string, create = false): void {
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM messages WHERE scope=? AND conversation_id=? LIMIT 1").get(scope,conversationId)) throw new Error('会话不存在');
      if (!this.lookup(scope,conversationId,externalId)) {
        if (!create) throw new Error('会话成员不存在');
        this.observe(scope,conversationId,externalId);
      }
      this.db.prepare(`INSERT INTO conversation_member_profiles VALUES (?,?,?,?,?,?) ON CONFLICT(scope,conversation_id,external_id) DO UPDATE SET remark_name=excluded.remark_name,note=excluded.note,updated_at=excluded.updated_at`).run(scope,conversationId,externalId,remarkName,note,new Date().toISOString());
    })();
  }
  link(source: string, target: string): void {
    if (source === target) throw new Error('请选择两个不同的用户身份');
    this.db.transaction(() => {
      const find = this.db.prepare('SELECT 1 FROM identity_aliases WHERE user_id=? LIMIT 1');
      if (!find.get(source) || !find.get(target)) throw new Error('用户身份不存在');
      this.db.prepare('UPDATE identity_aliases SET user_id=?,updated_at=? WHERE user_id=?').run(target, new Date().toISOString(), source);
      this.db.prepare("UPDATE subject_memories SET subject_id=?,updated_at=? WHERE subject_type='user' AND subject_id=?").run(target, new Date().toISOString(), source);
      this.db.prepare("UPDATE app_settings SET value=?,updated_at=? WHERE key='owner_user_id' AND value=?").run(target, new Date().toISOString(), source);
    })();
  }
  detach(scope: Scope, conversationId: string, externalId: string): string {
    const current = this.lookup(scope, conversationId, externalId);
    if (!current) throw new Error('用户身份不存在');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM identity_aliases WHERE user_id=?').get(current) as {n:number};
    if (count.n < 2) throw new Error('该身份没有关联其他账号');
    const newId = `user:${randomUUID()}`;
    this.db.prepare('UPDATE identity_aliases SET user_id=?,updated_at=? WHERE scope=? AND conversation_id=? AND external_id=?').run(newId, new Date().toISOString(), scope, conversationId, externalId);
    return newId;
  }
  bootstrapOwner(userOpenid?: string): void {
    if (!userOpenid || this.owner()) return;
    const userId = this.observe('c2c', userOpenid, userOpenid);
    this.db.prepare("INSERT OR IGNORE INTO app_settings VALUES ('owner_user_id',?,?)").run(userId, new Date().toISOString());
  }
  owner(): string | undefined {
    return (this.db.prepare("SELECT value FROM app_settings WHERE key='owner_user_id'").get() as {value: string} | undefined)?.value;
  }
  setOwner(userId: string): void {
    if (!this.db.prepare('SELECT 1 FROM identity_aliases WHERE user_id=? LIMIT 1').get(userId)) throw new Error('用户身份不存在');
    this.db.prepare("INSERT INTO app_settings VALUES ('owner_user_id',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(userId, new Date().toISOString());
  }
  isOwner(scope: Scope, conversationId: string, externalId: string): boolean {
    const user = this.lookup(scope, conversationId, externalId);
    return !!user && user === this.owner();
  }
  add(type: SubjectType, subject: string, content: string, conversationId: string, start?: number, end?: number): string {
    if (!content.trim() || content.length > 2000 || !subject) throw new Error('记忆内容无效');
    const existing = this.db.prepare('SELECT id FROM subject_memories WHERE subject_type=? AND subject_id=? AND content=?').get(type, subject, content) as {id:string} | undefined;
    if (existing) return existing.id;
    const id = randomUUID(); const now = new Date().toISOString();
    this.db.prepare('INSERT INTO subject_memories VALUES (?,?,?,?,?,?,?,?,?)').run(id, type, subject, content, conversationId, start ?? null, end ?? null, now, now);
    return id;
  }
  list(type?: SubjectType, subject?: string): MemoryEntry[] {
    return this.db.prepare('SELECT * FROM subject_memories WHERE (? IS NULL OR subject_type=?) AND (? IS NULL OR subject_id=?) ORDER BY updated_at DESC LIMIT 500').all(type ?? null,type ?? null,subject ?? null,subject ?? null) as MemoryEntry[];
  }
  unresolvedLegacy(): Array<{id:string;conversation_id:string;subject_id:string|null;content:string;created_at:string}> {
    return this.db.prepare(`SELECT m.id,m.conversation_id,m.subject_id,m.content,m.created_at FROM memories m
      LEFT JOIN subject_memories s ON s.id=m.id LEFT JOIN legacy_memory_actions a ON a.legacy_id=m.id
      WHERE s.id IS NULL AND a.legacy_id IS NULL ORDER BY m.created_at DESC LIMIT 500`).all() as Array<{id:string;conversation_id:string;subject_id:string|null;content:string;created_at:string}>;
  }
  resolveLegacy(legacyId:string, type:SubjectType, subjectId:string, content?:string): string {
    return this.db.transaction(() => {
      const row=this.unresolvedLegacy().find((entry)=>entry.id===legacyId);
      if (!row) throw new Error('待处理旧记忆不存在或已处理');
      if (type==='user' && !this.db.prepare('SELECT 1 FROM identity_aliases WHERE user_id=? LIMIT 1').get(subjectId)) throw new Error('用户身份不存在');
      if (type==='group' && !this.db.prepare("SELECT 1 FROM messages WHERE scope IN ('group','guild') AND conversation_id=? LIMIT 1").get(subjectId)) throw new Error('群聊或频道不存在');
      const created=this.add(type,subjectId,content ?? row.content,row.conversation_id);
      this.db.prepare('INSERT INTO legacy_memory_actions VALUES (?,?,?,?)').run(legacyId,'resolved',created,new Date().toISOString());
      return created;
    })();
  }
  edit(id: string, content: string): boolean {
    if (!content.trim() || content.length > 2000) throw new Error('记忆内容无效');
    return this.db.prepare('UPDATE subject_memories SET content=?,updated_at=? WHERE id=?').run(content, new Date().toISOString(), id).changes > 0;
  }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM subject_memories WHERE id=?').run(id).changes > 0; }
  context(scope: Scope, conversationId: string, participants: string[]): MemoryEntry[] {
    const people = [...new Set(participants.map((external) => this.lookup(scope, conversationId, external)).filter((x): x is string => !!x))];
    const group = isCommunityScope(scope) ? this.list('group', conversationId).slice(0, 20) : [];
    const users = people.slice(0, 20).flatMap((id) => this.list('user', id).slice(0, 8));
    return [...users, ...group].slice(0, 60);
  }
}
export interface ConversationMember extends IdentityAlias { remark_name: string; note: string; message_count: number; first_message: string | null; last_message: string | null; bot_role: 'owner' | 'ordinary'; platform_role: PlatformMemberRole | null; platform_role_at: string | null }
