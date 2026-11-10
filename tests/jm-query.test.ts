import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tools/python.js', () => ({ runBundledJson: vi.fn(), runBundledPython: vi.fn() }));
vi.mock('../src/config/settings.js', () => ({ readConfig: () => ({ tools: { python: true }, sandbox: { permissions: { process: true } } }) }));

import { queryJm } from '../src/tools/jm.js';
import { runBundledJson } from '../src/tools/python.js';

describe('JM 查询工具', () => {
  beforeEach(() => vi.clearAllMocks());
  it('把搜索、排行和详情参数交给隔离执行器', async () => {
    vi.mocked(runBundledJson).mockResolvedValue({ source: 'JM', items: [] });
    for (const input of [
      { action: 'search', query: '测试', searchBy: 'author', page: 2 },
      { action: 'ranking', period: 'week', order: 'views' },
      { action: 'detail', albumId: '123456' },
    ] as const) {
      await expect(queryJm(input)).resolves.toMatchObject({ source: 'JM' });
      expect(runBundledJson).toHaveBeenLastCalledWith('jm_query.py', input, undefined);
    }
  });
  it('缺少搜索词或编号无效时不访问执行器', async () => {
    await expect(queryJm({ action: 'search', query: '  ' })).rejects.toThrow('搜索词');
    await expect(queryJm({ action: 'detail', albumId: '../x' })).rejects.toThrow('编号');
    expect(runBundledJson).not.toHaveBeenCalled();
  });
  it('查询失败时如实向上返回错误', async () => {
    vi.mocked(runBundledJson).mockRejectedValue(new Error('站点无法访问'));
    await expect(queryJm({ action: 'ranking' })).rejects.toThrow('站点无法访问');
  });
});
