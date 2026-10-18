import { describe, it, expect } from 'vitest';
import {
  DevinEngine,
  devinTokenExpiry,
  redactToken,
  toDevinSessionToken,
  type DevinFetcher,
} from './devin.js';

/**
 * Devin 引擎单元测试（全部注入假 fetcher / 假凭证，不打真实外网）。
 * 覆盖：双 host 故障转移、熔断判定、脱敏、过期解析、URL 白名单、防御性字段解析。
 */

type FakeResponse = { ok: boolean; status: number; json(): Promise<unknown> };

function res(status: number, body?: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** 按调用次序返回预设响应的 fetcher；记录实际请求过的 URL */
function makeFetcher(plan: FakeResponse[]): { fn: DevinFetcher; urls: string[] } {
  const urls: string[] = [];
  const fn: DevinFetcher = async (url) => {
    urls.push(url);
    const next = plan.shift();
    if (!next) throw new Error(`意外的额外请求: ${url}`);
    return next;
  };
  return { fn, urls };
}

function fakeJwt(exp?: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(exp !== undefined ? { exp } : { sub: 'x' })).toString(
    'base64url',
  );
  return `${header}.${payload}.sig`;
}

const TOKEN = fakeJwt(1893456000); // 2030-01-01

function makeEngine(plan: FakeResponse[], token = TOKEN) {
  const { fn, urls } = makeFetcher(plan);
  const engine = new DevinEngine({ fetcher: fn, getToken: async () => token });
  return { engine, urls };
}

describe('DevinEngine 双 host 故障转移', () => {
  it('首 host 500 → 次 host 命中，返回解析结果', async () => {
    const { engine, urls } = makeEngine([
      res(500),
      res(200, {
        results: [{ title: 'Result A', url: 'https://example.com/a', snippet: 'sa' }],
      }),
    ]);
    const results = await engine.search('vitest', 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: 'Result A', url: 'https://example.com/a' });
    expect(results[0].engines).toEqual(['commercial:devin']);
    expect(urls[0]).toContain('https://server.codeium.com/');
    expect(urls[1]).toContain('https://server.self-serve.windsurf.com/');
  });

  it('双 host 均 401 → 抛错并熔断，后续 available() 为 false', async () => {
    const { engine } = makeEngine([res(401), res(401)]);
    await expect(engine.search('q', 5)).rejects.toThrow('已失效');
    expect(await engine.status()).toMatchObject({ state: 'invalid' });
    expect(await engine.available()).toBe(false);
  });

  it('单 host 401（次 host 正常）→ 不熔断', async () => {
    const { engine } = makeEngine([
      res(401),
      res(200, { results: [{ title: 'T', url: 'https://e.com/x', snippet: '' }] }),
    ]);
    const results = await engine.search('q', 5);
    expect(results).toHaveLength(1);
    expect(await engine.status()).toMatchObject({ state: 'ok' });
  });

  it('reset() 清除熔断标记', async () => {
    const { engine } = makeEngine([res(401), res(401)]);
    await expect(engine.search('q', 5)).rejects.toThrow('已失效');
    engine.reset();
    expect((await engine.status()).state).not.toBe('invalid');
  });
});

describe('DevinEngine 响应解析', () => {
  it('空 results 数组 → 返回空；缺 results 字段 → 抛格式异常', async () => {
    const empty = makeEngine([res(200, { results: [] })]);
    expect(await empty.engine.search('q', 5)).toEqual([]);
    const broken = makeEngine([res(200, { unexpected: true })]);
    await expect(broken.engine.search('q', 5)).rejects.toThrow('格式异常');
  });

  it('URL 白名单：非 http(s) 与带 userinfo 的 URL 被丢弃', async () => {
    const { engine } = makeEngine([
      res(200, {
        results: [
          { title: 'js', url: 'javascript:alert(1)', snippet: '' },
          { title: 'cred', url: 'https://user:pass@evil.com/x', snippet: '' },
          { title: 'ok', url: 'https://ok.example/x', snippet: '' },
        ],
      }),
    ]);
    const results = await engine.search('q', 5);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://ok.example/x');
  });

  it('防御性字段解析：url/sourceUrl/webUrl/link 与 title/name/webTitle 多键兜底', async () => {
    const { engine } = makeEngine([
      res(200, {
        results: [
          { name: '来自 name', sourceUrl: 'https://a.example/1', summary: '来自 summary' },
          { webTitle: '来自 webTitle', webUrl: 'https://b.example/2', text: '来自 text' },
          { title: '来自 link', link: 'https://c.example/3', content: '来自 content' },
        ],
      }),
    ]);
    const results = await engine.search('q', 5);
    expect(results.map((r) => r.title)).toEqual(['来自 name', '来自 webTitle', '来自 link']);
    expect(results.map((r) => r.snippet)).toEqual(['来自 summary', '来自 text', '来自 content']);
  });

  it('结果文本中的 token 被脱敏', async () => {
    const secret = 'secret-jwt-value-123';
    const { engine } = makeEngine(
      [res(200, { results: [{ title: `看 ${secret}`, url: 'https://e.com/x', snippet: secret }] })],
      secret,
    );
    const results = await engine.search('q', 5);
    expect(results[0].title).not.toContain(secret);
    expect(results[0].snippet).toBe('[redacted]');
  });
});

describe('token 工具', () => {
  it('toDevinSessionToken：裸 JWT 加前缀，已包装 / sk-ws-* 原样保留', () => {
    expect(toDevinSessionToken('abc.def.ghi')).toBe('devin-session-token$abc.def.ghi');
    expect(toDevinSessionToken('devin-session-token$abc.def.ghi')).toBe(
      'devin-session-token$abc.def.ghi',
    );
    expect(toDevinSessionToken('sk-ws-xyz')).toBe('sk-ws-xyz');
    expect(toDevinSessionToken('  abc.def.ghi  ')).toBe('devin-session-token$abc.def.ghi');
  });

  it('devinTokenExpiry：JWT exp 解析（提前 1 分钟），无 exp 走 365 天兜底', () => {
    expect(devinTokenExpiry(fakeJwt(1893456000))).toEqual({
      expiresAt: 1893456000 * 1000 - 60_000,
      source: 'jwt',
    });
    const now = 1_700_000_000_000;
    expect(devinTokenExpiry('not-a-jwt', now)).toEqual({
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
      source: 'fallback',
    });
    expect(devinTokenExpiry(fakeJwt(), now)).toEqual({
      expiresAt: now + 365 * 24 * 60 * 60 * 1000,
      source: 'fallback',
    });
  });

  it('redactToken：裸 JWT 与带前缀形态均被替换', () => {
    const raw = 'aaa.bbb.ccc';
    const text = `x ${raw} y devin-session-token$${raw} z`;
    expect(redactToken(text, raw)).not.toContain(raw);
    expect(redactToken(text, raw)).not.toContain('devin-session-token$');
  });
});
