import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  dataset: Record<string,string> = {};
  listeners: Record<string,() => unknown> = {};
  classList = { toggle: () => {} };
  checked = false;
  value = '';
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 500;
  html = '';
  onclick?: () => unknown;
  addEventListener(name:string, callback:() => unknown) { this.listeners[name]=callback; }
  insertAdjacentHTML(_position:string,value:string) { this.html+=value; }
}
class View extends Element {
  html = '';
  groupButtons: Element[] = [];
  toolButtons: Element[] = [];
  set innerHTML(value:string) {
    this.html=value;
    this.groupButtons=[...value.matchAll(/data-group="([^"]+)"/g)].map((match)=>{const el=new Element();el.dataset.group=match[1]!;return el});
    this.toolButtons=[...value.matchAll(/data-tool="([^"]+)"\s*(checked)?/g)].map((match)=>{const el=new Element();el.dataset.tool=match[1]!;el.checked=!!match[2];return el});
  }
  get innerHTML() { return this.html; }
  insertAdjacentHTML(_position:string,value:string) { this.html+=value; }
  querySelectorAll(selector:string) { return selector==='[data-group]'?this.groupButtons:selector==='[data-tool]'?this.toolButtons:[]; }
}

describe('管理页面群聊交互', () => {
  it('可配置的内置工具都有中文名称和用途', async () => {
    const {toolPermissions}=await import('../src/tools/sandbox.js');
    const {builtInCatalog}=await import('../src/tools/catalog.js');const catalog=builtInCatalog();
    const missing=Object.keys(toolPermissions).filter((name)=>!name.startsWith('owner_') && (!catalog.find((entry)=>entry.name===name) || !/[\u4e00-\u9fff]/.test(catalog.find((entry)=>entry.name===name)!.label) || !/[\u4e00-\u9fff]/.test(catalog.find((entry)=>entry.name===name)!.description)));
    expect(missing).toEqual([]);
  });
  it('能切换群并保存设置，工具展示中文说明且保留未知工具配置', async () => {
    const view=new View();const elements=new Map<string,Element>([['#view',view]]);
    const element=(selector:string) => {if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector)!};
    const settings=()=>({label:'',enabled:true,keywords:[],persona:'',engagementWindowSeconds:180,disabledTools:['plugin_saved']});
    const conversations=[{scope:'group',conversation_id:'first',message_count:2,last_activity:'2026-11-05T01:00:00Z',settings:settings()},{scope:'group',conversation_id:'second',message_count:1,last_activity:'2026-11-05T01:00:00Z',settings:settings()}];
    let saved:Record<string,unknown>|undefined;let savedRuntime:Record<string,unknown>|undefined;
    const fetch=vi.fn(async (input:string, options?:{method?:string;body?:string})=>{
      let data:unknown={};
      if(input==='/api/conversations')data={conversations};
      else if(input==='/api/identities')data={identities:[],owner:''};
      else if(input==='/status')data={phase:'ready',qqConnected:true,checks:[]};
      else if(input==='/api/tasks')data={tasks:[]};
      else if(input==='/api/deliveries')data={deliveries:[]};
      else if(input==='/api/metrics')data={totals:[],recent:[]};
      else if(input==='/api/dialogue-flow')data={flows:[{id:'turn-1',conversation_id:'first',status:'completed',received_at:'2026-11-05T01:00:00Z',sender_name:'群友',user_message:'你好',main:[{id:'trace-1',phase:'主回复',text:'准备回应',request_path:'r',response_path:'s'}],expressions:[{id:'trace-2',input:{content:'准备回应'},text:'你好呀',persona_matches:true,persona_in_request:true,request_path:'r',response_path:'s'}],deliveries:[{kind:'text',status:'sent',content:'你好呀'}]}]};
      else if(input==='/api/tools')data={tools:['web_search'],requirements:{web_search:['network']},agents:[{name:'主 Agent',description:'理解和调度',tools:['web_search']},{name:'对话 Agent',description:'人格表达',tools:[]}],catalog:[{name:'web_search',label:'联网搜索',category:'联网与资料',description:'搜索网页',permissions:['network'],source:'内置',execution:'前台或后台',effect:'只读或计算',status:'已启用'}]};
      else if(input==='/api/tool-activity')data={discoveries:[{conversation_id:'first',query:'查资料',candidates:'["web_search"]'}],calls:[{conversation_id:'first',name:'web_search',status:'success',duration_ms:12}]};
      else if(input==='/api/runtime-config' && options?.method==='PUT'){savedRuntime=JSON.parse(options.body!) as Record<string,unknown>;data={ok:true};}
      else if(input==='/api/runtime-config')data={model:{provider:'anthropic',baseUrl:'https://example.com',name:'model',vision:true,semanticReview:true,contextTokens:1048576},memory:{recentMessages:60,summaryBudgetChars:8000,summaryThresholdPercent:75},tasks:{concurrency:3},tools:{search:true,media:true,python:true},permissions:{network:true}};
      else if(input==='/api/plugins')data={plugins:[]};
      else if(input.startsWith('/api/messages?'))data={messages:[]};
      else if(input==='/api/group' && options?.method==='PUT') {saved=JSON.parse(options.body!) as Record<string,unknown>;const group=conversations.find((c)=>c.conversation_id===saved?.conversationId);if(group)group.settings=saved.settings as ReturnType<typeof settings>;data={ok:true};}
      else throw Error(`unexpected ${input}`);
      return {ok:true,json:async()=>data};
    });
    const context=vm.createContext({document:{querySelector:element,querySelectorAll:()=>[]},fetch,URLSearchParams,console,setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}});
    vm.runInContext(fs.readFileSync('assets/admin/admin.js','utf8'),context);
    await vi.waitFor(()=>expect(view.innerHTML).toContain('启动自检'));
    await vm.runInContext("page('dialogueFlow')",context);
    expect(view.innerHTML).toContain('主 Agent');expect(view.innerHTML).toContain('对话 Agent');expect(view.innerHTML).toContain('实际请求包含当前完整人格');expect(view.innerHTML).toContain('你好呀');expect(view.innerHTML).toContain('实际发送');
    vm.runInContext("state.identities=[{conversation_id:'first',external_id:'opaque-id',display_name:'小王',user_id:'user-1'}]",context);
    expect(vm.runInContext("displayMentions('<@opaque-id> <@unknown-id>','first')",context)).toBe('@小王 @群成员');
    await vm.runInContext("page('groups')",context);
    expect(view.innerHTML).toContain('联网搜索');expect(view.innerHTML).toContain('优先关注的时间范围');
    expect(view.innerHTML).toContain('未命名QQ群 1');expect(view.innerHTML).toContain('未命名QQ群 2');
    expect(view.innerHTML).not.toContain('QQ群 first');expect(view.innerHTML).not.toContain('QQ群 second');
    vm.runInContext("state.conversations[0].platform_name='QQ 群名称'",context);
    expect(vm.runInContext("conversationName('first')",context)).toBe('QQ 群名称');
    vm.runInContext("state.conversations[0].label='人工备注'",context);
    expect(vm.runInContext("conversationName('first')",context)).toBe('人工备注');
    await view.groupButtons[1]!.listeners.click!();
    expect(view.innerHTML).toContain('data-group="second"');
    expect(view.innerHTML).toContain('list-item selectable selected" data-group="second"');
    element('#group-label').value='测试名称';element('#group-enabled').checked=true;element('#group-keywords').value='';element('#group-persona').value='';element('#group-window').value='180';
    await element('#save-group').listeners.click!();
    expect(saved).toMatchObject({conversationId:'second',settings:{label:'测试名称',disabledTools:['plugin_saved']}});
    expect(element('#toast').textContent).toBe('群聊设置已保存');
    await vm.runInContext("page('settings')",context);
    expect(view.innerHTML).toContain('达到预算的百分之多少时整理');expect(view.innerHTML).not.toContain('累计多少条后整理记忆');
    element('#model-provider').value='anthropic';element('#model-base').value='https://example.com';element('#model-name').value='model';element('#model-context').value='1048576';
    element('#memory-recent').value='60';element('#memory-budget').value='8000';element('#memory-percent').value='75';element('#task-concurrency').value='3';
    await element('#save-settings').onclick!();
    expect(savedRuntime).toMatchObject({model:{contextTokens:1048576},memory:{recentMessages:60,summaryBudgetChars:8000,summaryThresholdPercent:75},tasks:{concurrency:3}});
    await vm.runInContext("page('tools')",context);
    expect(view.innerHTML).toContain('工具目录');expect(view.innerHTML).toContain('联网搜索');expect(view.innerHTML).toContain('查资料');expect(view.innerHTML).toContain('12 毫秒');
    expect(view.innerHTML).toContain('各 Agent 的职责与工具');expect(view.innerHTML).toContain('对话 Agent');expect(view.innerHTML).toContain('无业务工具');
  });
  it('区分群聊和私聊，能编辑会话备注并添加成员备注', async () => {
    const view=new View();const elements=new Map<string,Element>([['#view',view]]);
    const element=(selector:string)=>{if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector)!};
    const groupSettings={label:'群备注名',enabled:true,keywords:[],persona:'',engagementWindowSeconds:180,disabledTools:[]};
    const conversations=[{scope:'group',conversation_id:'g-id',message_count:3,last_activity:'2026-11-05T01:00:00Z',settings:groupSettings,label:'群备注名',note:''},{scope:'c2c',conversation_id:'p-id',message_count:1,last_activity:'2026-11-05T01:00:00Z',label:'私聊备注名',note:''}];
    let profile:Record<string,unknown>|undefined;let member:Record<string,unknown>|undefined;
    const fetch=vi.fn(async(input:string,options?:{method?:string;body?:string})=>{
      let data:unknown={};
      if(input==='/api/conversations')data={conversations};
      else if(input==='/api/identities')data={identities:[],owner:''};
      else if(input==='/status')data={phase:'ready',qqConnected:true,checks:[]};
      else if(input==='/api/tasks')data={tasks:[]};
      else if(input==='/api/deliveries')data={deliveries:[]};
      else if(input==='/api/metrics')data={totals:[],recent:[]};
      else if(input.startsWith('/api/conversation-members?'))data={members:[]};
      else if(input==='/api/conversation-members' && options?.method==='POST'){member=JSON.parse(options.body!) as Record<string,unknown>;data={ok:true};}
      else if(input==='/api/conversation-profile' && options?.method==='PUT'){profile=JSON.parse(options.body!) as Record<string,unknown>;data={ok:true};}
      else throw Error(`unexpected ${input}`);
      return {ok:true,json:async()=>data};
    });
    const context=vm.createContext({document:{querySelector:element,querySelectorAll:()=>[]},fetch,URLSearchParams,console,setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}});
    vm.runInContext(fs.readFileSync('assets/admin/admin.js','utf8'),context);
    await vi.waitFor(()=>expect(view.innerHTML).toContain('启动自检'));
    await vm.runInContext("page('conversations')",context);
    expect(view.innerHTML).toContain('QQ群');expect(view.innerHTML).toContain('QQ 私聊');expect(view.innerHTML).toContain('g-id');
    expect(view.innerHTML).not.toContain('平台会话 ID');
    vm.runInContext(`state.identities=[{user_id:'system-a',external_id:'external-a',display_name:'昵称',remark_name:'备注',alias_order:1},{user_id:'system-b',external_id:'external-b',display_name:'备注',alias_order:2},{user_id:'system-c',external_id:'external-c',alias_order:3}]`,context);
    expect(vm.runInContext("identityName('system-a')",context)).toBe('备注');
    expect(vm.runInContext("identityOptionName('system-a')",context)).toBe('备注（用户 1）');
    expect(vm.runInContext("identityOptionName('system-b')",context)).toBe('备注（用户 2）');
    expect(vm.runInContext("identityName('system-c')",context)).toBe('未命名用户 3');
    vm.runInContext('state.identities.reverse()',context);
    expect(vm.runInContext("identityName('system-c')",context)).toBe('未命名用户 3');
    element('#conversation-label').value='新名称';element('#conversation-note').value='人工填写';await element('#save-conversation').onclick!();
    expect(profile).toMatchObject({scope:'group',conversationId:'g-id',label:'新名称',note:'人工填写'});
    await vm.runInContext("page('members')",context);
    expect(view.innerHTML).toContain('平台成员 ID');expect(view.innerHTML).toContain('不代表 QQ 群主或管理员');
    element('#new-member-id').value='openid-1';element('#new-member-name').value='成员备注';element('#new-member-note').value='人工信息';await element('#add-member').onclick!();
    expect(member).toMatchObject({scope:'group',conversationId:'g-id',externalId:'openid-1',remarkName:'成员备注',note:'人工信息'});
  });
  it('聊天记录以聊天气泡展示并向上加载更早消息', async () => {
    const view=new View();const elements=new Map<string,Element>([['#view',view]]);
    const element=(selector:string)=>{if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector)!};
    const urls:string[]=[];
    const fetch=vi.fn(async(input:string)=>{
      urls.push(input);let data:unknown={};
      if(input==='/api/conversations')data={conversations:[{scope:'group',conversation_id:'group-id',first_seq:1,label:'我的群',message_count:2}]};
      else if(input==='/api/identities')data={identities:[],owner:''};
      else if(input==='/status')data={phase:'ready',qqConnected:true,checks:[]};
      else if(input==='/api/tasks')data={tasks:[]};
      else if(input==='/api/deliveries')data={deliveries:[]};
      else if(input==='/api/metrics')data={totals:[],recent:[]};
      else if(input.startsWith('/api/messages?'))data=input.includes('before=')?{messages:[{id:'old',conversation_id:'group-id',direction:'in',sender_name:'群友',content:'更早的消息',attachments:'[]'}],hasMore:false,nextBefore:null}:{messages:[{id:'latest',conversation_id:'group-id',direction:'out',content:'<最新消息>',quotedContent:'<引用原文>',attachments:'[]'}],hasMore:true,nextBefore:12};
      else throw Error(`unexpected ${input}`);
      return {ok:true,json:async()=>data};
    });
    const context=vm.createContext({document:{querySelector:element,querySelectorAll:()=>[]},fetch,URLSearchParams,console,setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}});
    vm.runInContext(fs.readFileSync('assets/admin/admin.js','utf8'),context);
    await vi.waitFor(()=>expect(view.innerHTML).toContain('启动自检'));
    await vm.runInContext("page('history')",context);
    expect(view.innerHTML).toContain('我的群');expect(view.innerHTML).toContain('chat-message out');expect(view.innerHTML).toContain('&lt;最新消息&gt;');
    expect(view.innerHTML).toContain('chat-quote');expect(view.innerHTML).toContain('&lt;引用原文&gt;');
    await element('#history-older').onclick!();
    expect(urls.some((url)=>url.includes('before=12'))).toBe(true);
    expect(element('#history-messages').html).toContain('更早的消息');expect(element('#history-older').hidden).toBe(true);
  });
});
