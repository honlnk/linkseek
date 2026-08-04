/**
 * 内容质量检测：识别 WAF 挑战页、反爬验证页、乱码内容。
 *
 * 用于 search_and_fetch 等批量抓取场景：单条正文命中时跳过，避免污染整体结果。
 * 检测策略参考 mrkrsl/web-search-mcp 的 isLowQualityContent，并针对中文站点补充特征。
 */

/** WAF / 反爬挑战页的特征标记（小写匹配） */
const WAF_MARKERS: string[] = [
  // 通用 WAF 挑战标记
  '_waf_',
  'waf_captcha',
  '__cf_bm',
  'cf-browser-verification',
  'cf-challenge',
  'jschl-answer',
  'jschl_vc',
  // 验证码 / 安全验证提示语
  'please enable javascript',
  'enable javascript to run',
  'just a moment', // Cloudflare "Just a moment..."
  'checking your browser',
  'unusual traffic',
  'access denied',
  'captcha',
  'are you a robot',
  'i am not a robot',
  '安全验证',
  '请开启 javascript',
  '人机验证',
  '访问被拒绝',
  '异常流量',
];

/** WAF 标记的最小出现次数（任一命中即判定为低质） */
const MIN_WAF_MARKER_HITS = 1;

/**
 * 判断抓取到的 Markdown 正文是否为低质量内容（WAF 挑战页 / 乱码 / 反爬拦截）。
 *
 * 三层检测，任一命中即返回 true：
 * 1. WAF 标记：包含已知的 WAF/反爬特征字符串
 * 2. 极短内容：长度 < 100 字符（正常文章不会这么短）
 * 3. 文本密度过低：可读字符占比 < 0.3 且总长 > 200（典型的乱码/混淆内容）
 */
export function isLowQualityContent(content: string): boolean {
  if (!content) return true;

  const lower = content.toLowerCase();

  // 1. WAF / 反爬标记检测
  let wafHits = 0;
  for (const marker of WAF_MARKERS) {
    if (lower.includes(marker)) {
      wafHits++;
      if (wafHits >= MIN_WAF_MARKER_HITS) return true;
    }
  }

  const len = content.length;

  // 2. 极短内容（正常文章正文不会少于 100 字符）
  if (len < 100) return true;

  // 3. 文本密度：统计 CJK 字符 + 拉丁字母 + 阿拉伯数字，计算占比
  if (len > 200) {
    let readable = 0;
    for (const ch of content) {
      const code = ch.codePointAt(0)!;
      if (
        (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一汉字
        (code >= 0x3040 && code <= 0x30ff) || // 日文假名
        (code >= 0xac00 && code <= 0xd7af) || // 韩文音节
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a) || // a-z
        (code >= 0x30 && code <= 0x39) // 0-9
      ) {
        readable++;
      }
    }
    const density = readable / len;
    if (density < 0.3) return true;
  }

  return false;
}
