import { describe, it, expect } from 'vitest';
import { BraveEngine, type BraveFetcher } from './brave.js';

/**
 * Brave 引擎单元测试（假 Key + mock Brave API 响应，不打真实外网）。
 * 覆盖：结果解析与来源标注、鉴权熔断、未配置跳过、URL 过滤。
 */

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> };

function res(status: number, body?: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function makeEngine(plan: FakeResponse[], key = 'BSA-test-key') {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fn: BraveFetcher = async (url, init) => {
    urls.push(url);
    headers.push(init.headers ?? {});
    const next = plan.shift();
    if (!next) throw new Error(`意外的额外请求: ${url}`);
    return next;
  };
  const engine = new BraveEngine({ fetcher: fn, getApiKey: async () => key });
  return { engine, urls, headers };
}

describe('BraveEngine', () => {
  it('解析 web.results：title/url/description → SearchResult，标注来源引擎', async () => {
    const { engine, urls, headers } = makeEngine([
      res(200, {
        web: {
          results: [
            { title: 'Result A', url: 'https://a.example/1', description: 'desc a' },
            { title: 'Result B', url: 'https://b.example/2', text: 'text b' },
          ],
        },
      }),
    ]);
    const results = await engine.search('q', 10);
    expect(results).toEqual([
      { title: 'Result A', url: 'https://a.example/1', snippet: 'desc a', engines: ['commercial:brave'] },
      { title: 'Result B', url: 'https://b.example/2', snippet: 'text b', engines: ['commercial:brave'] },
    ]);
    expect(urls[0]).toContain('https://api.search.brave.com/res/v1/web/search?q=q&count=10');
    expect(headers[0]['x-subscription-token']).toBe('BSA-test-key');
  });

  it('401 → 抛错并熔断；后续 available() 为 false；reset() 恢复', async () => {
    const { engine } = makeEngine([res(401)]);
    await expect(engine.search('q', 10)).rejects.toThrow('鉴权被拒');
    expect(await engine.status()).toMatchObject({ state: 'invalid' });
    expect(await engine.available()).toBe(false);
    engine.reset();
    expect(await engine.status()).toMatchObject({ state: 'ok' });
  });

  it('无 Key（未配置）→ search 返回空，状态 not_configured', async () => {
    const engine = new BraveEngine({ fetcher: async () => { throw new Error('不应发起请求'); }, getApiKey: async () => null });
    expect(await engine.search('q', 10)).toEqual([]);
    expect(await engine.status()).toMatchObject({ state: 'not_configured' });
  });

  it('非 http(s) URL 与缺 title 的条目被过滤；响应缺 web.results 返回空', async () => {
    const { engine } = makeEngine([
      res(200, {
        web: {
          results: [
            { title: 'bad proto', url: 'ftp://x.example/1', description: '' },
            { url: 'https://b.example/2', description: '' },
            { title: 'ok', url: 'https://c.example/3', description: '' },
          ],
        },
      }),
      res(200, { query: { original: 'q' } }),
    ]);
    const results = await engine.search('q', 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://c.example/3');
    expect(await engine.search('q2', 10)).toEqual([]);
  });

  it('非 401 的失败状态码 → 抛错但熔断', async () => {
    const { engine } = makeEngine([res(429)]);
    await expect(engine.search('q', 10)).rejects.toThrow('HTTP 429');
    expect(await engine.status()).toMatchObject({ state: 'ok' });
  });
});
