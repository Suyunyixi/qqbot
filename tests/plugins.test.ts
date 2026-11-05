import { describe,expect,it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registeredPlugins,reloadPlugins } from '../src/tools/plugins.js';

describe('工具插件热重载',()=>{
  it('重新加载入口及相对依赖，失败时保持原插件',async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-reload-test-'));const lib=path.join(dir,'lib');fs.mkdirSync(lib);
    const helper=path.join(lib,'helper.mjs');const entry=path.join(dir,'plugin.mjs');
    fs.writeFileSync(entry,"import { label } from './lib/helper.mjs'; export default { name:label,permissions:[],selfCheck(){ if(label==='bad')throw Error('self-check failed') },createTools(){return []} };\n");
    try {
      fs.writeFileSync(helper,"export const label='first';\n");await reloadPlugins(dir);expect(registeredPlugins().map((p)=>p.name)).toEqual(['first']);
      fs.writeFileSync(helper,"export const label='second';\n");await reloadPlugins(dir);expect(registeredPlugins().map((p)=>p.name)).toEqual(['second']);
      fs.writeFileSync(helper,"export const label='bad';\n");await expect(reloadPlugins(dir)).rejects.toThrow('self-check failed');expect(registeredPlugins().map((p)=>p.name)).toEqual(['second']);
      fs.writeFileSync(helper,"export const label='third';\n");await expect(reloadPlugins(dir,()=>{throw Error('invalid tools')})).rejects.toThrow('invalid tools');expect(registeredPlugins().map((p)=>p.name)).toEqual(['second']);
    } finally {await reloadPlugins(path.join(dir,'missing'));fs.rmSync(dir,{recursive:true,force:true});}
  });
});
