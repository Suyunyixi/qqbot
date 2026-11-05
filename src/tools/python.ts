import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readConfig } from '../config/settings.js';
import { resolveWorkspaceEntry, resolveWorkspaceFile, workspaceFor } from '../storage/workspace.js';

const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const resultSchema = z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), stdout: z.string().max(65536), stderr: z.string().max(65536), network: z.boolean(), files: z.array(z.object({ path: z.string().min(1).max(1024), data: z.string().max(71000000), size: z.number().int().min(0).max(MAX_FILE) })).max(128) });
type Input = { path: string; data: string };

function checkedRelative(name: string): string[] {
  if (!name || name.length > 1024 || name.includes('\\') || name.includes('\0') || name.startsWith('/')) throw new Error('输出路径无效');
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('输出路径无效');
  return parts;
}
function saveOutput(root: string, name: string, bytes: Buffer): string {
  const parts = checkedRelative(name); const filename = parts.pop()!;
  let parent = fs.realpathSync(root);
  for (const part of parts) {
    parent = path.join(parent, part);
    try { fs.mkdirSync(parent); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('输出路径包含符号链接');
  }
  const target = path.join(parent, filename);
  try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('输出目标不是普通文件'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const temporary = path.join(parent, `.python-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, target); } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
  return target;
}

async function callRunner(request: { script: string; files: Input[]; timeoutSeconds: number; network?: boolean; outputs?: string[] }, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout((request.timeoutSeconds + 930) * 1000);
  const response = await fetch(new URL('/run', readConfig().tools.pythonRunnerUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const payload: unknown = await response.json();
  if (!response.ok) throw new Error(`Python 沙箱错误：${typeof payload === 'object' && payload && 'error' in payload ? String(payload.error) : response.status}`);
  return resultSchema.parse(payload);
}

function exportResults(conversationId: string, result: z.infer<typeof resultSchema>, prefix = '') {
  if (result.exitCode !== 0 || result.timedOut) return { ...result, files: [] };
  const root = workspaceFor(conversationId); let total = 0;
  const outputs = result.files.map((item) => {
    checkedRelative(item.path);
    const bytes = Buffer.from(item.data, 'base64'); total += bytes.length;
    if (bytes.length !== item.size || total > MAX_TOTAL || bytes.toString('base64') !== item.data) throw new Error('Python 沙箱返回的文件无效');
    return { name: prefix + item.path, bytes };
  });
  const files = outputs.map(({ name, bytes }) => ({ path: saveOutput(root, name, bytes), virtualPath: `/${name}`, size: bytes.length }));
  return { ...result, files };
}

function gatherFiles(conversationId: string, names: string[]): Input[] {
  const root = fs.realpathSync(workspaceFor(conversationId));
  const files: Input[] = []; const seen = new Set<string>(); let total = 0;
  const add = (actual: string) => {
    const stat = fs.lstatSync(actual);
    if (stat.isSymbolicLink()) throw new Error('输入目录不能包含符号链接');
    if (stat.isDirectory()) { for (const entry of fs.readdirSync(actual)) add(path.join(actual,entry)); return; }
    if (!stat.isFile()) throw new Error('输入只能是普通文件或目录');
    const relative = path.relative(root, actual).split(path.sep).join('/'); checkedRelative(relative);
    if (seen.has(relative)) return; seen.add(relative);
    if (stat.size > MAX_FILE) throw new Error('输入文件大小超限');
    const data = fs.readFileSync(actual); total += data.length;
    if (data.length > MAX_FILE || total > MAX_TOTAL || files.length >= 127) throw new Error('输入文件数量或大小超限');
    files.push({ path: relative, data: data.toString('base64') });
  };
  for (const name of names) add(resolveWorkspaceEntry(conversationId, name));
  return files;
}
export async function runPythonScript(conversationId: string, script: string, inputs: string[], timeoutSeconds: number, signal?: AbortSignal, outputs?: string[]) {
  const root = fs.realpathSync(workspaceFor(conversationId));
  const files = gatherFiles(conversationId, [script, ...inputs]);
  const actualScript = resolveWorkspaceFile(conversationId, script);
  const relativeScript = path.relative(root, actualScript).split(path.sep).join('/');
  return exportResults(conversationId, await callRunner({ script: relativeScript, files, timeoutSeconds, network:readConfig().sandbox.permissions.network, outputs }, signal));
}
export async function runShellCommand(conversationId: string, command: string, inputs: string[], timeoutSeconds: number, signal?: AbortSignal, outputs?: string[]) {
  const script = `.command-${randomUUID()}.sh`;
  const files = [{path:script,data:Buffer.from(command).toString('base64')}, ...gatherFiles(conversationId, inputs)];
  return exportResults(conversationId, await callRunner({script,files,timeoutSeconds,network:readConfig().sandbox.permissions.network,outputs},signal));
}

export async function renderImageCard(conversationId: string, data: unknown, signal?: AbortSignal) {
  const script = fs.readFileSync(path.resolve(process.cwd(), 'assets/card_image.py'));
  const files = [{ path: 'render.py', data: script.toString('base64') }, { path: 'card.json', data: Buffer.from(JSON.stringify(data)).toString('base64') }];
  const result = exportResults(conversationId, await callRunner({ script: 'render.py', files, timeoutSeconds: 30 }, signal), `cards/${randomUUID()}/`);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`图片渲染失败：${result.stderr || result.stdout || '超时'}`);
  const image = result.files.find((file) => file.virtualPath.endsWith('/card.png'));
  if (!image) throw new Error('图片渲染没有生成文件');
  return image;
}

/** QQ image uploads expect a raster image, so render SVG inside the sandbox. */
export async function rasterizeSvg(conversationId: string, file: string, signal?: AbortSignal) {
  const actual = resolveWorkspaceFile(conversationId, file);
  if (fs.statSync(actual).size > MAX_FILE) throw new Error('SVG 文件大小超限');
  const script = fs.readFileSync(path.resolve(process.cwd(), 'assets/svg_to_png.py'));
  const files = [{ path: 'convert.py', data: script.toString('base64') }, { path: 'image.svg', data: fs.readFileSync(actual).toString('base64') }];
  const result = exportResults(conversationId, await callRunner({ script: 'convert.py', files, timeoutSeconds: 30 }, signal), `converted/${randomUUID()}/`);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`SVG 转 PNG 失败：${result.stderr || result.stdout || '超时'}`);
  const image = result.files.find((entry) => entry.virtualPath.endsWith('/image.png'));
  if (!image) throw new Error('SVG 转换未生成 PNG');
  return image;
}

export async function checkPythonRunner(): Promise<void> {
  const script = "import socket, subprocess\ntry:\n socket.socket()\n raise RuntimeError('network unexpectedly enabled')\nexcept PermissionError:\n pass\nassert subprocess.check_output(['/bin/sh','-c','printf subprocess-ok']).decode() == 'subprocess-ok'\nfrom PIL import Image, ImageFont\nimport cairosvg\nImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 18)\nprint('python-sandbox-ok')\n";
  const result = await callRunner({ script: 'check.py', files: [{ path: 'check.py', data: Buffer.from(script).toString('base64') }], timeoutSeconds: 10 });
  if (result.exitCode !== 0 || !result.stdout.includes('python-sandbox-ok')) throw new Error(result.stderr || 'Python 沙箱自检失败');
}
