import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store.js';
import type { ReplyRuntime } from '../delivery/reply.js';

const setting='model_balance_alert';
export const balanceAlertText='主人，我的饭饭吃光啦，呜呜……';
type State={id:string;status:'pending'|'sent'|'failed'|'unknown';lastAttempt:number};

export function isBalanceError(error: unknown): boolean {
  const message=error instanceof Error ? error.message : String(error);
  const status=typeof error==='object' && error!==null && 'status' in error ? Number(error.status) : undefined;
  return (status===402 || /\b402\b/.test(message)) && /insufficient.balance|insufficient.quota|余额不足|额度不足/i.test(message);
}

/** 余额故障按故障周期去重；不确定是否送达时不自动重发。 */
export class BalanceAlert {
  private sending=false;
  constructor(private readonly store:Store,private readonly reply:ReplyRuntime) {}
  private read():State|undefined {
    try { const value=JSON.parse(this.store.getAppSetting(setting) ?? 'null') as State|null;return value?.id && value.status ? value : undefined; } catch {return undefined;}
  }
  private write(state:State):void {this.store.setAppSetting(setting,JSON.stringify(state));}
  recovered():void {this.store.db.prepare('DELETE FROM app_settings WHERE key=?').run(setting);}
  notified():void {
    const state=this.read();
    this.write({id:state?.id ?? randomUUID(),status:'sent',lastAttempt:Date.now()});
  }
  async report(error:unknown):Promise<void> {
    if (!isBalanceError(error) || this.sending) return;
    let state=this.read();
    if (state?.status==='sent' || state?.status==='unknown' || (state?.status==='pending' && Date.now()-state.lastAttempt<900000) || (state?.status==='failed' && Date.now()-state.lastAttempt<900000)) return;
    if (state?.status==='pending') {
      const delivery=this.store.outboxState(`balance:${state.id}:0`);
      if (delivery==='sent') {this.write({...state,status:'sent'});return;}
      if (delivery==='sending' || delivery==='unknown') {this.write({...state,status:'unknown'});return;}
    }
    const owner=this.store.memory.owner();
    const aliases=owner ? this.store.memory.listIdentities().filter((item)=>item.user_id===owner) : [];
    const direct=aliases.find((item)=>item.scope==='c2c');
    const group=aliases.filter((item)=>item.scope==='group').sort((a,b)=>{
      const latest=(id:string)=>this.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE conversation_id=? AND direction='in'").get(id) as {seq:number};
      return latest(b.conversation_id).seq-latest(a.conversation_id).seq;
    })[0];
    const target=direct ?? group;
    if (!target) {console.warn('余额不足提醒未发送：没有绑定创建者的私聊或群身份');return;}
    state={id:state?.id ?? randomUUID(),status:'pending',lastAttempt:Date.now()};this.write(state);this.sending=true;
    try {
      const text=target.scope==='group' ? `<@${target.external_id}> ${balanceAlertText}` : balanceAlertText;
      await this.reply.send(target.conversation_id,target.scope,undefined,'text',text,undefined,`balance:${state.id}`);
      this.write({...state,status:'sent'});
    } catch (error) {
      const delivery=this.store.outboxState(`balance:${state.id}:0`);
      this.write({...state,status:delivery==='unknown' || delivery==='sending' ? 'unknown' : 'failed'});
      console.error('余额不足提醒发送失败：',error instanceof Error ? error.message : String(error));
    } finally {this.sending=false;}
  }
}
