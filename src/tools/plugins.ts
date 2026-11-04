import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
let loaded = false;

export async function loadPlugins(directory = process.env.TOOL_PLUGIN_DIR ?? path.resolve('plugins')): Promise<void> {
  if (loaded) return;
  if (!fs.existsSync(directory)) { loaded = true; return; }
  const found: ToolPlugin[] = [];
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.mjs')).sort()) {
    const module = await import(pathToFileURL(path.join(directory, file)).href) as { default?: ToolPlugin };
    const plugin = module.default;
    const allowed = ['network', 'process', 'workspaceRead', 'workspaceWrite'];
    if (!plugin || typeof plugin.name !== 'string' || !Array.isArray(plugin.permissions) || plugin.permissions.some((item) => !allowed.includes(item)) || typeof plugin.selfCheck !== 'function' || typeof plugin.createTools !== 'function') throw new Error(`工具插件 ${file} 必须声明 name、permissions、selfCheck 和 createTools`);
    if (found.some((item) => item.name === plugin.name)) throw new Error(`工具插件重名: ${plugin.name}`);
    found.push(plugin);
  }
  plugins.push(...found); loaded = true;
}
export function registeredPlugins(): readonly ToolPlugin[] { return plugins; }
