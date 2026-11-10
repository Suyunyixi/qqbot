import { describe,expect,it } from 'vitest';
import { messageTime,renderMessage,renderMessages } from '../src/agent/message-view.js';
import type { MessageRow } from '../src/storage/store.js';

const row=(overrides:Partial<MessageRow>):MessageRow=>({seq:1,id:'m',conversation_id:'g',scope:'group',sender_id:'u',sender_name:'小王',content:'1',timestamp:'2026-11-09T14:17:33+08:00',direction:'in',attachments:'[]',raw:null,is_mention:0,...overrides});

describe('消息发送者和时间',()=>{
  it('用户与机器人消息分别标注身份，保留原始时间和时区',()=>{
    const user=renderMessage(row({}));
    const bot=renderMessage(row({id:'b',sender_id:'bot',sender_name:'机器人',direction:'out',timestamp:'2026-11-09T06:18:00Z',content:'我在'}));
    expect(user).toContain('【用户】 小王 [u]');expect(user).toContain('2026-11-09T14:17:33+08:00');
    expect(bot).toContain('【机器人本人】 机器人 [bot]');expect(bot).toContain('2026-11-09T06:18:00Z');
    expect(messageTime('2026-11-09T06:18:00Z')).toContain('Asia/Shanghai 2026/11/09 14:18:00');
  });
  it('长消息裁剪仍保留发送者身份，错误时间不伪造',()=>{
    const text=renderMessages([row({direction:'out',sender_id:'bot',sender_name:'机器人',content:'长'.repeat(900)})],400);
    expect(text).toContain('【机器人本人】');expect(messageTime('错误时间')).toBe('错误时间');
  });
});
