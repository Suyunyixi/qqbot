import { tool, createMiddleware } from 'langchain';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import type { Store } from '../storage/store.js';
import type { Scope } from '../domain/types.js';
import { describeTool, type ToolCatalogEntry } from '../tools/catalog.js';

type Identity={conversationId:string;scope:Scope;taskId?:string};
type DelegatedTools={executor?:StructuredToolInterface[];background?:StructuredToolInterface[]};
type Discoverable=ToolCatalogEntry & {调用位置:'当前 Agent'|'执行子 Agent'|'后台任务'};
const aliases:Record<string,string>={search_bilibili_card:'b站 bilibili 小程序 分享 卡片 标题 视频 BV 链接 反查',download_media:'b站 bilibili 视频 下载',deliver_media:'b站 bilibili 视频 音频 下载 转换 发送 交付 mp3 mp4',extract_audio:'视频 音频 转换 mp3 提取',inspect_media:'媒体 视频 音频 格式 大小 时长',read_video_frames:'看视频 读取视频 理解视频 画面 抽帧',search_images:'图片 立绘 素材 搜索',render_image_card:'图片 海报 卡片 制作 排版',run_python_script:'代码 脚本 绘图 图片 制作 处理',run_shell_command:'命令 代码 下载 脚本 处理',send_native_card:'qq 卡片 链接 榜单',send_media:'发送 图片 视频 音频 文件',find_tools:'查找 工具 能力 目录'};

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

/** 当前角色的工具直接可见；目录检索仅用于查询其他执行者的能力。 */
export function createToolDiscovery(tools:StructuredToolInterface[],store:Store,identity:Identity,initialRequest:string,background=false,delegated:DelegatedTools={}) {
  const index=new Map<string,Discoverable>();
  for(const [items,location] of [[tools,'当前 Agent'],[delegated.executor ?? [],'执行子 Agent'],[delegated.background ?? [],'后台任务']] as const) for(const item of items) {
    if(!index.has(item.name))index.set(item.name,{...describeTool(item),调用位置:location});
  }
  const catalog=[...index.values()];
  const allowed=new Set(tools.map((item)=>item.name));
  const enabled=new Set(allowed);
  const ranked=(query:string)=>catalog.map((entry)=>({entry,score:score(query,entry)})).filter((item)=>item.score>0).sort((a,b)=>b.score-a.score||a.entry.name.localeCompare(b.entry.name));
  const record=(kind:string,query:string,names:string[])=>{
    try {store.db.prepare('INSERT INTO tool_discoveries(conversation_id,scope,task_id,query,candidates,created_at,kind) VALUES(?,?,?,?,?,?,?)').run(identity.conversationId,identity.scope,identity.taskId ?? null,query.slice(0,300),JSON.stringify(names),new Date().toISOString(),kind);}
    catch(error){console.error('工具发现记录保存失败：',error instanceof Error?error.message:String(error));}
  };
  const finder=tool(async ({query,names,listAll,limit,offset})=>{
    const requested=names ?? [];
    const selected=requested.length ? catalog.filter((entry)=>requested.includes(entry.name)) : listAll ? [...catalog].sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name)) : ranked(query ?? '').map((item)=>item.entry);
    const results=selected.slice(offset,offset+limit);
    record('search',query || (requested.length?requested.join('、'):'查看完整目录'),results.map((item)=>item.name));
    return JSON.stringify({ok:true,tools:results.map((item)=>({...item,已启用:allowed.has(item.name)})),total:selected.length,nextOffset:offset+results.length<selected.length?offset+results.length:null,activated:false,missing:requested.filter((name)=>!index.has(name)),hint:!results.length?'没有匹配项，可换词或查看完整目录；不要推断能力不存在。':'当前 Agent 的工具始终可直接使用；其他位置的工具需委派给相应执行者。'});
  },{name:'find_tools',description:'查询当前角色及其他执行者的工具目录和执行位置；当前角色的工具无需通过此工具启用。',schema:z.object({query:z.string().max(300).optional(),names:z.array(z.string().max(100)).max(30).optional(),listAll:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(12),offset:z.number().int().min(0).default(0)})});
  const middleware=createMiddleware({
    name:'角色工具目录',
    wrapModelCall:(request,handler)=>handler(request),
  });
  return {finder,middleware,catalog,enabled};
}
