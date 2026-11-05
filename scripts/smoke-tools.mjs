// Run inside the bot container. The QQ sender below is deliberately a test stub.
import fs from 'node:fs';
import path from 'node:path';
import { downloadPublicFile } from './dist/tools/web.js';
import { runPythonScript } from './dist/tools/python.js';
import { workspaceFor } from './dist/storage/workspace.js';
import { Store } from './dist/storage/store.js';
import { ReplyRuntime } from './dist/delivery/reply.js';

const conversation = '_integration_smoke';
const root = workspaceFor(conversation);
const asset = await downloadPublicFile(conversation, 'https://www.python.org/static/community_logos/python-logo.png');
const relative = path.relative(root, asset.path).split(path.sep).join('/');
fs.writeFileSync(path.join(root, 'smoke_render.py'), `from PIL import Image, ImageDraw, ImageFont\nimg=Image.open(${JSON.stringify(relative)}).convert('RGBA')\ncanvas=Image.new('RGB',(700,420),'white')\ncanvas.paste(img,(20,20),img)\ndraw=ImageDraw.Draw(canvas)\nfont=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',28)\ndraw.text((20,300),'素材下载与中文绘图验证',font=font,fill='black')\ncanvas.save('smoke_card.png')\n`);
const result = await runPythonScript(conversation, 'smoke_render.py', [asset.path], 60, undefined, ['smoke_card.png']);
if (result.exitCode !== 0 || result.files.length !== 1) throw new Error(`脚本执行失败: ${result.stderr}`);
const store = new Store(':memory:');
const sent = [];
const reply = new ReplyRuntime(store, { send: async (item) => { sent.push(item.kind); return { id: `fake-${sent.length}` }; } });
await reply.send(conversation, 'group', undefined, 'image', result.files[0].path);
await reply.send(conversation, 'group', undefined, 'text', '图片已生成');
store.close();
if (sent.join(',') !== 'image,text') throw new Error('交付顺序错误');
console.log(JSON.stringify({ downloadedBytes: asset.size, renderedBytes: result.files[0].size, workerNetworkEnabled: result.network, simulatedDelivery: sent }));

