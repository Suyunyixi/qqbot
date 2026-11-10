import { describe,expect,it } from 'vitest';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { Store } from '../src/storage/store.js';
import { handleAdmin } from '../src/admin/api.js';

describe('管理页的 Agent 工具清单',()=>{
  it('按实际注册结果区分主 Agent、子 Agent、后台与对话 Agent',async()=>{
    const store=new Store(':memory:');let output='';let status=0;
    const request={method:'GET',url:'/api/tools',headers:{host:'localhost'}} as IncomingMessage;
    const response={writeHead:(value:number)=>{status=value;},end:(value:string)=>{output=value;}} as unknown as ServerResponse;
    try {
      await handleAdmin(request,response,store,undefined);
      expect(status).toBe(200);
      const data=JSON.parse(output) as {agents:Array<{name:string;tools:string[]}>;pluginError:string};
      expect(data.pluginError).toBe('');
      const byName=(name:string)=>data.agents.find((agent)=>agent.name===name)!;
      expect(byName('主 Agent').tools).toContain('web_search');
      expect(byName('主 Agent').tools).not.toContain('send_text');
      expect(byName('后台任务 Agent').tools).toContain('download_jm_pdf');
      expect(byName('执行子 Agent').tools).not.toContain('download_jm_pdf');
      expect(byName('对话 Agent').tools).toEqual([]);
      expect(byName('主 Agent').tools).toContain('read_file');
    } finally {store.close();}
  });
});
