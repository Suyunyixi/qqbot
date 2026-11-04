import fs from 'node:fs';
import path from 'node:path';
import { initConfig } from '../config/settings.js';
import { workspaceFor, resolveWorkspaceFile } from '../storage/workspace.js';
import { checkPythonRunner, renderImageCard, runPythonScript } from '../tools/python.js';
import { WorkspaceBackend } from '../storage/backend.js';
import { Store } from '../storage/store.js';
import { ReplyRuntime } from '../delivery/reply.js';
import { TaskManager } from '../agent/task-manager.js';
import { makeTools } from '../tools/registry.js';

initConfig();
await checkPythonRunner();
const root = workspaceFor('_python_smoke');
fs.writeFileSync(path.join(root, 'input.txt'), '中文输入');
fs.writeFileSync(path.join(root, 'demo.py'), "from pathlib import Path\nPath('result.txt').write_text(Path('input.txt').read_text(encoding='utf-8')+'成功', encoding='utf-8')\nprint('ok')\n");
const result = await runPythonScript('_python_smoke', '/demo.py', ['input.txt'], 15);
if (result.exitCode !== 0 || fs.readFileSync(resolveWorkspaceFile('_python_smoke', '/result.txt'), 'utf8') !== '中文输入成功') throw new Error('脚本输入或输出交接失败');
const image = await renderImageCard('_python_smoke', { title: '中文榜单', subtitle: '图片渲染测试', items: [{ title: '第一项', description: '输入内容' }] });
if (!fs.readFileSync(resolveWorkspaceFile('_python_smoke', image.virtualPath)).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('图片生成失败');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="red"/></svg>';
const backend = new WorkspaceBackend('_python_smoke'); const svgPath = path.join(root, 'card.svg');
const write = await backend.write(svgPath, svg); if (write.error || !fs.existsSync(svgPath)) throw new Error('真实工作区路径写入失败');
const legacy = path.join(root, root.replace(/^\/+/, ''), 'legacy.svg'); fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, svg);
if (resolveWorkspaceFile('_python_smoke', path.join(root, 'legacy.svg')) !== fs.realpathSync(legacy)) throw new Error('旧嵌套路径恢复失败');
const store = new Store(':memory:'); const sent: string[] = [];
const reply = new ReplyRuntime(store, { send: async (item) => { sent.push(item.content); return { id: 'mock-qq' }; } });
const tasks = new TaskManager(store, async () => '', async () => {});
try {
  const media = makeTools({ conversationId: '_python_smoke', scope: 'group', store, reply, tasks, background: false }).find((item) => item.name === 'send_media');
  if (!media) throw new Error('缺少媒体发送工具');
  const response = JSON.parse(String(await media.invoke({ file: path.join(root, 'legacy.svg'), kind: 'image' }))) as { ok?: boolean; error?: string };
  if (!response.ok || sent.length !== 1 || !fs.readFileSync(sent[0]!).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error(`SVG 交付链路失败：${response.error ?? 'PNG 无效'}`);
} finally { tasks.stop(); store.close(); }
console.log('工作区路径、旧文件恢复、Python 输入输出、中文图片及 SVG 转 PNG 后交付通过（模拟 QQ）');
