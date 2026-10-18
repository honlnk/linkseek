import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * fallback 分流与兜底触发逻辑测试（mock SearXNG 与商业兜底 manager，不打真实外网）。
 * 覆盖：auto 且降级链有结果不触发兜底；auto 全空触发兜底；cloud 跳过降级链直打商业引擎；
 * 以及全抛错时兜底命中/未命中的行为。
 */

vi.mock('./searxng.js', () => ({
  searchProvider: { searchDetailed: vi.fn() },
}));

vi.mock('./commercial/manager.js', () => ({
  runCommercialFallback: vi.fn(),
}));

import { searchWithFallback } from './fallback.js';
import { searchProvider } from './searxng.js';
import { runCommercialFallback } from './commercial/manager.js';

const searchDetailed = vi.mocked(searchProvider.searchDetailed);
const commercialFallback = vi.mocked(runCommercialFallback);

const searxngResult = { title: 'SearXNG 结果', url: 'https://s.com/a', snippet: '' };
const commercialResult = { title: '商业兜底结果', url: 'https://c.com/b', snippet: '' };

beforeEach(() => {
  vi.clearAllMocks();
  // 按 opts 模拟真实 SearXngProvider 的 attempt 标签（原参数 / engines=bing,google）
  searchDetailed.mockImplementation(async (_q: string, opts: { engines?: string } = {}) => {
    const label = opts.engines ? 'engines=bing,google' : '原参数';
    return {
      results: [],
      diagnostics: { attempts: [{ label, resultCount: 0 }], unresponsiveEngines: [] },
    };
  });
  commercialFallback.mockResolvedValue({ results: [], attempts: [] });
});

describe('provider=auto（默认路径）', () => {
  it('降级链有结果 → 不触发商业兜底', async () => {
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([searxngResult]);
    expect(commercialFallback).not.toHaveBeenCalled();
  });

  it('降级链全空且列表有引擎 → 触发兜底；命中则返回商业结果并标注尝试', async () => {
    commercialFallback.mockResolvedValue({
      results: [commercialResult],
      attempts: [{ label: '商业兜底:devin', kind: 'commercial' as const, resultCount: 1 }],
      hitEngine: 'devin',
    });
    const outcome = await searchWithFallback('q');
    expect(commercialFallback).toHaveBeenCalledWith('q', 10);
    expect(outcome.results).toEqual([commercialResult]);
    const labels = outcome.diagnostics.attempts.map((a) => a.label);
    expect(labels).toContain('商业兜底:devin');
    expect(labels).toContain('engines=bing,google');
  });

  it('降级链全空、兜底也无结果 → 返回空，commercial 尝试并入诊断', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [
        { label: '商业兜底:devin', kind: 'commercial' as const, resultCount: 0 },
      ],
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([]);
    expect(outcome.diagnostics.attempts.map((a) => a.label)).toContain('商业兜底:devin');
  });

  it('降级链全部抛错且兜底命中 → 返回兜底结果（SearXNG 整体故障时的救命路径）', async () => {
    searchDetailed.mockRejectedValue(new Error('SearXNG 返回 HTTP 502'));
    commercialFallback.mockResolvedValue({
      results: [commercialResult],
      attempts: [{ label: '商业兜底:devin', kind: 'commercial' as const, resultCount: 1 }],
      hitEngine: 'devin',
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([commercialResult]);
  });

  it('降级链全部抛错且兜底未命中 → 仍抛出原错误（保持既有语义）', async () => {
    searchDetailed.mockRejectedValue(new Error('SearXNG 返回 HTTP 502'));
    await expect(searchWithFallback('q')).rejects.toThrow('HTTP 502');
  });
});

describe('provider=cloud（直打商业引擎）', () => {
  it('跳过 SearXNG 降级链，直接调 manager', async () => {
    commercialFallback.mockResolvedValue({
      results: [commercialResult],
      attempts: [{ label: '商业兜底:devin', kind: 'commercial' as const, resultCount: 1 }],
      hitEngine: 'devin',
    });
    const outcome = await searchWithFallback('q', { maxResults: 5 }, 'cloud');
    expect(searchDetailed).not.toHaveBeenCalled();
    expect(commercialFallback).toHaveBeenCalledWith('q', 5);
    expect(outcome.results).toEqual([commercialResult]);
  });

  it('商业引擎无结果 → 返回空（不回落 SearXNG）', async () => {
    const outcome = await searchWithFallback('q', {}, 'cloud');
    expect(searchDetailed).not.toHaveBeenCalled();
    expect(outcome.results).toEqual([]);
  });
});
