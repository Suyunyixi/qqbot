import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { HumanMessage } from '@langchain/core/messages';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-management-'));
const { initConfig } = await import('../src/config/settings.js');
const { Store } = await import('../src/storage/store.js');
const { persona } = await import('../src/agent/runtime.js');
const { openCheckpointSaver, pruneConversationCheckpoints } = await import('../src/storage/checkpoints.js');
const { compactCheckpointDatabase } = await import('../src/storage/checkpoint-maintenance.js');
const { handlePersona } = await import('../src/admin/api.js');
const { workspaceFor } = await import('../src/storage/workspace.js');
const { WorkspaceBackend } = await import('../src/storage/backend.js');
const { ReplyRuntime } = await import('../src/delivery/reply.js');
const { TaskManager } = await import('../src/agent/task-manager.js');
const { makeTools } = await import('../src/tools/registry.js');
const { runPythonScript } = await import('../src/tools/python.js');
initConfig();

describe('检查点图片存储', () => {
  it('图片内容只存文件，读取检查点时恢复原内容', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-checkpoint-images-'));
    const saver=openCheckpointSaver(path.join(dir,'checkpoint.sqlite'),path.join(dir,'images'));
    const image=`data:image/png;base64,${Buffer.from('测试图片内容').toString('base64')}`;
    const [kind,encoded]=await saver.serde.dumpsTyped({messages:[new HumanMessage({content:[{type:'image_url',image_url:{url:image}}]})]});
    expect(Buffer.from(encoded).toString()).not.toContain(image);
    expect(fs.readdirSync(path.join(dir,'images'))).toHaveLength(1);
    const restored=await saver.serde.loadsTyped(kind,encoded) as {messages:HumanMessage[]};
    expect(JSON.stringify(restored.messages[0]?.content)).toContain(image);
    saver.db.close();
  });
  it('只清理完成会话的旧检查点，保留最新记录和后台任务', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-checkpoint-clean-'));const saver=openCheckpointSaver(path.join(dir,'checkpoint.sqlite'));
    await saver.getTuple({configurable:{thread_id:'group:g'}});
    const insert=saver.db.prepare("INSERT INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,type,checkpoint,metadata) VALUES(?,'',?,'json','{}','{}')");
    for(let i=1;i<=5;i++)insert.run('group:g',String(i));
    insert.run('task:ongoing','1');
    const write=saver.db.prepare("INSERT INTO writes(thread_id,checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,type,value) VALUES(?,'',?,'x','',0,'x','json','{}')");
    for(let i=1;i<=5;i++)write.run('group:g',String(i));write.run('task:ongoing','1');
    expect(pruneConversationCheckpoints(saver,'group:g')).toBe(2);
    expect(saver.db.prepare("SELECT checkpoint_id FROM checkpoints WHERE thread_id='group:g' ORDER BY checkpoint_id").all()).toEqual([{checkpoint_id:'3'},{checkpoint_id:'4'},{checkpoint_id:'5'}]);
    expect(saver.db.prepare("SELECT count(*) AS n FROM writes WHERE thread_id='task:ongoing'").get()).toEqual({n:1});
    expect(()=>pruneConversationCheckpoints(saver,'task:ongoing')).toThrow();saver.db.close();
  });
  it('整理前备份原数据库，保留消息、任务检查点及最近会话状态', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-checkpoint-backup-'));const botFile=path.join(dir,'bot.sqlite');const checkpointFile=path.join(dir,'checkpoint.sqlite');const backupFile=path.join(dir,'backup.sqlite');
    const bot=new Store(botFile);bot.record({id:'m',conversationId:'g',scope:'group',senderId:'u',content:'原始聊天',timestamp:new Date().toISOString(),isMention:false,attachments:[]});bot.close();
    const saver=openCheckpointSaver(checkpointFile);await saver.getTuple({configurable:{thread_id:'group:g'}});
    const insert=saver.db.prepare("INSERT INTO checkpoints(thread_id,checkpoint_ns,checkpoint_id,type,checkpoint,metadata) VALUES(?,'',?,'json','{}','{}')");
    for(let i=1;i<=5;i++)insert.run('group:g',String(i));insert.run('task:kept','1');saver.db.close();
    const result=await compactCheckpointDatabase(checkpointFile,botFile,backupFile);expect(result.removed).toBe(2);
    const old=openCheckpointSaver(backupFile);expect(old.db.prepare('SELECT count(*) AS n FROM checkpoints').get()).toEqual({n:6});old.db.close();
    const current=openCheckpointSaver(checkpointFile);expect(current.db.prepare('SELECT count(*) AS n FROM checkpoints').get()).toEqual({n:4});current.db.close();
    const reopened=new Store(botFile);expect(reopened.recent('g',10)[0]?.content).toBe('原始聊天');reopened.close();
  });
});

describe('人格管理', () => {
  it('首次导入后保存到 SQLite，并对后续读取立即生效', () => {
    const store = new Store(':memory:');
    expect(persona(store).length).toBeGreaterThan(0);
    store.setAppSetting('persona', '新的主人格');
    expect(persona(store)).toBe('新的主人格');
    store.close();
  });
  it('人格修改留存版本与来源，保存相同内容不会增加版本', () => {
    const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'qq-persona-audit-')),'persona.sqlite');
    const initial=new Store(file);expect(initial.setPersona('初始人格','admin')).toBe(true);
    expect(initial.setPersona('初始人格','admin')).toBe(false);initial.setPersona('更新人格','admin');initial.close();
    const reopened=new Store(file);expect(reopened.getAppSetting('persona')).toBe('更新人格');
    expect(reopened.personaRevisions()).toMatchObject([{source:'admin',actor_id:null},{source:'admin',actor_id:null}]);reopened.close();
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
      expect((await (await fetch(url)).json()) as unknown).toMatchObject({ persona: '可靠的人格', revisions: [{ source: 'admin' }] });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); }
  });
});

describe('Python 沙箱文件交换', () => {
  it('Deep Agents 写入真实工作区路径后，相同路径和相对路径均能发送', async () => {
    const id = 'write-deliver'; const root = workspaceFor(id); const physical = path.join(root, 'created.txt');
    const backend = new WorkspaceBackend(id);
    expect((await backend.write(physical, 'content')).error).toBeUndefined();
    expect(fs.readFileSync(physical, 'utf8')).toBe('content');
    expect((await backend.glob(path.join(root, '*.txt'))).files).toHaveLength(1);
    const store = new Store(':memory:'); const sent = vi.fn(async () => ({ id: 'ok' }));
    const reply = new ReplyRuntime(store, { send: sent }); const tasks = new TaskManager(store, async () => '', async () => {});
    try {
      const media = makeTools({ conversationId: id, scope: 'group', store, reply, tasks, background: false }).find((item) => item.name === 'send_media')!;
      const a = JSON.parse(String(await media.invoke({ file: physical, kind: 'file' }))) as { ok: boolean };
      const b = JSON.parse(String(await media.invoke({ file: 'created.txt', kind: 'file' }))) as { ok: boolean };
      expect(a.ok).toBe(true); expect(b.ok).toBe(true); expect(sent).toHaveBeenCalledTimes(2);
      expect(sent.mock.calls[0]?.[0].content).toBe(fs.realpathSync(physical));
      expect(() => backend.write(path.join(workspaceFor('other-conversation'), 'private.txt'), 'x')).toThrow('当前会话');
    } finally { tasks.stop(); store.close(); }
  });
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
