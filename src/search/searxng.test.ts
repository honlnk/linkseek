import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SearXNG 适配器结果解析测试（mock undici 的 fetch，不打真实 SearXNG）。
 * 2026-11 B 站接入新增覆盖：author/publishedDate 宽容透出（缺失/非字符串/空白 → undefined）、
 * time_range=week 参数透传。
 */
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: vi.fn(),
}));

import { fetch } from 'undici';
import { SearXngProvider } from './searxng.js';

const fetchMock = vi.mocked(fetch);

/** 构造 undici fetch 的成功 Response 替身 */
function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Parameters<
    typeof fetchMock.mockResolvedValue
  >[0];
}

/** 构造一条 SearXNG 原始结果（可覆盖部分字段） */
function rawResult(overrides: Record<string, unknown> = {}) {
  return {
    title: '万物真相句',
    url: 'http://www.bilibili.com/video/av117500691879197',
    content: '',
    engines: ['bilibili'],
    score: 1,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('author / publishedDate 宽容透出', () => {
  it('字符串字段原样透出（B 站场景）', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [
          rawResult({ author: '掌舵万物L', publishedDate: '2026-10-25T08:53:12' }),
        ],
      }),
    );
    const provider = new SearXngProvider('http://searxng.test');
    const [r] = await provider.search('万物论');
    expect(r.author).toBe('掌舵万物L');
    expect(r.publishedDate).toBe('2026-10-25T08:53:12');
  });

  it('字段缺失 → undefined（general 引擎场景，输出不携带）', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [rawResult()] }));
    const provider = new SearXngProvider('http://searxng.test');
    const [r] = await provider.search('q');
    expect(r.author).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
  });

  it('非字符串类型（数字/对象/null）→ undefined', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [
          rawResult({ author: 42, publishedDate: { date: '2026-10-25' } }),
          rawResult({ author: null, publishedDate: null, url: 'http://x.com/2' }),
        ],
      }),
    );
    const provider = new SearXngProvider('http://searxng.test');
    const results = await provider.search('q');
    expect(results[0].author).toBeUndefined();
    expect(results[0].publishedDate).toBeUndefined();
    expect(results[1].author).toBeUndefined();
    expect(results[1].publishedDate).toBeUndefined();
  });

  it('空字符串 / 纯空白 → undefined', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [rawResult({ author: '   ', publishedDate: '' })],
      }),
    );
    const provider = new SearXngProvider('http://searxng.test');
    const [r] = await provider.search('q');
    expect(r.author).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
  });
});

describe('time_range 参数透传', () => {
  it('timeRange=week 原样透传给 SearXNG', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [rawResult()] }));
    const provider = new SearXngProvider('http://searxng.test');
    await provider.search('万物论', { timeRange: 'week', engines: 'bilibili' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('time_range=week');
    expect(url).toContain('engines=bilibili');
  });
});
