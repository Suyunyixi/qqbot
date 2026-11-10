import catalogData from './catalog.json' with { type:'json' };
import type { StructuredToolInterface } from '@langchain/core/tools';
import { toolPermissions, type ToolPermission } from './sandbox.js';
import { z } from 'zod';

export interface ToolCatalogEntry {
  name:string; label:string; category:string; description:string; source:string;
  permissions:readonly ToolPermission[]; execution:'前台或后台'|'后台'; effect:'只读或计算'|'工作区写入'|'消息交付'|'配置变更'|'未声明'; inputs:string[]; output:string;
}
const catalog:Record<string,{category:string;label:string;description:string}>=catalogData;
type PluginDetails={label?:string;category?:string;description?:string;backgroundOnly?:boolean;effect?:'只读或计算'|'工作区写入'|'消息交付'|'配置变更';output?:string};
const origins=new WeakMap<object,{source:string;permissions:readonly ToolPermission[];details?:PluginDetails}>();
const backgroundOnly=new Set(['deliver_media','download_jm_pdf','ask_user','report_progress']);
const delivery=new Set(['send_text','send_media','send_native_card','send_keyboard','send_embed','speak','deliver_media','download_jm_pdf','retry_delivery']);
const settings=new Set(['set_voice','owner_set_group_preferences','owner_add_memory','owner_qq_api']);
const outputs:Record<string,string>={query_jm:'查询时间、分页、作品或排行榜结果',web_search:'来源链接、检索时间和搜索结果',research_web:'搜索结果及来源原文',read_webpage:'网页正文、来源和发布时间',search_images:'图片地址及来源',download_file:'工作区路径、文件格式和大小',download_media:'工作区视频路径、名称和大小',extract_audio:'音频路径、格式和大小',inspect_media:'媒体格式、编码、大小和时长',run_python_script:'退出状态、输出和工作区产物',run_shell_command:'退出状态、输出和工作区产物',render_image_card:'生成的图片路径',send_media:'实际发送状态和文件名',send_text:'实际发送或转交状态',deliver_media:'下载、转换和真实交付结果',start_background_task:'后台任务状态和标识',find_tools:'匹配的可用工具及本轮启用状态',list_chat_images:'历史图片消息、发言人、时间、归档状态与翻页位置',read_chat_image:'读取状态；成功后将图片提供给模型'};
export const toolFeature:Record<string,'search'|'media'|'python'|'voice'>={query_jm:'search',web_search:'search',search_bilibili_card:'search',research_web:'search',search_images:'search',read_webpage:'search',download_file:'search',download_media:'media',extract_audio:'media',inspect_media:'media',read_video_frames:'media',deliver_media:'media',run_python_script:'python',run_shell_command:'python',render_image_card:'python',speak:'voice',set_voice:'voice',list_voices:'voice'};

export function registerPluginTool(tool:StructuredToolInterface,source:string,permissions:readonly ToolPermission[],details?:PluginDetails):void {
  origins.set(tool,{source:`插件：${source}`,permissions,details});
}
export function describeTool(tool:Pick<StructuredToolInterface,'name'|'description'> & Partial<Pick<StructuredToolInterface,'schema'>>,includeSchema=false):ToolCatalogEntry {
  const info=catalog[tool.name];const origin=origins.get(tool as object);
  const permissions=origin?.permissions ?? toolPermissions[tool.name] ?? [];
  let inputs:string[]=[];
  try {if(includeSchema && tool.schema && 'safeParse' in tool.schema){const schema=z.toJSONSchema(tool.schema as unknown as z.ZodType) as {properties?:Record<string,unknown>};inputs=Object.keys(schema.properties ?? {});}} catch { /* 旧版插件的参数结构可能无法转换。 */ }
  return {name:tool.name,label:origin?.details?.label ?? info?.label ?? tool.name,category:origin?.details?.category ?? info?.category ?? '插件与其他',description:origin?.details?.description ?? info?.description ?? tool.description ?? '暂无说明',source:origin?.source ?? '内置',permissions,
    execution:backgroundOnly.has(tool.name)||origin?.details?.backgroundOnly?'后台':'前台或后台',
    effect:origin?origin.details?.effect ?? '未声明':delivery.has(tool.name)?'消息交付':settings.has(tool.name)?'配置变更':permissions.includes('workspaceWrite')?'工作区写入':'只读或计算',inputs,output:origin?.details?.output ?? outputs[tool.name] ?? '结构化执行结果，以实际返回为准'};
}
export function builtInCatalog():ToolCatalogEntry[] {
  return [...Object.keys(toolPermissions),'find_tools'].sort().map((name)=>describeTool({name,description:''}));
}
