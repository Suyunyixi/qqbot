import fs from 'node:fs';
import path from 'node:path';
import { initConfig } from '../config/settings.js';
import { workspaceFor, resolveWorkspaceFile } from '../storage/workspace.js';
import { checkPythonRunner, renderImageCard, runPythonScript } from '../tools/python.js';

initConfig();
await checkPythonRunner();
const root = workspaceFor('_python_smoke');
fs.writeFileSync(path.join(root, 'input.txt'), '中文输入');
fs.writeFileSync(path.join(root, 'demo.py'), "from pathlib import Path\nPath('result.txt').write_text(Path('input.txt').read_text(encoding='utf-8')+'成功', encoding='utf-8')\nprint('ok')\n");
const result = await runPythonScript('_python_smoke', '/demo.py', ['input.txt'], 15);
if (result.exitCode !== 0 || fs.readFileSync(resolveWorkspaceFile('_python_smoke', '/result.txt'), 'utf8') !== '中文输入成功') throw new Error('脚本输入或输出交接失败');
const image = await renderImageCard('_python_smoke', { title: '中文榜单', subtitle: '图片渲染测试', items: [{ title: '第一项', description: '输入内容' }] });
if (!fs.readFileSync(resolveWorkspaceFile('_python_smoke', image.virtualPath)).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('图片生成失败');
console.log('机器人与 Python 文件交接、脚本和中文图片生成通过');
