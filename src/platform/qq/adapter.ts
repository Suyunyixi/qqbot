import fs from 'node:fs';
import path from 'node:path';
import { QQBot, type QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { startQrConnect, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';
import { dataDir, readConfig } from '../../config/settings.js';
import { Harness } from '../../agent/harness.js';
import { Store } from '../../storage/store.js';
import type { DeliveryItem, InboundEvent, Sender, SendResult } from '../../domain/types.js';
import { qqVoiceBuffer } from './voice.js';
import { qqMentionMarkup } from './mentions.js';
import { QQGroupProfiles } from './group-profiles.js';
import { buildNativeArk } from '../../domain/card.js';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs/protocol';
import { GatewayConnection, dispatchEvent, type GatewayConnectionOptions, type InboundMessage, type PersistedSession } from '@tencent-connect/qqbot-nodejs/protocol';

const credentialsFile = path.join(dataDir, 'qq-credentials.json');
function makeKeyboard(payload:{buttons:Array<{label:string;data:string}>}) {
  return {content:{rows:[{buttons:payload.buttons.map((button,index)=>({id:`option-${index+1}`,render_data:{label:button.label,visited_label:button.label,style:1},action:{type:2,permission:{type:2},data:button.data}}))}]}};
}
export function savedCredentials(store: Store): QrConnectCredentials | undefined {
  if (process.env.QQBOT_APPID && process.env.QQBOT_SECRET) return { appId: process.env.QQBOT_APPID, appSecret: process.env.QQBOT_SECRET };
  const existing = store.qqCredentials();
  if (existing) return existing;
  if (!fs.existsSync(credentialsFile)) return undefined;
  const data = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')) as QrConnectCredentials;
  if (!data.appId || !data.appSecret) throw new Error('QQ 凭据文件不完整');
  store.saveQQCredentials(data);
  // Keep a recoverable backup, but stop treating it as an active binding.
  try { fs.renameSync(credentialsFile, `${credentialsFile}.migrated`); }
  catch { console.warn('旧 QQ 凭据已导入数据库，但备份文件未能改名'); }
  return data;
}
export function beginQr(store: Store, onUrl: (url: string) => void): Promise<QrConnectCredentials> {
  return new Promise((resolve, reject) => {
    startQrConnect({
      onQrDisplayed: onUrl,
      onSuccess: (credentials) => {
        const first = credentials[0]; if (!first?.appId || !first.appSecret) { reject(new Error('扫码未返回机器人凭据')); return; }
        try { store.saveQQCredentials(first); resolve(first); }
        catch (error) { reject(error); }
      },
      onFailure: reject,
    }, { source: 'qq-harness-bot', displayQrCodeToConsole: true });
  });
}

export class QQAdapter implements Sender {
  readonly bot: QQBot;
  connected = false;
  private abort?: AbortController;
  private inbound?: (message:InboundMessage,commit?:()=>void,onFailure?:(error:unknown)=>void)=>void;
  private interaction?: (event:InteractionEvent,commit?:()=>void,onFailure?:(error:unknown)=>void)=>void;
  private stopped=false;
  private readonly groupProfiles: QQGroupProfiles;
  constructor(private readonly credentials: QrConnectCredentials, private readonly store: Store, private readonly onState: (connected: boolean) => void, private readonly gatewayFactory:(options:GatewayConnectionOptions)=>{start():Promise<void>}=(options)=>new GatewayConnection(options),private readonly cursorRetryMs=3000) {
    // SDK debug output contains complete inbound events and outgoing messages.
    // Keep operational errors without duplicating private chats or tokens in Docker logs.
    this.bot = new QQBot({ appId: credentials.appId, appSecret: credentials.appSecret, logger: { info: console.info, warn: console.warn, error: console.error } });
    this.groupProfiles = new QQGroupProfiles(store, (id)=>this.bot.api.get(`/v2/groups/${encodeURIComponent(id)}/info`));
    this.bot.on('ready', () => { this.connected = true; this.onState(true); console.log('QQ 已连接'); });
    this.bot.on('resumed', () => { this.connected = true; this.onState(true); });
    this.bot.on('disconnected', () => { this.connected = false; this.onState(false); });
    this.bot.on('error', (error) => console.error('QQ 连接错误：', error.message));
  }
  listen(harness: Harness): void {
    this.inbound = (msg: InboundMessage,commit?:()=>void,onFailure?:(error:unknown)=>void) => {
      const rawAuthor=(msg.raw as {author?:{bot?:boolean}} | undefined)?.author;
      if (msg.senderIsBot || rawAuthor?.bot) {try {commit?.();}catch(error){onFailure?.(error);}return;}
      const scope = msg.kind;
      const conversationId = scope === 'group' ? msg.groupOpenid : scope==='guild' ? msg.channelId : scope==='dm' ? msg.guildId : msg.senderId;
      if (!conversationId || !msg.messageId || !msg.senderId) {try {this.store.db.transaction(()=>{this.store.recordPlatformEvent('UNRECOGNIZED_MESSAGE',msg.raw ?? msg);commit?.();})();}catch(error){onFailure?.(error);}return;}
      const content = msg.content ?? '';
      const isMention = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || msg.rawEventType==='AT_MESSAGE_CREATE' || Boolean(msg.mentions?.some((m) => m.is_you === true)) || content.includes(`<@!${this.bot.appId}>`) || content.includes(`<@${this.bot.appId}>`);
      const event: InboundEvent = { id: msg.messageId, conversationId, scope, senderId: msg.senderId, senderName: msg.senderName, content, timestamp: msg.timestamp || new Date().toISOString(), isMention, attachments: msg.attachments ?? [], raw: msg };
      let committed=false;
      const received=commit?harness.receive(event,()=>{commit();committed=true;},onFailure):harness.receive(event);
      void received.catch((err: unknown) => {if(!committed)onFailure?.(err);console.error('接收消息失败：', err instanceof Error ? err.message : err);});
      if(scope==='group' && this.connected)void this.groupProfiles.refresh(conversationId).catch(()=>console.error('群资料缓存更新失败'));
    };
    this.bot.on('message', (_ctx, msg: QQBotInboundMessage) => this.inbound?.(msg));
    this.interaction = (event:InteractionEvent,commit?:()=>void,onFailure?:(error:unknown)=>void) => {
      void this.bot.acknowledgeInteraction(event.id,0).catch((error:unknown)=>console.error('按钮确认失败：',error instanceof Error?error.message:String(error)));
      const scope=event.group_openid?'group':event.channel_id?'guild':event.guild_id?'dm':'c2c';
      const conversationId=event.group_openid ?? event.channel_id ?? event.guild_id ?? event.user_openid;
      const senderId=scope==='group'?event.group_member_openid:scope==='c2c'?event.user_openid:event.data?.resolved?.user_id;
      if(!conversationId || !senderId || !event.id){try {commit?.();}catch(error){onFailure?.(error);}return;}
      const data=event.data?.resolved?.button_data ?? event.data?.resolved?.button_id ?? '';
      const incoming:InboundEvent={id:`interaction:${event.id}`,conversationId,scope,senderId,content:`用户点击了按钮：${data.slice(0,1000)}`,timestamp:new Date().toISOString(),isMention:true,attachments:[],raw:{rawEventType:'INTERACTION_CREATE',event}};
      let committed=false;
      const received=commit?harness.receive(incoming,()=>{commit();committed=true;},onFailure):harness.receive(incoming);
      void received.catch((error:unknown)=>{if(!committed)onFailure?.(error);console.error('接收按钮事件失败：',error instanceof Error?error.message:String(error));});
    };
    this.bot.on('interaction', (_ctx, event) => this.interaction?.(event));
  }
  async start(): Promise<void> {
    const appId=this.credentials.appId,clientSecret=this.credentials.appSecret;const creds={appId,clientSecret};
    this.stopped=false;
    while(!this.stopped) {
    const abort=new AbortController();this.abort=abort;
    const rawIntents=process.env.QQ_INTENTS;
    if(rawIntents && (!/^\d+$/.test(rawIntents) || !Number.isSafeInteger(Number(rawIntents)))) throw new Error('QQ_INTENTS 必须是非负整数');
    await this.bot.tokenManager.getAccessToken(appId,clientSecret);
    this.bot.tokenManager.startBackgroundRefresh(appId,clientSecret);
    let pendingSession:PersistedSession|undefined;let cursorBlocked=false;
    const commit=(session:PersistedSession|undefined)=>{if(session && !cursorBlocked)this.store.setAppSetting('qq_gateway_session',JSON.stringify(session));};
    const failed=(error:unknown)=>{if(cursorBlocked)return;cursorBlocked=true;console.error('QQ 事件入库失败，将从已提交序号重新连接：',error instanceof Error?error.message:String(error));abort.abort();};
    const current=()=>pendingSession?{...pendingSession}:undefined;
    const gateway=this.gatewayFactory({account:{accountId:appId,appId,clientSecret},abortSignal:abort.signal,...(rawIntents?{intents:Number(rawIntents)}:{}),
      getAccessToken:()=>this.bot.tokenManager.getAccessToken(appId,clientSecret),clearTokenCache:()=>this.bot.tokenManager.clearCache(appId),getGatewayUrl:()=>this.bot.messageApi.getGatewayUrl(creds),
      session:{load:()=>{try {const value=JSON.parse(this.store.getAppSetting('qq_gateway_session') ?? 'null');return value && typeof value.sessionId==='string'?value:null;}catch{return null;}},save:(value)=>{pendingSession={...value};},clear:()=>{pendingSession=undefined;try{this.store.setAppSetting('qq_gateway_session','null');}catch(error){failed(error);}}},
      onReady:()=>{try{commit(current());}catch(error){failed(error);}if(cursorBlocked)return;this.connected=true;this.onState(true);console.log('QQ 已连接（新会话）');void this.groupProfiles.refreshKnown().catch(()=>console.error('群资料缓存更新失败'));},
      onResumed:()=>{try{commit(current());}catch(error){failed(error);}if(cursorBlocked)return;this.connected=true;this.onState(true);console.log('QQ 已恢复原会话');void this.groupProfiles.refreshKnown().catch(()=>console.error('群资料缓存更新失败'));},
      onDisconnected:()=>{this.connected=false;this.onState(false);},onError:(error)=>console.error('QQ 连接错误：',error.message),
      onMessage:(msg)=>{const session=current();if(this.inbound)this.inbound(msg,()=>commit(session),failed);else try{commit(session);}catch(error){failed(error);}},
      onInteraction:(event)=>{const session=current();if(this.interaction)this.interaction(event,()=>commit(session),failed);else try{commit(session);}catch(error){failed(error);}},
      onRawEvent:(type,data)=>{const session=current();try{
        if(type==='MESSAGE_CREATE') {const parsed=dispatchEvent('AT_MESSAGE_CREATE',data,appId);if(parsed.action==='message' && this.inbound){this.inbound({...parsed.msg,rawEventType:type},()=>commit(session),failed);return;}}
        this.store.db.transaction(()=>{this.store.recordPlatformEvent(type,data);commit(session);})();
      }catch(error){failed(error);console.error('QQ 事件保存失败：',error instanceof Error?error.message:String(error))}},
    });
    try { await gateway.start(); } finally {this.bot.tokenManager.stopBackgroundRefresh(appId);this.connected=false;this.onState(false);}
    if(!cursorBlocked || this.stopped)return;
    await new Promise<void>((resolve)=>setTimeout(resolve,this.cursorRetryMs));
    }
  }
  stop(): void { this.stopped=true;this.abort?.abort();this.bot.stop(); }
  async qqApi(method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',path:string,body?:unknown):Promise<unknown> {
    if (!this.connected) throw new Error('QQ 尚未连接');
    if (!/^\/(?!\/)[A-Za-z0-9@._~/%?&=+,-]+$/.test(path) || path.includes('..') || /%2f|%5c/i.test(path)) throw new Error('只能调用 QQ 官方 API 相对路径');
    if(method==='GET') return this.bot.api.get(path);
    if(method==='POST') return this.bot.api.post(path,body);
    if(method==='PUT') return this.bot.api.put(path,body);
    if(method==='PATCH') return this.bot.api.patch(path,body);
    return this.bot.api.delete(path);
  }
  async send(item: DeliveryItem): Promise<SendResult> {
    if (!this.connected) throw new Error('QQ 尚未连接');
    const ttl = item.scope === 'c2c' ? 1800000 : 300000;
    const candidates = this.store.db.prepare("SELECT id,timestamp FROM messages WHERE conversation_id=? AND direction='in' ORDER BY seq DESC LIMIT 30").all(item.conversationId) as Array<{ id: string; timestamp: string }>;
    candidates.sort((a, b) => Number(b.id === item.replyTo) - Number(a.id === item.replyTo));
    const candidate = candidates.find((row) => {
      if (row.id.startsWith('interaction:') && !['text','card','keyboard','embed'].includes(item.kind)) return false;
      const time = Date.parse(row.timestamp); if (!Number.isFinite(time) || Date.now() - time > ttl || Date.now() < time - 60000) return false;
      const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE conversation_id=? AND reply_to=? AND status IN ('sent','unknown')").get(item.conversationId, row.id) as { n: number };
      return count.n < 4;
    });
    if (!candidate && !readConfig().delivery.proactive) throw new Error('没有可用的 QQ 回复目标，主动发送已关闭');
    const eventId=candidate?.id.startsWith('interaction:') ? candidate.id.slice('interaction:'.length) : undefined;
    const eventSeq=eventId ? 1 + (this.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE conversation_id=? AND reply_to=? AND status IN ('sent','unknown')").get(item.conversationId,candidate!.id) as {n:number}).n : undefined;
    const eventExtra=eventId?{event_id:eventId,msg_seq:eventSeq}:undefined;
    this.store.setOutboxTarget(item.id, candidate?.id);
    if(item.scope==='guild' || item.scope==='dm') {
      const creds={appId:this.credentials.appId,clientSecret:this.credentials.appSecret};
      const common={...(eventId?{event_id:eventId}:candidate?{msg_id:candidate.id}:{})};
      if(item.kind==='image') {
        const token=await this.bot.tokenManager.getAccessToken(creds.appId,creds.clientSecret);
        const form=new FormData();if(eventId)form.set('event_id',eventId);else if(candidate)form.set('msg_id',candidate.id);
        form.set('file_image',new Blob([new Uint8Array(fs.readFileSync(item.content))]),item.fileName ?? path.basename(item.content));
        const endpoint=item.scope==='guild'?`/channels/${encodeURIComponent(item.conversationId)}/messages`:`/dms/${encodeURIComponent(item.conversationId)}/messages`;
        const response=await fetch(`https://api.sgroup.qq.com${endpoint}`,{method:'POST',headers:{Authorization:`QQBot ${token}`},body:form,signal:AbortSignal.timeout(120000)});
        if(!response.ok)throw new Error(`频道图片发送失败：HTTP ${response.status} ${(await response.text()).slice(0,300)}`);
        return await response.json() as SendResult;
      }
      let payload:Record<string,unknown>;
      if(item.kind==='text')payload={markdown:{content:item.scope==='guild'?qqMentionMarkup(item.content):item.content}};
      else if(item.kind==='card')payload={ark:buildNativeArk(JSON.parse(item.content))};
      else if(item.kind==='embed')payload={embed:JSON.parse(item.content)};
      else if(item.kind==='keyboard') {const input=JSON.parse(item.content) as {text:string;buttons:Array<{label:string;data:string}>};payload={markdown:{content:item.scope==='guild'?qqMentionMarkup(input.text):input.text},keyboard:makeKeyboard(input)};}
      else throw new Error('QQ 频道接口不提供此类本地文件上传，请改用图片或公开链接');
      return item.scope==='guild'?this.bot.messageApi.sendChannelMessageRaw(item.conversationId,creds,{...common,...payload}):this.bot.messageApi.sendDmMessageRaw(item.conversationId,creds,{...common,...payload});
    }
    const target = { scope: item.scope, targetId: item.conversationId, msgId: eventId ? undefined : candidate?.id };
    // 群聊和私聊均通过官方 Markdown 消息发送，群聊兼容旧版 @ 标记。
    if (item.kind === 'text') {
      const content=item.scope==='group'?qqMentionMarkup(item.content):item.content;
      return eventId ? this.bot.send({target,msgType:2,markdown:{content},extra:eventExtra}) : this.bot.sendMarkdown(target,content);
    }
    if (item.kind === 'card') return this.bot.send({ target, msgType: 3, content: ' ', ark: buildNativeArk(JSON.parse(item.content)), ...(eventId?{extra:eventExtra}:{}) });
    if (item.kind === 'keyboard') {
      const payload=JSON.parse(item.content) as {text:string;buttons:Array<{label:string;data:string}>};
      const keyboard=makeKeyboard(payload);
      return this.bot.send({target,msgType:2,markdown:{content:item.scope==='group'?qqMentionMarkup(payload.text):payload.text},keyboard,...(eventId?{extra:eventExtra}:{})});
    }
    if(item.kind==='embed')throw new Error('QQ Embed 仅支持频道和频道私信');
    const source = { localPath: item.content };
    const response = item.kind === 'image' ? await this.bot.sendImage(target, source) : item.kind === 'voice' ? await this.bot.sendVoice(target, { buffer: await qqVoiceBuffer(item.content) }) : item.kind === 'video' ? await this.bot.sendVideo(target, source) : await this.bot.sendFile(target, source, { fileName: item.fileName });
    if (!response.message) throw new Error('媒体上传完成，但没有取得 QQ 消息回执');
    return response.message;
  }
}
