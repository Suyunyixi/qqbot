import fs from 'node:fs';
import path from 'node:path';
import { QQBot, type QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { startQrConnect, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';
import { dataDir, readConfig } from '../../config/settings.js';
import { Harness } from '../../agent/harness.js';
import { Store } from '../../storage/store.js';
import type { DeliveryItem, InboundEvent, Sender, SendResult } from '../../domain/types.js';
import { qqVoiceBuffer } from './voice.js';
import { buildNativeArk } from '../../domain/card.js';

const credentialsFile = path.join(dataDir, 'qq-credentials.json');
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
  constructor(credentials: QrConnectCredentials, private readonly store: Store, private readonly onState: (connected: boolean) => void) {
    // SDK debug output contains complete inbound events and outgoing messages.
    // Keep operational errors without duplicating private chats or tokens in Docker logs.
    this.bot = new QQBot({ appId: credentials.appId, appSecret: credentials.appSecret, logger: { info: console.info, warn: console.warn, error: console.error } });
    this.bot.on('ready', () => { this.connected = true; this.onState(true); console.log('QQ 已连接'); });
    this.bot.on('resumed', () => { this.connected = true; this.onState(true); });
    this.bot.on('disconnected', () => { this.connected = false; this.onState(false); });
    this.bot.on('error', (error) => console.error('QQ 连接错误：', error.message));
  }
  listen(harness: Harness): void {
    this.bot.on('message', (_ctx, msg: QQBotInboundMessage) => {
      if (msg.senderIsBot || !['group', 'c2c'].includes(msg.kind)) return;
      const scope = msg.kind === 'group' ? 'group' : 'c2c';
      const conversationId = scope === 'group' ? msg.groupOpenid : msg.senderId;
      if (!conversationId || !msg.messageId || !msg.senderId) return;
      const content = msg.content ?? '';
      const isMention = msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || Boolean(msg.mentions?.some((m) => m.is_you === true)) || content.includes(`<@!${this.bot.appId}>`) || content.includes(`<@${this.bot.appId}>`);
      const event: InboundEvent = { id: msg.messageId, conversationId, scope, senderId: msg.senderId, senderName: msg.senderName, content, timestamp: msg.timestamp || new Date().toISOString(), isMention, attachments: msg.attachments ?? [], raw: msg };
      void harness.receive(event).catch((err: unknown) => console.error('接收消息失败：', err instanceof Error ? err.message : err));
    });
  }
  start(): Promise<void> { return this.bot.start(); }
  stop(): void { this.bot.stop(); }
  async send(item: DeliveryItem): Promise<SendResult> {
    if (!this.connected) throw new Error('QQ 尚未连接');
    const ttl = item.scope === 'group' ? 300000 : 1800000;
    const candidates = this.store.db.prepare("SELECT id,timestamp FROM messages WHERE conversation_id=? AND direction='in' ORDER BY seq DESC LIMIT 30").all(item.conversationId) as Array<{ id: string; timestamp: string }>;
    candidates.sort((a, b) => Number(b.id === item.replyTo) - Number(a.id === item.replyTo));
    const candidate = candidates.find((row) => {
      const time = Date.parse(row.timestamp); if (!Number.isFinite(time) || Date.now() - time > ttl || Date.now() < time - 60000) return false;
      const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE conversation_id=? AND reply_to=? AND status IN ('sent','unknown')").get(item.conversationId, row.id) as { n: number };
      return count.n < 4;
    });
    if (!candidate && !readConfig().delivery.proactive) throw new Error('没有可用的 QQ 回复目标，主动发送已关闭');
    const target = { scope: item.scope, targetId: item.conversationId, msgId: candidate?.id };
    this.store.setOutboxTarget(item.id, candidate?.id);
    // QQ does not render Markdown sent as msg_type=0. Match dsh-qqbot and
    // explicitly send msg_type=2 with markdown.content for both chat scopes.
    if (item.kind === 'text') return this.bot.sendMarkdown(target, item.content);
    if (item.kind === 'card') return this.bot.send({ target, msgType: 3, content: ' ', ark: buildNativeArk(JSON.parse(item.content)) });
    const source = { localPath: item.content };
    const response = item.kind === 'image' ? await this.bot.sendImage(target, source) : item.kind === 'voice' ? await this.bot.sendVoice(target, { buffer: await qqVoiceBuffer(item.content) }) : item.kind === 'video' ? await this.bot.sendVideo(target, source) : await this.bot.sendFile(target, source, { fileName: item.fileName });
    if (!response.message) throw new Error('媒体上传完成，但没有取得 QQ 消息回执');
    return response.message;
  }
}
