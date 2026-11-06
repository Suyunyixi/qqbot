import { tool, createMiddleware } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { isAIMessage, isToolMessage } from '@langchain/core/messages';
import type { Store } from '../storage/store.js';
import type { Scope } from '../domain/types.js';
import { describeTool, type ToolCatalogEntry } from '../tools/catalog.js';

type Identity={conversationId:string;scope:Scope;taskId?:string};
const common=new Set(['find_tools','sandbox_capabilities','search_chat_history','read_chat_history','read_chat_message','list_chat_images','read_chat_image','remember_fact','web_search','research_web','read_webpage','current_time','start_background_task','send_text','send_media']);
const workerCommon=new Set(['ask_user','report_progress','deliver_media']);
const aliases:Record<string,string>={download_media:'b站 bilibili 视频 下载',deliver_media:'b站 bilibili 视频 音频 下载 转换 发送 交付 mp3 mp4',extract_audio:'视频 音频 转换 mp3 提取',inspect_media:'媒体 视频 音频 格式 大小 时长',search_images:'图片 立绘 素材 搜索',render_image_card:'图片 海报 卡片 制作 排版',run_python_script:'代码 脚本 绘图 图片 制作 处理',run_shell_command:'命令 代码 下载 脚本 处理',send_native_card:'qq 卡片 链接 榜单',send_media:'发送 图片 视频 音频 文件',find_tools:'查找 工具 能力 目录'};

function tokens(value:string):string[] {
  const text=value.toLowerCase();const parts=text.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];const out=new Set<string>();
  for(const part of parts) {
    if(/^[\u4e00-\u9fff]+$/.test(part)) {if(part.length===1)out.add(part);else for(let i=0;i<part.length-1;i++)out.add(part.slice(i,i+2));}
    else if(part.length>1)out.add(part);
  }
  return [...out];
}
function score(query:string,entry:ToolCatalogEntry):number {
  const target=`${entry.name} ${entry.label} ${entry.category} ${entry.description} ${aliases[entry.name] ?? ''}`.toLowerCase();
  return tokens(query).reduce((sum,word)=>sum+(target.includes(word)?(entry.name.toLowerCase().includes(word)||entry.label.includes(word)?3:1):0),0);
}

/** 每个回合独立保存已发现工具，工具实现本身仍由注册表和权限过滤决定。 */
export function createToolDiscovery(tools:StructuredToolInterface[],store:Store,identity:Identity,initialRequest:string,background=false) {
  const catalog=tools.map((item)=>describeTool(item));
  const allowed=new Set(tools.map((item)=>item.name));
  const enabled=new Set([...common,...(background?workerCommon:[])]);
  const ranked=(query:string)=>catalog.map((entry)=>({entry,score:score(query,entry)})).filter((item)=>item.score>0).sort((a,b)=>b.score-a.score||a.entry.name.localeCompare(b.entry.name));
  const initialMatches=ranked(initialRequest).slice(0,5);
  for(const match of initialMatches)enabled.add(match.entry.name);
  let initialRecorded=false;
  const record=(kind:string,query:string,names:string[])=>{
    try {store.db.prepare('INSERT INTO tool_discoveries(conversation_id,scope,task_id,query,candidates,created_at,kind) VALUES(?,?,?,?,?,?,?)').run(identity.conversationId,identity.scope,identity.taskId ?? null,query.slice(0,300),JSON.stringify(names),new Date().toISOString(),kind);}
    catch(error){console.error('工具发现记录保存失败：',error instanceof Error?error.message:String(error));}
  };
  const finder=tool(async ({query,names,listAll,limit})=>{
    const requested=names ?? [];
    const selected=requested.length ? catalog.filter((entry)=>requested.includes(entry.name)) : listAll ? [...catalog].sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name)) : ranked(query ?? '').map((item)=>item.entry);
    const results=selected.slice(0,limit);
    const activated=!listAll || requested.length>0;
    if(activated)for(const item of results)enabled.add(item.name);
    record('search',query || (requested.length?requested.join('、'):'查看完整目录'),results.map((item)=>item.name));
    return JSON.stringify({ok:true,tools:results,total:selected.length,activated,missing:requested.filter((name)=>!allowed.has(name)),hint:!results.length?'没有匹配项，可换词或查看完整目录；不要推断能力不存在。':!activated?'这是目录预览，请指定所需工具名称以启用。':'已在本回合启用列出的工具。'});
  },{name:'find_tools',description:'根据任务查找并启用相关工具；查询不到时可换词或查看完整目录。返回中文用途、权限、执行位置和可用工具名称。',schema:z.object({query:z.string().max(300).optional(),names:z.array(z.string().max(100)).max(30).optional(),listAll:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(12)})});
  const middleware=createMiddleware({
    name:'按需加载工具',
    wrapModelCall:(request,handler)=>{
      if(!initialRecorded){initialRecorded=true;record('auto',initialRequest,initialMatches.map((item)=>item.entry.name));}
      for(const message of request.messages) {
        if(isAIMessage(message))for(const call of message.tool_calls ?? [])if(allowed.has(call.name))enabled.add(call.name);
        if(isToolMessage(message) && message.name==='find_tools' && typeof message.content==='string')try {
          const result=JSON.parse(message.content) as {activated?:boolean;tools?:Array<{name?:string}>};
          if(result.activated!==false)for(const item of result.tools ?? [])if(item.name && allowed.has(item.name))enabled.add(item.name);
        } catch { /* 旧记录或非目录结果不影响当前回合。 */ }
      }
      return handler({...request,tools:request.tools.filter((item)=>{
        const name='name' in item && typeof item.name==='string'?item.name:undefined;
        return !name || name==='find_tools' || !allowed.has(name) || enabled.has(name);
      })});
    },
  });
  return {finder,middleware,catalog,enabled};
}
