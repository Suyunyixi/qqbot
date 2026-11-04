// Run inside the bot container with stdin: no QQ connection or real model calls.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-'));
process.env.BOT_DATA_DIR = path.join(temp, 'data');
process.env.BOT_WORKSPACE_DIR = path.join(temp, 'workspace');
delete process.env.BOT_SQLITE_PATH; delete process.env.BOT_CHECKPOINT_PATH; delete process.env.BOT_MODEL_ENV_PATH;
process.env.MODEL_PROVIDER = 'openai'; process.env.MODEL_API_KEY = 'test-key'; process.env.MODEL_NAME = 'test-model';
const { initConfig } = await import('./dist/config/settings.js'); initConfig();
const { Store } = await import('./dist/storage/store.js');
const { workspaceFor } = await import('./dist/storage/workspace.js');
const { Harness } = await import('./dist/agent/harness.js');
const id = 'agent-bridge-test'; const output = path.join(workspaceFor(id), 'card.svg');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="red"/></svg>';
let requests = 0; let registered = false;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body); requests++;
    const names = (request.tools || []).map((item) => item.function?.name);
    registered ||= ['run_python_script', 'render_image_card', 'send_native_card', 'send_media'].every((name) => names.includes(name));
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    let message;
    if (toolMessages.length === 0) message = { role:'assistant', content:null, tool_calls:[{id:'write-1',type:'function',function:{name:'write_file',arguments:JSON.stringify({file_path:output,content:svg})}}] };
    else if (toolMessages.length === 1) message = { role:'assistant', content:null, tool_calls:[{id:'send-1',type:'function',function:{name:'send_media',arguments:JSON.stringify({file:output,kind:'image'})}}] };
    else message = { role:'assistant', content:'完成' };
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({id:`mock-${requests}`,object:'chat.completion',created:1,model:'test-model',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.MODEL_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
const store = new Store(':memory:'); const sent=[];
const harness = new Harness(store,{send:async (item)=>{sent.push(item);return {id:`mock-${sent.length}`}}});
try {
  await harness.receive({id:'input',conversationId:id,scope:'c2c',senderId:'user',content:'生成测试图片',timestamp:new Date().toISOString(),isMention:false,attachments:[]});
  const deadline=Date.now()+25000; while(sent.length<2 && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
  const image=sent.find(item=>item.kind==='image');
  if(!registered || !image || !fs.readFileSync(image.content).subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw Error(`Agent 全链路失败，工具注册=${registered}，交付=${sent.map(x=>x.kind).join(',')}`);
  console.log('真实 Deep Agents 工具调用链通过：绝对路径写入 → SVG 转 PNG → 模拟 QQ 交付；Python/卡片工具已注册');
} finally { harness.stop(); store.close(); await new Promise(resolve=>server.close(resolve)); }
