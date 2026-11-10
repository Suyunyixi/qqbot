import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'qq-conversation-isolation-'));
const { initConfig }=await import('../src/config/settings.js');
const { Store }=await import('../src/storage/store.js');
const { ReplyRuntime }=await import('../src/delivery/reply.js');
const { renderConversationReply }=await import('../src/agent/conversation-renderer.js');
const { BalanceAlert }=await import('../src/agent/balance-alert.js');
initConfig();

describe('对话 Agent 隔离',()=>{
  it('仅接收主人格与结构化草稿，不读取群聊历史',async()=>{
    const store=new Store(':memory:');store.setAppSetting('persona','测试人格：活泼自然');
    store.record({id:'m1',conversationId:'g',scope:'group',senderId:'u',content:'不应送入表达 Agent 的历史',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    let input='';
    const result=await renderConversationReply(store,{conversationId:'g',scope:'group',content:'完成，密码 123456。',remarks:'不应进入表达阶段的备注'},async(messages)=>{
      expect(messages).toHaveLength(2);
      input=JSON.stringify(messages.map((item)=>item.content));
      expect(input).toContain('测试人格：活泼自然');
      expect(input).not.toContain('不应送入表达 Agent 的历史');
      expect(input).not.toContain('不应进入表达阶段的备注');
      const draft=JSON.parse(String(messages[1]!.content));
      expect(draft).toMatchObject({回复对象:'当前群聊',待发送回复:'完成，密码 123456。'});
      expect(draft).not.toHaveProperty('内容');expect(draft).not.toHaveProperty('备注');
      expect(String(messages[0]!.content)).toContain('语气、句式和措辞由你的人格决定');
      expect(String(messages[0]!.content)).toContain('不要回答草稿');
      expect(String(messages[0]!.content)).toContain('不要新增事实、承诺、任务或建议');
      expect(input).toContain('123456');
      return {content:'做好啦，密码是 123456。'};
    });
    expect(result).toBe('做好啦，密码是 123456。');store.close();
  });
  it('表达 Agent 失败时不会把执行草稿发给群',async()=>{
    const store=new Store(':memory:');const send=vi.fn(async()=>({id:'sent'}));
    const reply=new ReplyRuntime(store,{send},async()=>{throw new Error('表达失败');});
    await expect(reply.send('g','group','m','text','执行 Agent 草稿')).rejects.toThrow('表达失败');
    expect(send).not.toHaveBeenCalled();
    await reply.send('g','group','m','text','系统故障提示',undefined,undefined,true);
    expect(send).toHaveBeenCalledOnce();store.close();
  });
  it('对话 Agent 决定是否艾特，并将本群成员的艾特按 QQ 格式交付',async()=>{
    const store=new Store(':memory:');store.setAppSetting('persona','测试人格');
    store.memory.observe('group','g','member-1','小喵');
    store.memory.observe('group','other','member-2','其他群成员');
    const send=vi.fn(async()=>({id:'sent'}));
    const reply=new ReplyRuntime(store,{send},(draft)=>renderConversationReply(store,draft,async(messages)=>{
      const input=JSON.stringify(messages.map((message)=>message.content));
      expect(input).toContain('小喵');expect(input).toContain('member-1');expect(input).not.toContain('member-2');
      expect(input).toContain('需要艾特时使用');
      return {content:'@小喵（member-1） 主人叫你啦'};
    }));
    const result=await reply.send('g','group','m','text','请小喵过来');
    expect(result).toBe('<qqbot-at-user id="member-1" /> 主人叫你啦');
    expect(send.mock.calls[0]![0].content).toBe(result);
    store.close();
  });
  it('不凭空艾特、不能跨群艾特，也不猜测重名成员',async()=>{
    const store=new Store(':memory:');store.memory.observe('group','g','one','小喵');store.memory.observe('group','g','two','小喵');store.memory.observe('group','other','three','其他人');
    const draft={conversationId:'g',scope:'group' as const,content:'小喵说得对'};
    expect(await renderConversationReply(store,draft,async()=>({content:'小喵说得对'}))).toBe('小喵说得对');
    await expect(renderConversationReply(store,draft,async()=>({content:'@小喵 你好'}))).rejects.toThrow('艾特对象无法确定');
    await expect(renderConversationReply(store,draft,async()=>({content:'<qqbot-at-user id="three" /> 你好'}))).rejects.toThrow('不在当前会话');
    store.close();
  });
  it('成员名只是更长名称的前缀时不误艾特',async()=>{
    const store=new Store(':memory:');store.memory.observe('group','g','one','小喵');
    const result=await renderConversationReply(store,{conversationId:'g',scope:'group',content:'向小喵咪问好'},async()=>({content:'@小喵咪 你好'}));
    expect(result).toBe('@小喵咪 你好');store.close();
  });
  it('密码等必须交付的信息不能被表达 Agent 改写或省略',async()=>{
    const store=new Store(':memory:');store.setAppSetting('persona','测试人格');
    const draft={conversationId:'g',scope:'group' as const,content:'文件已发送，密码：鱼🐟秘密',protectedValues:['鱼🐟秘密']};
    const output=await renderConversationReply(store,draft,async()=>({content:'文件发好啦，密码是 ⟦保留0⟧'}));
    expect(output).toContain('鱼🐟秘密');
    await expect(renderConversationReply(store,draft,async()=>({content:'文件发好啦'}))).rejects.toThrow('遗漏必须保留的信息');
    store.close();
  });
  it('模型余额不足时系统提醒不依赖模型生成',async()=>{
    const store=new Store(':memory:');store.record({id:'m',conversationId:'g',scope:'group',senderId:'owner',content:'你好',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    store.memory.setOwner(store.memory.lookup('group','g','owner')!);
    const sent=vi.fn(async()=>({id:'alert'}));const render=vi.fn(async()=>{throw new Error('余额不足');});
    await new BalanceAlert(store,new ReplyRuntime(store,{send:sent},render)).report(new Error('402 Insufficient Balance'));
    expect(render).not.toHaveBeenCalled();expect(sent).toHaveBeenCalledOnce();expect(sent.mock.calls[0]![0].content).toContain('主人，我的饭饭吃光啦');store.close();
  });
});
