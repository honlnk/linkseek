import { describe, it, expect } from 'vitest';

import { formatAuthorDateLine } from './result-format.js';

/**
 * 「作者｜发布」元信息行格式（docs/B站搜索接入-开发计划.md 2.3）：
 * 字段存在才输出，日期取前 10 位，两段以全角竖线连接。
 */
describe('formatAuthorDateLine', () => {
  it('两字段齐全：日期取 publishedDate 前 10 位', () => {
    expect(
      formatAuthorDateLine({ author: '掌舵万物L', publishedDate: '2026-10-25T08:53:12' }),
    ).toBe('作者: 掌舵万物L ｜ 发布: 2026-10-25');
  });

  it('仅有作者 → 只输出作者段', () => {
    expect(formatAuthorDateLine({ author: '掌舵万物L' })).toBe('作者: 掌舵万物L');
  });

  it('仅有发布时间 → 只输出发布段', () => {
    expect(formatAuthorDateLine({ publishedDate: '2026-10-25T08:53:12' })).toBe('发布: 2026-10-25');
  });

  it('日期不足 10 位 → 原样输出', () => {
    expect(formatAuthorDateLine({ publishedDate: '2026-10' })).toBe('发布: 2026-10');
  });

  it('字段都缺失（general/商业引擎场景）→ 空字符串，调用方不输出该行', () => {
    expect(formatAuthorDateLine({})).toBe('');
  });
});
