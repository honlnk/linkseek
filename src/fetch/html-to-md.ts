import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import * as turndownPluginGfm from 'turndown-plugin-gfm';
import { URL } from 'node:url';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  hr: '---',
});
turndown.use(turndownPluginGfm.gfm);

/**
 * 将 HTML 转换为 LLM 友好的 Markdown。
 *
 * 流程：cheerio 加载 → 移除噪音标签 → 定位正文区域 → turndown 转换 → 相对链接转绝对。
 */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  // false = 不对文本实体做额外解码，交给 turndown 处理
  const $ = cheerio.load(html, null, false);

  // 移除噪音标签
  $(
    'script, style, noscript, iframe, nav, footer, header, aside, form, svg, canvas, .ad, .ads, .advertisement, [role="navigation"], [aria-hidden="true"]',
  ).remove();

  // 定位正文区域（逐级回退）
  const mainContent =
    $('article').first().html() ||
    $('main').first().html() ||
    $('[role="main"]').first().html() ||
    $('.post-content, .entry-content, .article-content, .content').first().html() ||
    $('body').html() ||
    $.html();

  if (!mainContent) return '';

  // 相对链接 → 绝对链接（在 turndown 转换前修正 DOM）
  const $content = cheerio.load(mainContent, null, false);
  $content('a[href]').each((_, el) => {
    const href = $content(el).attr('href');
    if (href) {
      try {
        $content(el).attr('href', new URL(href, baseUrl).href);
      } catch {
        // 无效 href 保持原样
      }
    }
  });

  return turndown.turndown($content.html() || mainContent).trim();
}
