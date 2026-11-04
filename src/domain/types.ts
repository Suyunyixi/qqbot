export type Scope = 'group' | 'c2c';

export interface InboundEvent {
  id: string;
  conversationId: string;
  scope: Scope;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: string;
  isMention: boolean;
  attachments: unknown[];
  raw?: unknown;
}

export interface ReplyTarget {
  scope: Scope;
  targetId: string;
  msgId?: string;
}

export type DeliveryKind = 'text' | 'image' | 'voice' | 'video' | 'file' | 'card';
export interface DeliveryItem {
  id: string;
  conversationId: string;
  scope: Scope;
  replyTo?: string;
  kind: DeliveryKind;
  content: string;
  fileName?: string;
}

export interface SendResult { id?: string; timestamp?: string | number }
export interface Sender {
  send(item: DeliveryItem): Promise<SendResult>;
}
