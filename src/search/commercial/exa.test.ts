import { describe, it, expect } from 'vitest';
import { ExaEngine, type ExaFetcher } from './exa.js';

/**
 * Exa 引擎单元测试（假 Key + mock Exa API 响应，不打真实外网）。
 * 覆盖：结果解析与来源标注、请求体契约（type/contents/numResults）、
 * 鉴权熔断、未配置跳过、URL 过滤。
 */

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> };

function res(status: number, body?: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function makeEngine(plan: FakeResponse[], key = 'exa-test-key') {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const headers: Record<string, string>[] = [];
  const fn: ExaFetcher = async (url, init) => {
    urls.push(url);
    bodies.push(init.body ? JSON.parse(init.body) : null);
    headers.push(init.headers ?? {});
    const next = plan.shift();
    if (!next) throw new Error(`意外的额外请求: ${url}`);
    return next;
  };
  const engine = new ExaEngine({ fetcher: fn, getApiKey: async () => key });
  return { engine, urls, bodies, headers };
}

describe('ExaEngine', () => {
  it('解析 results：title/url/highlights → SearchResult，请求体含 type/contents/numResults', async () => {
    const { engine, urls, bodies, headers } = makeEngine([
      res(200, {
        results: [
          { title: 'Result A', url: 'https://a.example/1', highlights: ['sentence a'] },
          { title: 'Result B', url: 'https://b.example/2', highlights: ['', 'sentence b'] },
          { title: 'Result C', url: 'https://c.example/3', summary: 'summary c' },
        ],
      }),
    ]);
    const results = await engine.search('q', 10);
    expect(results).toEqual([
      { title: 'Result A', url: 'https://a.example/1', snippet: 'sentence a', engines: ['commercial:exa'] },
      { title: 'Result B', url: 'https://b.example/2', snippet: 'sentence b', engines: ['commercial:exa'] },
      { title: 'Result C', url: 'https://c.example/3', snippet: 'summary c', engines: ['commercial:exa'] },
    ]);
    expect(urls[0]).toBe('https://api.exa.ai/search');
    expect(bodies[0]).toMatchObject({
      query: 'q',
      type: 'auto',
      contents: { highlights: { highlightsPerUrl: 1 } },
      numResults: 10,
    });
    expect(headers[0].authorization).toBe('Bearer exa-test-key');
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
    const engine = new ExaEngine({ fetcher: async () => { throw new Error('不应发起请求'); }, getApiKey: async () => null });
    expect(await engine.search('q', 10)).toEqual([]);
    expect(await engine.status()).toMatchObject({ state: 'not_configured' });
  });

  it('非 http(s) URL 与缺 title 的条目被过滤；响应缺 results 返回空', async () => {
    const { engine } = makeEngine([
      res(200, {
        results: [
          { title: 'bad proto', url: 'ftp://x.example/1' },
          { url: 'https://b.example/2', highlights: ['no title'] },
          { title: 'ok', url: 'https://c.example/3', highlights: ['fine'] },
        ],
      }),
      res(200, {}),
    ]);
    const results = await engine.search('q', 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://c.example/3');
    expect(await engine.search('q2', 10)).toEqual([]);
  });

  it('非 401 的失败状态码 → 抛错但不熔断；maxResults 超上限被钳制', async () => {
    const { engine, bodies } = makeEngine([res(429), res(200, { results: [] })]);
    await expect(engine.search('q', 10)).rejects.toThrow('HTTP 429');
    expect(await engine.status()).toMatchObject({ state: 'ok' });
    await engine.search('q', 500);
    expect((bodies[1] as { numResults: number }).numResults).toBe(50);
  });
});
