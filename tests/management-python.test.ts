import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-management-'));
const { initConfig } = await import('../src/config/settings.js');
const { Store } = await import('../src/storage/store.js');
const { persona } = await import('../src/agent/runtime.js');
const { handlePersona } = await import('../src/admin/api.js');
const { workspaceFor } = await import('../src/storage/workspace.js');
const { runPythonScript } = await import('../src/tools/python.js');
initConfig();

describe('人格管理', () => {
  it('首次导入后保存到 SQLite，并对后续读取立即生效', () => {
    const store = new Store(':memory:');
    expect(persona(store).length).toBeGreaterThan(0);
    store.setAppSetting('persona', '新的主人格');
    expect(persona(store)).toBe('新的主人格');
    store.close();
  });
  it('管理接口只接受本机同源有效请求', async () => {
    const store = new Store(':memory:');
    const server = http.createServer((req, res) => void handlePersona(req, res, store));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('server address');
    const url = `http://127.0.0.1:${address.port}/api/persona`;
    try {
      const rejected = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ persona: 'evil' }) });
      expect(rejected.status).toBe(403);
      const saved = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${address.port}` }, body: JSON.stringify({ persona: '可靠的人格' }) });
      expect(saved.status).toBe(200);
      expect((await (await fetch(url)).json()) as unknown).toEqual({ persona: '可靠的人格' });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
  });
});

describe('Python 沙箱文件交换', () => {
  it('传入当前会话脚本和数据，回写输出文件到同一工作区', async () => {
    const root = workspaceFor('python-a');
    fs.writeFileSync(path.join(root, 'script.py'), 'print(1)'); fs.writeFileSync(path.join(root, 'input.txt'), 'source');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { script: string; files: Array<{ path: string; data: string }> };
      expect(request.script).toBe('script.py');
      expect(request.files.map((f) => f.path)).toEqual(['script.py', 'input.txt']);
      return new Response(JSON.stringify({ exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', network: false, files: [{ path: 'out/result.txt', data: Buffer.from('result').toString('base64'), size: 6 }] }), { status: 200 });
    });
    try {
      const result = await runPythonScript('python-a', '/script.py', ['input.txt'], 10);
      expect(result.files[0]?.virtualPath).toBe('/out/result.txt');
      expect(fs.readFileSync(path.join(root, 'out/result.txt'), 'utf8')).toBe('result');
      expect(() => fs.readFileSync(path.join(workspaceFor('python-b'), 'out/result.txt'))).toThrow();
    } finally { fetchSpy.mockRestore(); }
  });
  it('拒绝沙箱返回越界路径，失败时不写入产物', async () => {
    const root = workspaceFor('python-failure'); fs.writeFileSync(path.join(root, 'a.py'), '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ exitCode: 0, timedOut: false, stdout: '', stderr: '', network: false, files: [{ path: '../escape', data: 'YQ==', size: 1 }] }), { status: 200 }));
    try { await expect(runPythonScript('python-failure', 'a.py', [], 10)).rejects.toThrow('输出路径无效'); }
    finally { fetchSpy.mockRestore(); }
  });
});
