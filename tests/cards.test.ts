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
const { splitMarkdown } = await import('../src/delivery/markdown.js');
initConfig();

describe('QQ 原生卡片', () => {
  it('普通回复使用 QQ 原生 Markdown 消息，保留被动回复目标', async () => {
    const store = new Store(':memory:');
    const adapter = new QQAdapter({ appId: 'test-app', appSecret: 'test-secret' }, store, () => {});
    adapter.connected = true;
    const markdown = vi.spyOn(adapter.bot, 'sendMarkdown');
    const send = vi.spyOn(adapter.bot, 'send').mockResolvedValue({ id: 'qq-md-1', timestamp: new Date().toISOString() });
    const plain = vi.spyOn(adapter.bot, 'sendText');
    store.record({ id: 'in-md', conversationId: 'g', scope: 'group', senderId: 'u', content: '格式', timestamp: new Date().toISOString(), isMention: true, attachments: [] });
    await new ReplyRuntime(store, adapter).send('g', 'group', 'in-md', 'text', '# 标题\n\n**加粗**\n\n- 一项');
    expect(markdown).toHaveBeenCalledWith({ scope: 'group', targetId: 'g', msgId: 'in-md' }, '# 标题\n\n**加粗**\n\n- 一项');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ msgType: 2, markdown: { content: '# 标题\n\n**加粗**\n\n- 一项' } }));
    expect(plain).not.toHaveBeenCalled();
    store.close();
  });
  it('长 Markdown 的代码块跨消息保持闭合和语言标记', () => {
    const text = '说明\n\n```python\n' + Array.from({length:30}, (_, i) => `print(${i})`).join('\n') + '\n```\n\n结束';
    const chunks = splitMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks.join('\n')).toContain('print(29)');
  });
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
