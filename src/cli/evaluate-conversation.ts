import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if(!process.env.EVAL_MODEL_API_KEY || !process.env.EVAL_MODEL_BASE_URL || !process.env.EVAL_MODEL_NAME)throw new Error('请显式设置 EVAL_MODEL_API_KEY、EVAL_MODEL_BASE_URL 和 EVAL_MODEL_NAME；评估会实际调用模型并产生费用');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-conversation-eval-'));
process.env.BOT_DATA_DIR=temporary;
process.env.BOT_CONFIG_PATH=path.join(temporary,'config.yaml');
process.env.BOT_WORKSPACE_DIR=path.join(temporary,'workspace');
delete process.env.BOT_MODEL_ENV_PATH;
process.env.MODEL_API_KEY=process.env.EVAL_MODEL_API_KEY;
process.env.MODEL_BASE_URL=process.env.EVAL_MODEL_BASE_URL;
process.env.MODEL_NAME=process.env.EVAL_MODEL_NAME;
process.env.MODEL_PROVIDER=process.env.EVAL_MODEL_PROVIDER ?? 'openai';
const {Store}=await import('../storage/store.js');
const {ReplyRuntime}=await import('../delivery/reply.js');
const {TaskManager}=await import('../agent/task-manager.js');
const {AgentRuntime}=await import('../agent/runtime.js');

const cases=[
  {name:'连续两句后唤醒',prior:'我是鲸鱼娘。',messages:[['甲','你就是大肥鱼啊'],['甲','你不信问问其他人']],request:'<@bot>',criterion:'是否理解两句话，并实际向其他群友提问'},
  {name:'群友已经答复',prior:'小李，这份清单对吗？',messages:[['小李','大部分对，但 A 应该往下调整']],request:'<@bot> 他刚才是不是已经回复了？',criterion:'是否识别小李已答复，不重复问或虚报修改'},
  {name:'无关插话',prior:'我在。',messages:[['乙','明天准备去旅游']],request:'<@bot> 7 加 5 等于多少？',criterion:'是否回答当前问题，不过度介入无关聊天'},
  {name:'相关纠正',prior:'这张表我整理好了。',messages:[['乙','这个角色放得太靠前']],request:'<@bot> 你怎么看乙说的？',criterion:'是否回应纠正，缺少表格时不编造位置'},
];
try {
  for(const [index,test] of cases.entries()) {
    const store=new Store(':memory:');store.setPersona('你是群里自然、真诚的聊天伙伴，活泼但不强行卖萌，不编造事实。','system');
    const sent:string[]=[];const reply=new ReplyRuntime(store,{send:async(item)=>{sent.push(item.content);return {id:`模拟-${sent.length}`}}});
    const tasks=new TaskManager(store,async()=>{throw new Error('评估不执行后台任务');},async()=>{});const agent=new AgentRuntime(store);
    const conversationId=`评估-${index}`;const now=Date.now();
    store.recordSent({id:'此前回复',conversationId,scope:'group',kind:'text',content:test.prior},'此前回复');
    for(const [i,[sender,content]] of test.messages.entries())store.record({id:`消息-${i}`,conversationId,scope:'group',senderId:sender!,senderName:sender!,content:content!,timestamp:new Date(now+i*1000).toISOString(),isMention:false,attachments:[]});
    const event={id:'触发',conversationId,scope:'group' as const,senderId:'甲',senderName:'甲',content:test.request,timestamp:new Date(now+10000).toISOString(),isMention:true,attachments:[]};store.record(event);
    const started=Date.now();
    try {await agent.respond({conversationId,scope:'group',actorId:'甲',store,reply,tasks,background:false},event);console.log(JSON.stringify({场景:test.name,检查:test.criterion,耗时毫秒:Date.now()-started,回复:sent}));}
    catch(error) {console.log(JSON.stringify({场景:test.name,错误:error instanceof Error?error.message:String(error)}));}
    finally {tasks.stop();store.close();(agent as unknown as {checkpointer:{db:{close():void}}}).checkpointer.db.close();}
  }
} finally {
  const resolved=fs.realpathSync(temporary);const tempRoot=fs.realpathSync(os.tmpdir());
  if(path.dirname(resolved)===tempRoot && path.basename(resolved).startsWith('qq-conversation-eval-'))fs.rmSync(resolved,{recursive:true,force:true});
}
