import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'qq-conversation-isolation-'));
const { initConfig }=await import('../src/config/settings.js');
const { Store }=await import('../src/storage/store.js');
const { ReplyRuntime }=await import('../src/delivery/reply.js');
const { renderConversationReply }=await import('../src/agent/conversation-renderer.js');
const { parseJmRequest }=await import('../src/tools/jm.js');
const { parseAgentReplyDraft }=await import('../src/agent/reply-draft.js');
const { BalanceAlert }=await import('../src/agent/balance-alert.js');
initConfig();

describe('对话 Agent 隔离',()=>{
  it('仅接收主人格与结构化草稿，不读取群聊历史',async()=>{
    const store=new Store(':memory:');store.setAppSetting('persona','测试人格：活泼自然');
    store.record({id:'m1',conversationId:'g',scope:'group',senderId:'u',content:'不应送入表达 Agent 的历史',timestamp:new Date().toISOString(),isMention:true,attachments:[]});
    let input='';
    const result=await renderConversationReply(store,{conversationId:'g',scope:'group',content:'完成，密码 123456。'},async(messages)=>{
      expect(messages).toHaveLength(2);
      input=JSON.stringify(messages.map((item)=>item.content));
      expect(input).toContain('测试人格：活泼自然');
      expect(input).not.toContain('不应送入表达 Agent 的历史');
      expect(input).toContain('回复对象');expect(input).toContain('内容');expect(input).toContain('备注');
      return {content:'做好啦，密码是 ⟦保留0⟧。'};
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
  it('结构化任务只匹配明确的 JM 下载请求',()=>{
    expect(parseJmRequest('给我去JM上面下载 1475661，然后导出pdf 添加密码发到群里')).toEqual({albumId:'1475661'});
    expect(parseJmRequest('JM123456')).toEqual({albumId:'123456'});
    expect(parseJmRequest('下载 JM123456 密码为 abc123')).toEqual({albumId:'123456',password:'abc123'});
    expect(parseJmRequest('JM123456 是什么？')).toBeUndefined();
  });
  it('执行结果的对象、事实和场景备注作为独立字段交接',()=>{
    expect(parseAgentReplyDraft('```json\n{"回复对象":"なの","内容":"确认收到提醒","备注":"群友提醒注意分寸"}\n```')).toEqual({recipient:'なの',content:'确认收到提醒',remarks:'群友提醒注意分寸'});
  });
});
