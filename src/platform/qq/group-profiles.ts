import type { Store } from '../../storage/store.js';

/** 群资料独立缓存；人工备注不会被平台返回值覆盖。 */
export class QQGroupProfiles {
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: Store, private readonly fetchInfo: (id:string)=>Promise<unknown>) {}

  async refreshKnown(): Promise<void> {
    const groups=this.store.db.prepare("SELECT conversation_id FROM messages WHERE scope='group' GROUP BY conversation_id ORDER BY MIN(seq)").all() as Array<{conversation_id:string}>;
    for(const group of groups)await this.refresh(group.conversation_id);
  }

  async refresh(id:string): Promise<void> {
    if(this.inFlight.has(id))return;
    const saved=this.store.db.prepare('SELECT last_attempt_at,error FROM qq_group_profiles WHERE conversation_id=?').get(id) as {last_attempt_at:string;error:string|null}|undefined;
    const age=Date.now()-Date.parse(saved?.last_attempt_at ?? '');
    if(saved && Number.isFinite(age) && age>=0 && age<(saved.error ? 60*60*1000 : 6*60*60*1000))return;
    this.inFlight.add(id);
    const now=new Date().toISOString();
    try {
      const raw=await this.fetchInfo(id);
      if(!raw || typeof raw!=='object')throw new Error('群资料格式无效');
      const value=raw as Record<string,unknown>;
      const name=typeof value.group_name==='string'?value.group_name.trim().slice(0,200):'';
      if(!name)throw new Error('平台未返回群名');
      const info={description:typeof value.group_finger_memo==='string'?value.group_finger_memo.slice(0,2000):'',category:typeof value.group_class_text==='string'?value.group_class_text.slice(0,200):'',memberCount:typeof value.group_member_num==='number'&&Number.isFinite(value.group_member_num)?value.group_member_num:null};
      this.store.db.prepare(`INSERT INTO qq_group_profiles VALUES (?,?,?,?,?,NULL)
        ON CONFLICT(conversation_id) DO UPDATE SET name=excluded.name,info=excluded.info,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error=NULL`).run(id,name,JSON.stringify(info),now,now);
    } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      const code=message.match(/\b(11253|11254|401|403|404|429)\b/)?.[1];
      const safe=code?`群资料接口返回 ${code}`:'群资料获取失败';
      this.store.db.prepare(`INSERT INTO qq_group_profiles VALUES (?,'','{}',?,NULL,?)
        ON CONFLICT(conversation_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error=excluded.error`).run(id,now,safe);
    } finally {this.inFlight.delete(id);}
  }
}
