import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolContext } from './registry.js';
import type { ToolPermission } from './sandbox.js';

export interface ToolPlugin {
  name: string;
  permissions: ToolPermission[];
  /** Run at startup; throw if a required dependency or configuration is unavailable. */
  selfCheck(): Promise<void> | void;
  /** Return tools bound to this conversation. Long-running tools belong in background. */
  createTools(context: ToolContext): StructuredToolInterface[];
}
const plugins: ToolPlugin[] = [];
const pluginSnapshots=new Set<string>();
process.once('exit',()=>{for(const dir of pluginSnapshots)try{fs.rmSync(dir,{recursive:true,force:true})}catch{/* temporary snapshot */}});
let loaded = false;

export async function loadPlugins(directory = process.env.TOOL_PLUGIN_DIR ?? path.resolve('plugins')): Promise<void> {
  if (loaded) return;
  const found=await discoverPlugins(directory,false);
  plugins.splice(0,plugins.length,...found);loaded=true;
}
async function discoverPlugins(directory:string,check:boolean):Promise<ToolPlugin[]> {
  if (!fs.existsSync(directory)) return [];
  let source=directory;let snapshot:string | undefined;
  if(check) {
    snapshot=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-plugins-'));source=path.join(snapshot,'plugins');
    try {
      fs.cpSync(directory,source,{recursive:true});
      const appModules=path.resolve('node_modules');if(fs.existsSync(appModules))fs.symlinkSync(appModules,path.join(snapshot,'node_modules'),'junction');
    } catch(error) {fs.rmSync(snapshot,{recursive:true,force:true});throw error;}
  }
  const found: ToolPlugin[] = [];
  try { for (const file of fs.readdirSync(source).filter((name) => name.endsWith('.mjs')).sort()) {
    const url=pathToFileURL(path.join(source,file));url.searchParams.set('reload',randomUUID());
    const module = await import(url.href) as { default?: ToolPlugin };
    const plugin = module.default;
    const allowed = ['network', 'process', 'workspaceRead', 'workspaceWrite'];
    if (!plugin || typeof plugin.name !== 'string' || !Array.isArray(plugin.permissions) || plugin.permissions.some((item) => !allowed.includes(item)) || typeof plugin.selfCheck !== 'function' || typeof plugin.createTools !== 'function') throw new Error(`工具插件 ${file} 必须声明 name、permissions、selfCheck 和 createTools`);
    if (found.some((item) => item.name === plugin.name)) throw new Error(`工具插件重名: ${plugin.name}`);
    if(check)await plugin.selfCheck();
    found.push(plugin);
  }} catch(error) {if(snapshot)fs.rmSync(snapshot,{recursive:true,force:true});throw error;}
  if(snapshot)pluginSnapshots.add(snapshot);
  return found;
}
let reloadInFlight:Promise<readonly ToolPlugin[]> | undefined;
/** Discover and self-check every candidate before replacing the active list. */
export async function reloadPlugins(directory = process.env.TOOL_PLUGIN_DIR ?? path.resolve('plugins'), validate?:(plugins:readonly ToolPlugin[])=>Promise<void>|void):Promise<readonly ToolPlugin[]> {
  if(reloadInFlight)return reloadInFlight;
  reloadInFlight=(async()=>{const previous=new Set(pluginSnapshots);const found=await discoverPlugins(directory,true);try{await validate?.(found);}catch(error){for(const dir of pluginSnapshots)if(!previous.has(dir)){fs.rmSync(dir,{recursive:true,force:true});pluginSnapshots.delete(dir);}throw error;}plugins.splice(0,plugins.length,...found);loaded=true;return registeredPlugins();})();
  try{return await reloadInFlight}finally{reloadInFlight=undefined}
}
export function registeredPlugins(): readonly ToolPlugin[] { return plugins; }
