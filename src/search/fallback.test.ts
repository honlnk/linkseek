import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * fallback 统一搜索入口测试（mock SearXNG 与商业引擎 manager，不打真实外网）。
 * 2026-11 默认路径反转为「云端优先、本地兜底」后覆盖：
 * 云端命中不调本地；云端空/未配置/失败时本地接管；显式 engines 跳过云端；
 * 两边都空返回合并诊断；本地链全抛错时上抛本地错误且云端诊断保留。
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
const commercialResult = { title: '云端引擎结果', url: 'https://c.com/b', snippet: '' };
const cloudHit = {
  results: [commercialResult],
  attempts: [{ label: '云端引擎:devin', kind: 'commercial' as const, resultCount: 1 }],
  hitEngine: 'devin',
};

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

describe('默认路径（云端优先，不传 provider / provider=auto）', () => {
  it('云端命中 → 不调用 SearXNG', async () => {
    commercialFallback.mockResolvedValue(cloudHit);
    const outcome = await searchWithFallback('q');
    expect(commercialFallback).toHaveBeenCalledWith('q', 10);
    expect(outcome.results).toEqual([commercialResult]);
    expect(searchDetailed).not.toHaveBeenCalled();
  });

  it('云端按列表顺序命中即止（maxResults 正确透传）', async () => {
    commercialFallback.mockResolvedValue(cloudHit);
    const outcome = await searchWithFallback('q', { maxResults: 5 });
    expect(commercialFallback).toHaveBeenCalledTimes(1);
    expect(commercialFallback).toHaveBeenCalledWith('q', 5);
    expect(outcome.results).toEqual([commercialResult]);
  });

  it('云端返回空 → 本地降级链接管，诊断云端在前、本地在后', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [{ label: '云端引擎:devin', kind: 'commercial' as const, resultCount: 0 }],
    });
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([searxngResult]);
    const labels = outcome.diagnostics.attempts.map((a) => a.label);
    expect(labels.indexOf('云端引擎:devin')).toBeLessThan(labels.indexOf('原参数'));
  });

  it('云端未配置（manager 返回空）→ 直接本地搜索，行为与无云端部署一致', async () => {
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q');
    expect(commercialFallback).toHaveBeenCalledWith('q', 10);
    expect(searchDetailed).toHaveBeenCalled();
    expect(outcome.results).toEqual([searxngResult]);
  });

  it('云端全部引擎请求失败 → 仍进入本地链，本地命中则正常返回', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [
        { label: '云端引擎:devin', kind: 'commercial' as const, resultCount: -1, error: 'HTTP 502' },
      ],
    });
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([searxngResult]);
    expect(outcome.diagnostics.attempts.map((a) => a.label)).toContain('云端引擎:devin');
  });

  it('两边都空 → 返回空 + 合并诊断（云端与本地尝试都在）', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [{ label: '云端引擎:devin', kind: 'commercial' as const, resultCount: 0 }],
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([]);
    const labels = outcome.diagnostics.attempts.map((a) => a.label);
    expect(labels).toContain('云端引擎:devin');
    expect(labels).toContain('engines=bing,google');
  });

  it('两边都失败 → 抛出本地链最终错误，云端失败只入诊断（不掩盖也不替代本地错误）', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [
        { label: '云端引擎:devin', kind: 'commercial' as const, resultCount: -1, error: 'quota exhausted' },
      ],
    });
    searchDetailed.mockRejectedValue(new Error('SearXNG 返回 HTTP 502'));
    await expect(searchWithFallback('q')).rejects.toThrow('HTTP 502');
  });

  it('云端失败且本地链全空但未抛错 → 返回空而非上抛云端错误', async () => {
    commercialFallback.mockResolvedValue({
      results: [],
      attempts: [
        { label: '云端引擎:devin', kind: 'commercial' as const, resultCount: -1, error: 'timeout' },
      ],
    });
    const outcome = await searchWithFallback('q');
    expect(outcome.results).toEqual([]);
  });
});

describe('provider=cloud（历史别名，与默认同路径）', () => {
  it('行为与 auto 完全一致：云端优先 + 本地兜底', async () => {
    commercialFallback.mockResolvedValue(cloudHit);
    const outcome = await searchWithFallback('q', { maxResults: 5 }, 'cloud');
    expect(commercialFallback).toHaveBeenCalledWith('q', 5);
    expect(outcome.results).toEqual([commercialResult]);
    expect(searchDetailed).not.toHaveBeenCalled();
  });

  it('cloud 下云端未命中 → 同样回落本地链（语义更新：cloud 不再排除本地）', async () => {
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q', {}, 'cloud');
    expect(commercialFallback).toHaveBeenCalled();
    expect(searchDetailed).toHaveBeenCalled();
    expect(outcome.results).toEqual([searxngResult]);
  });
});

describe('显式指定 SearXNG 引擎（跳过云端）', () => {
  it('engines=bing → 不调云端，直接本地链，指定引擎被尊重', async () => {
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q', { engines: 'bing' });
    expect(commercialFallback).not.toHaveBeenCalled();
    expect(searchDetailed).toHaveBeenCalled();
    expect(outcome.results).toEqual([searxngResult]);
  });

  it('engines 指定 + provider=cloud → 仍跳过云端（engines 优先级最高）', async () => {
    searchDetailed.mockResolvedValue({
      results: [searxngResult],
      diagnostics: { attempts: [{ label: '原参数', resultCount: 1 }], unresponsiveEngines: [] },
    });
    const outcome = await searchWithFallback('q', { engines: 'bing' }, 'cloud');
    expect(commercialFallback).not.toHaveBeenCalled();
    expect(outcome.results).toEqual([searxngResult]);
  });

  it('engines 指定且本地失败 → 直接上抛本地错误（无云端尝试可兜底）', async () => {
    searchDetailed.mockRejectedValue(new Error('SearXNG 返回 HTTP 502'));
    await expect(searchWithFallback('q', { engines: 'bing' })).rejects.toThrow('HTTP 502');
  });
});
