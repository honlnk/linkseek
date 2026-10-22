import { describe, it, expect } from 'vitest';
import { CommercialManager, type CommercialEngineEntry } from './manager.js';
import type { CommercialEngine, CommercialEngineStatus } from './types.js';
import type { SearchResult } from '../provider.js';

/**
 * 商业兜底管理器单元测试（注入假引擎与假配置，不触 SystemSetting）。
 * 覆盖：列表为空整体关闭、enabled:false 跳过、前引擎失败静默续试、顺序严格按数组。
 */

interface FakeEngineBehavior {
  usable?: boolean;
  results?: SearchResult[];
  error?: Error;
}

function makeFakeEngine(id: string, behavior: FakeEngineBehavior, order: string[]) {
  const state = { searched: 0 };
  const engine: CommercialEngine = {
    id,
    name: `测试引擎 ${id}`,
    available: async () => behavior.usable !== false,
    status: async () => ({ state: behavior.usable === false ? 'invalid' : 'ok' }) as CommercialEngineStatus,
    search: async () => {
      state.searched++;
      order.push(id);
      if (behavior.error) throw behavior.error;
      return behavior.results ?? [];
    },
  };
  return { engine, state };
}

function entries(...list: CommercialEngineEntry[]) {
  return async () => list;
}

const hit = (title: string): SearchResult => ({ title, url: `https://e.com/${title}`, snippet: '' });

describe('CommercialManager.runFallback', () => {
  it('列表为空 / 未配置 = 整体关闭，返回空且不碰任何引擎', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', {}, order);
    const manager = new CommercialManager({ a: a.engine }, entries());
    const outcome = await manager.runFallback('q', 10);
    expect(outcome.results).toEqual([]);
    expect(outcome.attempts).toEqual([]);
    expect(a.state.searched).toBe(0);
  });

  it('enabled:false 的条目被跳过（保留配置但不调用）', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', {}, order);
    const b = makeFakeEngine('b', { results: [hit('b1')] }, order);
    const manager = new CommercialManager(
      { a: a.engine, b: b.engine },
      entries({ id: 'a', enabled: false }, { id: 'b', enabled: true }),
    );
    const outcome = await manager.runFallback('q', 10);
    expect(a.state.searched).toBe(0);
    expect(b.state.searched).toBe(1);
    expect(outcome.hitEngine).toBe('b');
    expect(outcome.results).toHaveLength(1);
  });

  it('前引擎抛错 → 静默继续，后引擎命中；尝试记录完整', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', { error: new Error('quota exhausted') }, order);
    const b = makeFakeEngine('b', { results: [hit('b1')] }, order);
    const manager = new CommercialManager(
      { a: a.engine, b: b.engine },
      entries({ id: 'a', enabled: true }, { id: 'b', enabled: true }),
    );
    const outcome = await manager.runFallback('q', 10);
    expect(order).toEqual(['a', 'b']);
    expect(outcome.attempts).toEqual([
      { label: '商业兜底:a', kind: 'commercial', resultCount: -1, error: 'quota exhausted' },
      { label: '商业兜底:b', kind: 'commercial', resultCount: 1 },
    ]);
    expect(outcome.results).toHaveLength(1);
  });

  it('尝试顺序严格按数组顺序（与注册表顺序无关）', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', {}, order);
    const b = makeFakeEngine('b', {}, order);
    const manager = new CommercialManager(
      { a: a.engine, b: b.engine },
      entries({ id: 'b', enabled: true }, { id: 'a', enabled: true }),
    );
    await manager.runFallback('q', 10);
    expect(order).toEqual(['b', 'a']);
  });

  it('凭证不可用（available=false）→ 跳过并记诊断，不调用 search', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', { usable: false }, order);
    const b = makeFakeEngine('b', { results: [hit('b1')] }, order);
    const manager = new CommercialManager(
      { a: a.engine, b: b.engine },
      entries({ id: 'a', enabled: true }, { id: 'b', enabled: true }),
    );
    const outcome = await manager.runFallback('q', 10);
    expect(a.state.searched).toBe(0);
    expect(outcome.attempts[0]).toMatchObject({
      label: '商业兜底:a',
      kind: 'commercial',
      resultCount: 0,
      error: expect.stringContaining('凭证'),
    });
    expect(outcome.hitEngine).toBe('b');
  });

  it('列表里的未知引擎 id → 记诊断跳过，不影响后续引擎', async () => {
    const order: string[] = [];
    const b = makeFakeEngine('b', { results: [hit('b1')] }, order);
    const manager = new CommercialManager(
      { b: b.engine },
      entries({ id: 'ghost', enabled: true }, { id: 'b', enabled: true }),
    );
    const outcome = await manager.runFallback('q', 10);
    expect(outcome.attempts[0]).toMatchObject({
      label: '商业兜底:ghost',
      kind: 'commercial',
      error: expect.stringContaining('未知引擎'),
    });
    expect(outcome.hitEngine).toBe('b');
  });

  it('全部引擎无结果 → 返回空但保留全部尝试记录', async () => {
    const order: string[] = [];
    const a = makeFakeEngine('a', {}, order);
    const manager = new CommercialManager({ a: a.engine }, entries({ id: 'a', enabled: true }));
    const outcome = await manager.runFallback('q', 10);
    expect(outcome.results).toEqual([]);
    expect(outcome.hitEngine).toBeUndefined();
    expect(outcome.attempts).toEqual([
      { label: '商业兜底:a', kind: 'commercial', resultCount: 0 },
    ]);
  });
});
