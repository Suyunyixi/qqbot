import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from '../config/settings.js';
import type { InboundEvent } from '../domain/types.js';
import { qqAttachmentResponse, qqImageDataUrl } from '../platform/qq/attachments.js';
import type { Store } from './store.js';
import { resolveWorkspaceFile } from './workspace.js';
import { quotedAttachmentArchiveId, quotedMessageAttachments } from '../agent/quoted-message.js';

type ImageAttachment={url:string;content_type:string};
const sourceHash=(url:string)=>createHash('sha256').update(url).digest('hex');

/** 消息原文不变；附件异步归档到数据映射目录，查看或理解时才读取。 */
export class AttachmentArchive {
  private readonly pending=new Map<string,Promise<void>>();
  private active=0;
  private readonly queue:Array<()=>void>=[];
  constructor(private readonly store:Store,private readonly root=path.join(dataDir,'attachments','qq')) {}
  resumePending():void {
    const rows=this.store.db.prepare(`SELECT DISTINCT m.conversation_id,m.id,m.attachments FROM message_attachments a
      JOIN messages m ON m.conversation_id=a.conversation_id AND m.id=a.message_id
      WHERE a.status='pending' ORDER BY m.seq LIMIT 200`).all() as Array<{conversation_id:string;id:string;attachments:string}>;
    for(const row of rows) {
      try {this.enqueue({conversationId:row.conversation_id,id:row.id,attachments:JSON.parse(row.attachments)} as InboundEvent);} catch { /* 旧记录格式错误时保留原记录。 */ }
    }
    const quotes=this.store.db.prepare(`SELECT DISTINCT m.conversation_id,m.id,m.raw FROM message_attachments a
      JOIN messages m ON m.conversation_id=a.conversation_id AND a.message_id='qqbot-quote:' || m.id
      WHERE a.status='pending' ORDER BY m.seq LIMIT 200`).all() as Array<{conversation_id:string;id:string;raw:string}>;
    for(const row of quotes)this.enqueue({conversationId:row.conversation_id,id:quotedAttachmentArchiveId(row.id),attachments:quotedMessageAttachments(row.raw)} as InboundEvent);
  }
  backfillExisting(limit=200):void {
    const rows=this.store.db.prepare(`SELECT m.conversation_id,m.id,m.attachments FROM messages m
      WHERE m.direction='in' AND m.attachments<>'[]' AND NOT EXISTS
      (SELECT 1 FROM message_attachments a WHERE a.conversation_id=m.conversation_id AND a.message_id=m.id)
      ORDER BY m.seq DESC LIMIT ?`).all(limit) as Array<{conversation_id:string;id:string;attachments:string}>;
    for(const row of rows) {
      try {this.enqueue({conversationId:row.conversation_id,id:row.id,attachments:JSON.parse(row.attachments)} as InboundEvent);} catch { /* 历史数据格式异常时不修改原文。 */ }
    }
    const quotes=this.store.db.prepare(`SELECT m.conversation_id,m.id,m.raw FROM messages m
      WHERE m.direction='in' AND CASE WHEN json_valid(m.raw) THEN
        (json_extract(m.raw,'$.msgType')=103 OR json_extract(m.raw,'$.raw.message_type')=103 OR json_extract(m.raw,'$.refMsgIdx') IS NOT NULL OR json_extract(m.raw,'$.raw.ref_msg_idx') IS NOT NULL) ELSE 0 END
      AND NOT EXISTS (SELECT 1 FROM message_attachments a WHERE a.conversation_id=m.conversation_id AND a.message_id='qqbot-quote:' || m.id)
      ORDER BY m.seq DESC LIMIT ?`).all(limit) as Array<{conversation_id:string;id:string;raw:string}>;
    for(const row of quotes)this.enqueue({conversationId:row.conversation_id,id:quotedAttachmentArchiveId(row.id),attachments:quotedMessageAttachments(row.raw)} as InboundEvent);
  }
  retry(conversationId:string,messageId:string,index:number):void {
    const row=this.store.db.prepare('SELECT attachments FROM messages WHERE conversation_id=? AND id=?').get(conversationId,messageId) as {attachments:string}|undefined;
    if(!row)throw new Error('找不到消息');
    const attachments=JSON.parse(row.attachments) as unknown[];
    const value=attachments[index] as {url?:unknown}|undefined;
    if(!value || typeof value.url!=='string')throw new Error('附件没有可重试的原始地址');
    const state=this.store.db.prepare('SELECT status FROM message_attachments WHERE conversation_id=? AND message_id=? AND attachment_index=?').get(conversationId,messageId,index) as {status:string}|undefined;
    if(state?.status==='saved' || state?.status==='pending')throw new Error(state.status==='saved'?'附件已经保存':'附件正在保存');
    this.store.db.prepare("UPDATE message_attachments SET status='pending',error=NULL,updated_at=? WHERE conversation_id=? AND message_id=? AND attachment_index=?").run(new Date().toISOString(),conversationId,messageId,index);
    const selected:unknown[]=[];selected[index]=value;
    this.enqueue({conversationId,id:messageId,attachments:selected} as InboundEvent);
  }
  enqueue(event:InboundEvent):void {
    for (const [index,value] of event.attachments.entries()) {
      if (!value || typeof value!=='object') continue;
      const item=value as Partial<ImageAttachment>;
      if (typeof item.url!=='string') continue;
      const attachment={url:item.url,content_type:item.content_type ?? 'application/octet-stream'};
      const hash=sourceHash(attachment.url);
      this.store.db.prepare(`INSERT OR IGNORE INTO message_attachments(conversation_id,message_id,attachment_index,source_hash,media_type,status,updated_at) VALUES(?,?,?,?,?,'pending',?)`).run(event.conversationId,event.id,index,hash,attachment.content_type,new Date().toISOString());
      const saved=this.store.db.prepare("SELECT relative_path,media_type FROM message_attachments WHERE source_hash=? AND status='saved' LIMIT 1").get(hash) as {relative_path:string;media_type:string}|undefined;
      if(saved && /^[a-f0-9]{64}$/.test(saved.relative_path) && fs.existsSync(path.join(this.root,saved.relative_path))) {
        this.store.db.prepare("UPDATE message_attachments SET relative_path=?,media_type=?,status='saved',updated_at=? WHERE conversation_id=? AND message_id=? AND attachment_index=?").run(saved.relative_path,saved.media_type,new Date().toISOString(),event.conversationId,event.id,index);
        continue;
      }
      if(this.queue.length>=256) {
        this.store.db.prepare("UPDATE message_attachments SET status='failed',error='附件保存队列已满',updated_at=? WHERE conversation_id=? AND message_id=? AND attachment_index=?").run(new Date().toISOString(),event.conversationId,event.id,index);
        continue;
      }
      const promise=this.schedule(attachment,hash);
      void promise.catch(()=>{});
    }
  }
  private schedule(item:ImageAttachment,hash:string):Promise<void> {
    const existing=this.pending.get(hash);if(existing)return existing;
    const promise=new Promise<void>((resolve)=>{
      this.queue.push(()=>void this.save(item,hash).finally(resolve));this.pump();
    }).finally(()=>this.pending.delete(hash));
    this.pending.set(hash,promise);return promise;
  }
  private pump():void {
    while(this.active<2 && this.queue.length) {
      const work=this.queue.shift()!;this.active++;work();
    }
  }
  private async save(item:ImageAttachment,hash:string):Promise<void> {
    let temporary:string|undefined;
    try {
      const limitMb=Number(process.env.BOT_ATTACHMENT_MAX_MB ?? 1024);
      if(!Number.isFinite(limitMb) || limitMb<=0)throw new Error('附件大小限制配置无效');
      const limit=Math.floor(limitMb*1024*1024);
      const response=await qqAttachmentResponse(item,300000);
      const reported=(response.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase();
      const mediaType=reported && reported!=='application/octet-stream' ? reported : item.content_type.split(';')[0]!.toLowerCase();
      if(Number(response.headers.get('content-length') ?? 0)>limit)throw new Error(`附件超过配置的 ${limitMb} MB 限制`);
      fs.mkdirSync(this.root,{recursive:true});
      temporary=path.join(this.root,`.download-${randomUUID()}`);const handle=fs.openSync(temporary,'wx',0o600);
      const digestState=createHash('sha256');let size=0;
      try {
        const reader=response.body!.getReader();
        for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error(`附件超过配置的 ${limitMb} MB 限制`);}digestState.update(value);let offset=0;while(offset<value.length){const written=fs.writeSync(handle,value,offset,value.length-offset);if(written<=0)throw new Error('附件写入失败');offset+=written;}}
      } finally {fs.closeSync(handle);}
      const digest=digestState.digest('hex');const destination=path.join(this.root,digest);
      if(fs.existsSync(destination))fs.unlinkSync(temporary);else fs.renameSync(temporary,destination);temporary=undefined;
      if(this.store.db.open)this.store.db.prepare("UPDATE message_attachments SET relative_path=?,media_type=?,status='saved',error=NULL,updated_at=? WHERE source_hash=?").run(digest,mediaType,new Date().toISOString(),hash);
    } catch(error) {
      if(this.store.db.open)this.store.db.prepare("UPDATE message_attachments SET status='failed',error=?,updated_at=? WHERE source_hash=?").run((error instanceof Error?error.message:String(error)).slice(0,500),new Date().toISOString(),hash);
    } finally {
      if(temporary)try{fs.unlinkSync(temporary);}catch{/* 临时文件不存在时无需处理。 */}
      this.active--;this.pump();
      if(this.active===0 && this.queue.length===0 && this.store.db.open)this.resumePending();
    }
  }
  async imageDataUrl(item:ImageAttachment):Promise<string> {
    const hash=sourceHash(item.url);const pending=this.pending.get(hash);if(pending)await pending;
    const row=this.store.db.prepare("SELECT relative_path,media_type FROM message_attachments WHERE source_hash=? AND status='saved' LIMIT 1").get(hash) as {relative_path:string;media_type:string}|undefined;
    if(row && /^[a-f0-9]{64}$/.test(row.relative_path) && ['image/png','image/jpeg','image/gif','image/webp'].includes(row.media_type)) {
      const file=path.join(this.root,row.relative_path);
      if(fs.existsSync(file)) {
        if(fs.statSync(file).size>10*1024*1024)throw new Error('图片已归档，但超过模型输入的 10MB 限制');
        return `data:${row.media_type};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    }
    return qqImageDataUrl(item);
  }
  /** 等待当前会话的附件归档完成，再返回已保存的本地文件。 */
  async archivedFile(conversationId:string,messageId:string,index:number):Promise<{path:string;mediaType:string}> {
    const row=this.store.db.prepare('SELECT source_hash,status,error FROM message_attachments WHERE conversation_id=? AND message_id=? AND attachment_index=?').get(conversationId,messageId,index) as {source_hash:string;status:string;error:string|null}|undefined;
    if(!row)throw new Error('没有找到此消息的附件归档');
    const pending=this.pending.get(row.source_hash);if(pending)await pending;
    const file=this.file(conversationId,messageId,index);if(file)return file;
    const state=this.store.db.prepare('SELECT status,error FROM message_attachments WHERE conversation_id=? AND message_id=? AND attachment_index=?').get(conversationId,messageId,index) as {status:string;error:string|null}|undefined;
    throw new Error(`附件尚未保存：${state?.error ?? state?.status ?? '未知原因'}`);
  }
  async messageImageDataUrl(conversationId:string,messageId:string,index:number):Promise<string> {
    const local=this.file(conversationId,messageId,index);
    if(local && fs.existsSync(local.path)) {
      if(!['image/png','image/jpeg','image/gif','image/webp'].includes(local.mediaType))throw new Error('不支持该图片格式');
      if(fs.statSync(local.path).size>10*1024*1024)throw new Error('图片已保存，但超过模型输入的 10MB 限制');
      return `data:${local.mediaType};base64,${fs.readFileSync(local.path).toString('base64')}`;
    }
    const row=this.store.db.prepare('SELECT attachments FROM messages WHERE conversation_id=? AND id=?').get(conversationId,messageId) as {attachments:string}|undefined;
    if(!row)throw new Error('找不到图片所属的消息');
    let item:Partial<ImageAttachment>|undefined;
    try {const entries=JSON.parse(row.attachments) as unknown;item=Array.isArray(entries)?entries[index] as Partial<ImageAttachment>|undefined:undefined;} catch {throw new Error('图片附件信息无法解析');}
    if(!item || typeof item.url!=='string')throw new Error('图片文件未找到，也没有可用的原始地址');
    return this.imageDataUrl({url:item.url,content_type:item.content_type ?? 'application/octet-stream'});
  }
  file(conversationId:string,messageId:string,index:number):{path:string;mediaType:string}|undefined {
    const row=this.store.db.prepare("SELECT relative_path,media_type FROM message_attachments WHERE conversation_id=? AND message_id=? AND attachment_index=? AND status='saved'").get(conversationId,messageId,index) as {relative_path:string;media_type:string}|undefined;
    if(!row)return undefined;
    if(row.relative_path.startsWith('workspace:')) {
      try {return {path:resolveWorkspaceFile(conversationId,row.relative_path.slice('workspace:'.length)),mediaType:row.media_type};} catch {return undefined;}
    }
    if(!/^[a-f0-9]{64}$/.test(row.relative_path))return undefined;
    const actual=path.join(this.root,row.relative_path);
    try {if(!fs.statSync(actual).isFile())return undefined;return {path:actual,mediaType:row.media_type};} catch {return undefined;}
  }
}
