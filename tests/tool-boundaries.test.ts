import { describe,expect,it,vi } from 'vitest';
import { tool } from 'langchain';
import { z } from 'zod';
import { Store } from '../src/storage/store.js';
import { createToolDiscovery } from '../src/agent/tool-discovery.js';
import { executionAgentTools } from '../src/agent/subagent-policy.js';
import { makeTools, type ToolContext } from '../src/tools/registry.js';
import { TaskManager } from '../src/agent/task-manager.js';
import { ReplyRuntime } from '../src/delivery/reply.js';

const make=(name:string)=>tool(async()=>name,{name,description:`测试能力 ${name}`,schema:z.object({})});

describe('工具职责边界',()=>{
  it('主 Agent 能发现子 Agent 和后台能力，但不能把它们启用为自身工具',async()=>{
    const store=new Store(':memory:');
    try {
      const discovery=createToolDiscovery([make('local')],store,{conversationId:'g',scope:'group'},'你好',false,{executor:[make('executor')],background:[make('worker')]});
      const result=JSON.parse(String(await discovery.finder.invoke({names:['local','executor','worker']})));
      expect(result.tools.map((item:{name:string;调用位置:string})=>[item.name,item.调用位置])).toEqual([['local','当前 Agent'],['executor','执行子 Agent'],['worker','后台任务']]);
      expect(discovery.enabled.has('local')).toBe(true);
      expect(discovery.enabled.has('executor')).toBe(false);
      expect(discovery.enabled.has('worker')).toBe(false);
      expect(result.missing).toEqual([]);
    } finally {store.close();}
  });
  it('无需关键词或查找，当前角色的全部工具都传给模型',async()=>{
    const store=new Store(':memory:');
    try {
      const tools=[make('tool_a'),make('tool_b')];
      const discovery=createToolDiscovery(tools,store,{conversationId:'g',scope:'group'},'与工具无关的短句');
      const handler=vi.fn(async(request:unknown)=>request);
      await discovery.middleware.wrapModelCall!({messages:[],tools} as never,handler as never);
      expect(handler.mock.calls[0]![0]).toMatchObject({tools});
      expect([...discovery.enabled]).toEqual(['tool_a','tool_b']);
    } finally {store.close();}
  });
  it('工具目录可以翻页，后面的插件不因数量过多而不可见',async()=>{
    const store=new Store(':memory:');
    try {
      const tools=Array.from({length:105},(_,index)=>make(`tool_${String(index).padStart(3,'0')}`));
      const discovery=createToolDiscovery(tools,store,{conversationId:'g',scope:'group'},'你好');
      const first=JSON.parse(String(await discovery.finder.invoke({listAll:true,limit:100})));
      const second=JSON.parse(String(await discovery.finder.invoke({listAll:true,limit:100,offset:first.nextOffset})));
      expect(first.tools).toHaveLength(100);expect(second.tools).toHaveLength(5);expect(second.nextOffset).toBeNull();
    } finally {store.close();}
  });
  it('后台专属插件可被发现但不会进入前台执行助手',async()=>{
    const store=new Store(':memory:');const tasks=new TaskManager(store,async()=>'',async()=>{});
    try {
      const ctx:ToolContext={conversationId:'g',scope:'group',store,tasks,reply:new ReplyRuntime(store,{send:async()=>({})}),background:false};
      const plugin={name:'测试插件',permissions:[],catalog:{worker_only:{backgroundOnly:true}},selfCheck(){},createTools(){return [make('worker_only')];}};
      const foreground=makeTools(ctx,[plugin]);const background=makeTools({...ctx,background:true,taskId:'test'},[plugin]);
      const helper=executionAgentTools(foreground,[]);
      expect(helper.some((item)=>item.name==='worker_only')).toBe(false);
      const discovery=createToolDiscovery([],store,{conversationId:'g',scope:'group'},'你好',false,{executor:helper,background});
      const result=JSON.parse(String(await discovery.finder.invoke({names:['worker_only']})));
      expect(result.tools[0]).toMatchObject({name:'worker_only',调用位置:'后台任务'});
      expect(discovery.enabled.has('worker_only')).toBe(false);
    } finally {tasks.stop();store.close();}
  });
});
