// 在机器人镜像中验证真实抽帧和模型请求，不连接 QQ 或实际模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-video-test-'));
process.env.BOT_DATA_DIR=path.join(root,'data');process.env.BOT_WORKSPACE_DIR=path.join(root,'workspace');
delete process.env.BOT_SQLITE_PATH;delete process.env.BOT_CHECKPOINT_PATH;delete process.env.BOT_MODEL_ENV_PATH;
process.env.MODEL_PROVIDER='openai';process.env.MODEL_API_KEY='test-key';process.env.MODEL_NAME='test-model';
const {initConfig}=await import('./dist/config/settings.js');initConfig();
const {Store}=await import('./dist/storage/store.js');
const {Harness}=await import('./dist/agent/harness.js');
const {workspaceFor}=await import('./dist/storage/workspace.js');
const {videoFrameTools}=await import('./dist/agent/video-frames.js');
const {AttachmentArchive}=await import('./dist/storage/attachments.js');
const id='视频测试群';const file=path.join(workspaceFor(id),'测试视频.mp4');
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc=size=320x180:rate=5','-t','2','-c:v','mpeg4','-y',file]);
let gotFrames=false;let called=false;let requestCount=0;
const server=http.createServer((req,res)=>{
  let body='';req.on('data',(chunk)=>{body+=chunk;});req.on('end',()=>{
    const request=JSON.parse(body);requestCount++;const names=(request.tools||[]).map((item)=>item.function?.name);
    const messages=request.messages.filter((message)=>message.role==='tool');
    const isExecutor=JSON.stringify(request.messages).includes('你是主 Agent 的内部执行助手');
    gotFrames ||= isExecutor && JSON.stringify(request.messages).includes('data:image/jpeg;base64,');
    let message;
    if(isExecutor && gotFrames)message={role:'assistant',content:'已看到测试画面'};
    else if(isExecutor && names.includes('read_video_frames')){called=true;message={role:'assistant',content:null,tool_calls:[{id:'video-1',type:'function',function:{name:'read_video_frames',arguments:JSON.stringify({input:file,frameCount:2})}}]};}
    else if(isExecutor)message={role:'assistant',content:null,tool_calls:[{id:'find-1',type:'function',function:{name:'find_tools',arguments:JSON.stringify({names:['read_video_frames']})}}]};
    else if(!messages.length)message={role:'assistant',content:null,tool_calls:[{id:'task-1',type:'function',function:{name:'task',arguments:JSON.stringify({description:`看看视频，文件是 ${file}`,subagent_type:'general-purpose'})}}]};
    else message={role:'assistant',content:JSON.stringify(messages).includes('已看到测试画面')?'已看到测试画面':'读取视频失败'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:`mock-${requestCount}`,object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});
await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));process.env.MODEL_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
const store=new Store(':memory:');const sent=[];const harness=new Harness(store,{send:async(item)=>{sent.push(item);return {id:'sent'}}});
try {
  await harness.receive({id:'video-request',conversationId:id,scope:'c2c',senderId:'u',content:'看看视频',timestamp:new Date().toISOString(),isMention:false,attachments:[]});
  const deadline=Date.now()+30000;while(!sent.length && Date.now()<deadline){await new Promise((resolve)=>setTimeout(resolve,100));if(store.db.prepare("SELECT 1 FROM chat_turns WHERE status IN ('completed','failed')").get())break;}
  if(!called || !gotFrames || !sent.some((item)=>item.content.includes('已看到测试画面'))){const checkpoint=await harness.agent.checkpointer.getTuple({configurable:{thread_id:`c2c:${id}`}});const messages=checkpoint?.checkpoint.channel_values.messages.map((item)=>({type:item.constructor.name,content:typeof item.content==='string'?item.content.slice(0,100):'多模态',name:item.name}));throw new Error(`视频模型链路失败：工具调用=${called}，模型收到画面=${gotFrames}，交付=${JSON.stringify(sent)}，回合=${JSON.stringify(store.db.prepare('SELECT status FROM chat_turns').all())}，消息=${JSON.stringify(messages)}`);}
  const archive=new AttachmentArchive(store);const original=globalThis.fetch;
  globalThis.fetch=(input,options)=>String(input)==='https://example.qq.com/video.mp4'?Promise.resolve(new Response(fs.readFileSync(file),{headers:{'content-type':'video/mp4'}})):original(input,options);
  const inbound={id:'received-video',conversationId:id,scope:'c2c',senderId:'u',content:'视频',timestamp:new Date().toISOString(),isMention:false,attachments:[{url:'https://example.qq.com/video.mp4',content_type:'video/mp4'}]};
  store.record(inbound);archive.enqueue(inbound);
  const read=videoFrameTools(archive,id,true).tools[0];
  const result=JSON.parse(String(await read.invoke({messageId:'received-video',frameCount:2})));
  if(!result.ok || result.frameTimes.length!==2 || result.audioUnderstood!==false)throw new Error(`聊天视频读取失败：${JSON.stringify(result)}`);
  const other=JSON.parse(String(await videoFrameTools(archive,'其他群',true).tools[0].invoke({messageId:'received-video'})));
  if(other.ok)throw new Error('错误地读取了其他会话的视频');
  const disabled=JSON.parse(String(await videoFrameTools(archive,id,false).tools[0].invoke({input:file})));
  if(disabled.ok)throw new Error('关闭视觉能力时不应声称能看视频');
  globalThis.fetch=original;
  console.log('视频验证通过：模型主动调用、真实抽帧、模型收到图片、群视频归档读取及会话隔离');
} finally {harness.stop();store.close();await new Promise((resolve)=>server.close(resolve));}
