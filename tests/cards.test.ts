import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.BOT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-card-test-'));
const { initConfig } = await import('../src/config/settings.js');
const { buildNativeArk } = await import('../src/domain/card.js');
const { Store } = await import('../src/storage/store.js');
const { ReplyRuntime } = await import('../src/delivery/reply.js');
const { QQAdapter } = await import('../src/platform/qq/adapter.js');
initConfig();

describe('QQ 原生卡片', () => {
  it('按官方 23 模板构造多条链接列表', () => {
    const ark = buildNativeArk({ kind: 'list', title: '榜单', items: [{ text: '视频一', url: 'https://www.bilibili.com/video/BV1example' }, { text: '视频二' }] });
    expect(ark.template_id).toBe(23);
    expect(ark.kv.find((item) => item.key === '#LIST#')?.obj).toEqual([
      { obj_kv: [{ key: 'desc', value: '视频一' }, { key: 'link', value: 'https://www.bilibili.com/video/BV1example' }] },
      { obj_kv: [{ key: 'desc', value: '视频二' }] },
    ]);
    expect(() => buildNativeArk({ kind: 'list', title: '榜单', items: [] })).toThrow('至少一条');
  });
  it('通过统一回复队列使用官方 SDK 发送 24 模板，并记录结果', async () => {
    const store = new Store(':memory:');
    const adapter = new QQAdapter({ appId: 'test-app', appSecret: 'test-secret' }, store, () => {});
    adapter.connected = true;
    const send = vi.spyOn(adapter.bot, 'send').mockResolvedValue({ id: 'qq-card-1', timestamp: new Date().toISOString() });
    store.record({ id: 'in-1', conversationId: 'g', scope: 'group', senderId: 'u', content: '卡片', timestamp: new Date().toISOString(), isMention: true, attachments: [] });
    const reply = new ReplyRuntime(store, adapter);
    await reply.send('g', 'group', 'in-1', 'card', JSON.stringify({ kind: 'link', title: '视频', url: 'https://www.bilibili.com/video/BV1example' }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ msgType: 3, target: { scope: 'group', targetId: 'g', msgId: 'in-1' }, ark: { template_id: 24 } });
    expect(store.recent('g', 10).at(-1)?.content).toBe('[card] 视频');
    store.close();
  });
});
