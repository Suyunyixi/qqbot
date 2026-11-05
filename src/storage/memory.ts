import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isCommunityScope, type Scope } from '../domain/types.js';

export type SubjectType = 'user' | 'group';
export interface MemoryEntry { id: string; subject_type: SubjectType; subject_id: string; content: string; source_conversation_id: string; source_start: number | null; source_end: number | null; created_at: string; updated_at: string }
export interface IdentityAlias { scope: Scope; conversation_id: string; external_id: string; user_id: string; display_name: string | null }

/** User identities are separate from group facts; aliases can be linked explicitly. */
export class MemoryRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS identity_aliases (
        scope TEXT NOT NULL, conversation_id TEXT NOT NULL, external_id TEXT NOT NULL,
        user_id TEXT NOT NULL, display_name TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(scope, conversation_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS identity_user ON identity_aliases(user_id);
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
    // Repair earlier migrations that treated an unresolved person as a group.
    // The original legacy row is deliberately retained for future review.
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
      // An unresolved user ID must never be silently converted into a group fact.
      // Keep the original row in the legacy table for later review.
      if (row.subject_id && !person) continue;
      if (!person && !isCommunityScope(msg.scope)) continue;
      insert.run(row.id, person ? 'user' : 'group', person ?? row.conversation_id, row.content, row.conversation_id, row.source_start, row.source_end, row.created_at, row.created_at);
    }
    db.prepare("INSERT OR IGNORE INTO app_settings VALUES ('subject_memories_migrated','1',?)").run(new Date().toISOString());
  }
  observe(scope: Scope, conversationId: string, externalId: string, displayName?: string): string {
    const existing = this.lookup(scope, conversationId, externalId);
    // Identical QQ identifiers in the same namespace can share an identity;
    // group and C2C namespaces never merge without an explicit link.
    const id = existing ?? `user:${createHash('sha256').update(`${scope}\0${externalId}`).digest('hex').slice(0, 32)}`;
    this.db.prepare(`INSERT INTO identity_aliases VALUES (?,?,?,?,?,?) ON CONFLICT(scope,conversation_id,external_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,identity_aliases.display_name),updated_at=excluded.updated_at`).run(scope, conversationId, externalId, id, displayName ?? null, new Date().toISOString());
    return id;
  }
  lookup(scope: Scope, conversationId: string, externalId: string): string | undefined {
    return (this.db.prepare('SELECT user_id FROM identity_aliases WHERE scope=? AND conversation_id=? AND external_id=?').get(scope, conversationId, externalId) as { user_id: string } | undefined)?.user_id;
  }
  listIdentities(): IdentityAlias[] {
    return this.db.prepare('SELECT scope,conversation_id,external_id,user_id,display_name FROM identity_aliases ORDER BY updated_at DESC LIMIT 1000').all() as IdentityAlias[];
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
    return [...group, ...users].slice(0, 60);
  }
}
