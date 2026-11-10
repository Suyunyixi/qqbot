import { describe,expect,it,vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';

const mocked=vi.hoisted(()=>({options:undefined as Record<string,unknown>|undefined,answer:undefined as unknown,invoke:undefined as undefined|(()=>Promise<void>)}));
vi.mock('deepagents',async(importOriginal)=>({...await importOriginal<typeof import('deepagents')>(),createDeepAgent:(options:Record<string,unknown>)=>{
  mocked.options=options;
  return {invoke:async()=>{await mocked.invoke?.();return {messages:[mocked.answer]};},updateState:async()=>{}};
}}));
vi.mock('../src/models/factory.js',()=>({makeModel:()=>({})}));

process.env.BOT_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'qq-reply-routing-'));
const { initConfig }=await import('../src/config/settings.js');
const { Store }=await import('../src/storage/store.js');
const { Harness }=await import('../src/agent/harness.js');
const { AgentRuntime }=await import('../src/agent/runtime.js');
const { ReplyRuntime }=await import('../src/delivery/reply.js');
const { TaskManager }=await import('../src/agent/task-manager.js');
initConfig();

const event={id:'m',conversationId:'g',scope:'group' as const,senderId:'u',senderName:'群友',content:'请处理',timestamp:new Date().toISOString(),isMention:true,attachments:[]};

describe('回复交接边界',()=>{
  it('主 Agent 的原话直接交给对话 Agent，再发送渲染结果',async()=>{
    const store=new Store(':memory:');store.record(event);
    const send=vi.fn(async()=>({id:'sent'}));const render=vi.fn(async(draft:{content:string})=>`人格表达：${draft.content}`);
    const reply=new ReplyRuntime(store,{send},render);const tasks=new TaskManager(store,async()=>'',async()=>{});
    const agent=new AgentRuntime(store);mocked.answer=new AIMessage({id:'answer',content:'{"内容":"保持原话"}'});mocked.invoke=undefined;
    try {
      await agent.respond({conversationId:'g',scope:'group',replyTo:'m',actorId:'u',store,reply,tasks,background:false},event);
      expect(render).toHaveBeenCalledOnce();expect(render.mock.calls[0]![0].content).toBe('{"内容":"保持原话"}');
      expect(send.mock.calls[0]![0].content).toBe('人格表达：{"内容":"保持原话"}');
    } finally {tasks.stop();store.close();}
  });
  it('后台任务启动后主 Agent 继续形成回复，不由工具返回代替',async()=>{
    const store=new Store(':memory:');store.record({...event,id:'start'});
    const send=vi.fn(async()=>({id:'sent'}));const render=vi.fn(async(draft:{content:string})=>draft.content);
    const reply=new ReplyRuntime(store,{send},render);const tasks=new TaskManager(store,async()=>'',async()=>{});
    const enqueue=vi.spyOn(tasks,'enqueue').mockReturnValue('task-id');
    const agent=new AgentRuntime(store);mocked.answer=new AIMessage({id:'started-answer',content:'任务已开始，我会跟进结果。'});
    mocked.invoke=async()=>{
      const tools=mocked.options?.tools as Array<{name:string;returnDirect?:boolean;invoke:(input:unknown)=>Promise<unknown>}>;
      const start=tools.find((item)=>item.name==='start_background_task')!;
      expect(start.returnDirect).not.toBe(true);
      await start.invoke({instruction:'处理测试任务'});
    };
    try {
      await agent.respond({conversationId:'g',scope:'group',replyTo:'start',actorId:'u',store,reply,tasks,background:false},{...event,id:'start'});
      expect(enqueue).toHaveBeenCalledOnce();expect(render.mock.calls[0]![0].content).toBe('任务已开始，我会跟进结果。');
    } finally {mocked.invoke=undefined;tasks.stop();store.close();}
  });
  it('主 Agent 可以直接使用普通业务工具，文字仍交给对话 Agent',async()=>{
    const store=new Store(':memory:');store.record({...event,id:'tools'});
    const send=vi.fn(async()=>({id:'sent'}));const reply=new ReplyRuntime(store,{send},async(draft)=>draft.content);
    const tasks=new TaskManager(store,async()=>'',async()=>{});const agent=new AgentRuntime(store);
    mocked.answer=new AIMessage({id:'tools-answer',content:'已经查过。'});
    mocked.invoke=async()=>{
      const tools=mocked.options?.tools as Array<{name:string}>;const names=tools.map((item)=>item.name);
      expect(names).toContain('web_search');expect(names).toContain('run_python_script');expect(names).toContain('send_media');
      expect(names).not.toContain('send_text');
    };
    try {await agent.respond({conversationId:'g',scope:'group',replyTo:'tools',actorId:'u',store,reply,tasks,background:false},{...event,id:'tools'});expect(send.mock.calls[0]![0].content).toBe('已经查过。');}
    finally {mocked.invoke=undefined;tasks.stop();store.close();}
  });
  it('普通触发和旧版特殊任务的回调均进入主 Agent',async()=>{
    const store=new Store(':memory:');const send=vi.fn(async()=>({id:'sent'}));const harness=new Harness(store,{send});
    const respond=vi.spyOn(AgentRuntime.prototype,'respond').mockResolvedValue();
    try {
      await harness.receive({...event,content:'下载 JM1475661 并发送'});
      await vi.waitFor(()=>expect(respond).toHaveBeenCalledOnce());
      expect(respond.mock.calls[0]![1].content).toContain('JM1475661');expect(store.listTasks('g')).toHaveLength(0);
      const id=store.addTask('g','group','m','旧任务',undefined,'jm_pdf','{}');
      store.setTask(id,'completed','{"delivered":true,"file":"文件.pdf"}');
      const task=store.task(id)!;
      await (harness as unknown as {callback:(task:typeof task)=>Promise<void>}).callback(task);
      expect(respond).toHaveBeenCalledTimes(2);expect(respond.mock.calls[1]![2]).toBe(true);
      expect(respond.mock.calls[1]![1].content).toContain('文件.pdf');expect(send).not.toHaveBeenCalled();
    } finally {respond.mockRestore();harness.stop();store.close();}
  });
  it('确定性系统通知经过相同的发送记录，但不调用模型',async()=>{
    const store=new Store(':memory:');const send=vi.fn(async()=>({id:'sent'}));const render=vi.fn(async()=>{throw new Error('不应调用模型');});
    try {
      const reply=new ReplyRuntime(store,{send},render);
      await reply.sendSystemText('g','group','m','系统通知','system:test');
      expect(render).not.toHaveBeenCalled();expect(send.mock.calls[0]![0].content).toBe('系统通知');
      expect(store.outboxState('system:test:0')).toBe('sent');
    } finally {store.close();}
  });
  it('后台执行没有结果时不伪称完成',async()=>{
    const store=new Store(':memory:');const tasks=new TaskManager(store,async()=>'',async()=>{});
    const reply=new ReplyRuntime(store,{send:async()=>({id:'sent'})});const agent=new AgentRuntime(store);
    const id=store.addTask('g','group','m','测试任务');const task=store.task(id)!;
    mocked.answer=new AIMessage({id:'empty',content:''});mocked.invoke=undefined;
    try {
      await expect(agent.runBackground({conversationId:'g',scope:'group',replyTo:'m',store,reply,tasks,background:true,taskId:id},task,new AbortController().signal)).rejects.toThrow('后台执行未返回结果');
    } finally {tasks.stop();store.close();}
  });
});
