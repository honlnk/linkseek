# 开源 MCP 搜索项目对标调研

> 目的：看看市面上成熟的开源 MCP 搜索/抓取项目是怎么设计的，有哪些值得 linkseek 借鉴。
> 调研日期：2026-08-04。源码级分析（不只是读 README）。

---

## 一、调研对象

从搜索结果中筛出 **3 个最有代表性**的项目，覆盖三种流派：

| 项目 | 流派 | Star | 为何选它 |
|---|---|---|---|
| **whw23/searxng_http_mcp** | SearXNG 封装派（同我们） | ~10 | 工具设计最完整的 SearXNG MCP，有 categories/engines/多页 fanout |
| **88plug/searxng-mcp** | SearXNG 增强派 | ~0(新) | 7 个工具含 research 模式，有**跨 query 共识重排算法** |
| **mrkrsl/web-search-mcp** | 直爬搜索引擎派（无 SearXNG） | ~1069 | **反爬/WAF 绕过最强**，有多引擎质量评分 + stealth |

> 还扫到了 `Aas-ee/open-webSearch`（多引擎，Bing/Baidu/DDG）、`yokingma/one-search-mcp`（SearXNG+Firecrawl+Tavily），但设计较简单，不如上面三个有参考价值。

---

## 二、它们怎么设计 vs 我们怎么设计

### 2.1 工具设计对比

| 能力 | linkseek（我们） | whw23/searxng_http_mcp | 88plug/searxng-mcp | mrkrsl/web-search-mcp |
|---|---|---|---|---|
| 基础搜索 | ✅ web_search | ✅ search | ✅ search | ✅ full-web-search |
| 多查询并行 | ❌ | ❌ | ✅ search_many | ❌ |
| 搜索+取正文 | ✅ web_search_and_fetch | ❌（认为该客户端做） | ✅ search_and_fetch | ✅（内置在 full-web-search） |
| 深度研究模式 | ❌ | ❌ | ✅ research（多查+合并+取正文+引用） | ❌ |
| 单 URL 取正文 | ✅ web_fetch | ❌ | ✅ fetch_url | ✅ get-single-web-page-content |
| 浏览器渲染取正文 | ✅ web_fetch_render | ❌ | ✅ rendered 参数（集成在 fetch 里） | ✅（集成在提取流程） |
| 多 URL 并行取正文 | ❌ | ❌ | ✅ fetch_many | ❌ |
| 自动补全建议 | ❌ | ✅ autocomplete | ❌ | ❌ |
| 引擎/分类发现 | ❌ | ✅ engine_info | ❌ | ❌ |
| 健康检查 | ❌（仅 /health） | ❌ | ✅ health | ❌ |
| **工具总数** | **4** | **3** | **7** | **3** |

**关键差距**：
- 我们没有 **多查询并行**（search_many）——这对"一个意图用多个关键词搜"很有用
- 我们没有 **自动补全** 和 **引擎发现**——AI 无法感知可用引擎/分类
- 我们的"搜索+取正文"和"浏览器渲染"是**独立工具**，88plug 把 `rendered` 做成参数融合进 fetch，更优雅

### 2.2 搜索参数暴露对比（核心差距）

| 参数 | linkseek | whw23 | 88plug | mrkrsl |
|---|---|---|---|---|
| `query` | ✅ | ✅ | ✅ | ✅ |
| `categories`（分类） | ❌ | ✅ 字符串 | ✅ 字符串 | ❌（无分类概念） |
| `engines`（指定引擎） | ❌ | ✅ 字符串 | ✅ + enabled/disabled | ✅（引擎选择） |
| `language` | ✅ | ✅ | ✅ | ❌ |
| `time_range` | ✅ day/month/year | ✅ + week | ✅ + week | ❌ |
| `pageno`（页码） | ❌（内部用） | ✅ | ✅ | ❌ |
| `pages`（多页 fanout） | ❌ | ✅ 1-5 | ✅（via search_many） | ❌ |
| `safesearch` | ❌（硬编码 0） | ✅ | ✅ | ❌ |
| `format`（精简/完整） | ❌ | ✅ compact/full | ❌ | ❌ |

> 🔴 **最大差距**：我们**完全没暴露 `categories` 和 `engines`**。whw23 和 88plug 都把这两个 SearXNG 最关键的参数透传给 AI，让 AI 按意图选 `it`/`science`/`news`/`images` 分类。这正是我们搜索质量不如人意的可配置层盲区。

**他们怎么让 AI 知道有哪些分类/引擎**（whw23 的三重机制，很聪明）：
1. **`engine_info` 工具** —— 运行时查 SearXNG `/config`，返回所有可用分类和引擎（缓存 5 分钟）
2. **动态工具描述注入** —— 启动时把分类列表拼进 `search` 工具的 description，AI 看 schema 就知道
3. **硬编码兜底** —— `/config` 不可用时用内置的 31 个分类兜底

### 2.3 SearXNG 配置策略对比

| | linkseek | whw23 | 88plug |
|---|---|---|---|
| 是否自带 settings.yml | ✅（39 行） | ❌（完全不带） | ❌（外部依赖） |
| 引擎调权 | ❌ | ❌ | ❌ |
| 引擎启停 | ❌ | ❌ | ❌ |
| 语言配置 | `zh-CN`（强制） | 用默认 | 用默认 |
| JSON 输出 | 手动开了 | 启动脚本 patch | 外部配置 |

**意外发现**：**三个 SearXNG 项目都不调引擎权重**。whw23 甚至连 settings.yml 都不带，完全用 SearXNG 默认引擎。它们的思路是：**不在配置层优化引擎，而是把选择权交给 AI**（通过暴露 `categories`/`engines` 参数 + 发现工具）。

这对我们是个重要的思路启发：与其纠结"全局配什么引擎权重"，不如**让 AI 按每次 query 动态选引擎**。

---

## 三、三个项目各自的"独门绝技"

### 3.1 whw23 —— 设计哲学最清晰

**值得学的**：

1. **`categories`/`engines` 用自由字符串而非枚举**
   - 不用 enum（SearXNG 分类会变，硬编码枚举会过时）
   - 用字符串 + 发现工具 + 动态描述注入，兼顾灵活性和 AI 可见性

2. **多页并行 fanout**
   ```python
   for page in range(pageno, pageno + pages):
       tasks.append(client.get(url, params={**params, "pageno": str(page)}))
   responses = await asyncio.gather(*tasks, return_exceptions=True)
   ```
   - 1-5 页并行抓取，单页失败不影响整体
   - `return_exceptions=True` 做错误隔离

3. **零结果诊断**
   - 空结果时返回结构化诊断（不是空数组），根据 active 的 filter 给建议
   - 例："设了 time_range 可能太严""指定 engines 可能引擎无响应"
   - 帮 AI 自我纠错，实现成本极低

4. **`format: compact|full` 开关**
   - 默认 compact（只返回 title/url/content）
   - full 才返回 score/engines/date——让 AI 按需付 token

**不值得学的**：
- 动态描述注入用了 FastMCP 私有 API `_tool_manager._tools`，跨版本会碎
- 完全不带 settings.yml——零配置但放弃了引擎策展能力

### 3.2 88plug —— 重排算法最有价值

**值得学的（重点）**：

1. **跨 query 共识重排算法**（最值得移植）
   ```
   merged_score = best_score + (hit_count - 1) * 0.35 - first_seen_rank * 0.01
   ```
   - `best_score`：该 URL 在多个 query 中的最高 SearXNG 分
   - `(hit_count-1)*0.35`：**跨 query 确认加成**——被多个关键词命中的结果加分
   - `-first_seen_rank*0.01`：轻微偏好排名靠前的
   - 这是零依赖、无 ML 的重排，直接可移植

2. **URL 规范化去重**
   - 剥离追踪参数：`utm_*`/`fbclid`/`gclid`/`igshid`/`mc_*`/`ref` 等
   - 统一协议/主机大小写、去默认端口、去尾斜杠
   - 比我们"只按 URL 字符串去重"强很多

3. **质量触发自动渲染**（智能省资源）
   - 不总是用浏览器，只在 HTTP 结果"看起来像 JS 依赖"时才渲染
   - 触发条件（任一）：
     - HTML 含 `__NEXT_DATA__`/`__NUXT__`/`data-reactroot` 等 SPA 标记
     - 文本密度低（`script_count>=3 且 text_density<=0.06`）
     - 字数太少（`script>=1 且 word<=60`）
   - 渲染成功后**双缓存**（同时存普通 key 和 rendered key）

4. **research 模式 = search_many + fetch_many 的编排**
   - 不是 LLM 循环，是固定管道：多查询并行 → 合并去重重排 → 取 top N 正文 → 带引用返回
   - 每条结果记录 `queries`（哪些 query 命中）、`engines`、`hit_count`——透明的重排信号

5. **双层浏览器兜底**
   - 质量触发（文本稀疏）+ 错误触发（HTTP 失败）都会降级到浏览器
   - 比我们"永远不降级"强

**不值得学的**：
- 浏览器渲染用诚实 UA `searxng-mcp/<version>`——**比我们还容易被 WAF 拦**（我们的 `linkseek/0.1` 至少不算包名）
- 不带 settings.yml，完全靠 SearXNG 默认

### 3.3 mrkrsl/web-search-mcp —— 反爬/WAF 最强

**值得学的（重点）**：

1. **stealth 全家桶**（最高 ROI 的 WAF 改进）
   ```javascript
   // launch args
   '--disable-blink-features=AutomationControlled'  // 关键反检测标志
   '--no-sandbox'
   '--disable-dev-shm-usage'
   
   // context 设置
   userAgent: 'Mozilla/5.0 ... Chrome/121.0.0.0'  // 真实 UA（不是包名）
   locale: 'en-US'
   timezone: 'America/New_York'
   viewport: { width: 1920, height: 1080 }
   
   // 完整请求头
   Accept, Accept-Language, Accept-Encoding: 'gzip, deflate, br'
   DNT: 1, Upgrade-Insecure-Requests: 1
   Sec-Fetch-Dest/Mode/Site 全套
   
   // 注入脚本
   navigator.webdriver → undefined
   navigator.plugins → [1,2,3,4,5]
   navigator.languages → ['en-US','en']
   permissions.query 打补丁
   window.chrome 移除
   ```
   这套组合拳是手工实现的 puppeteer-extra-stealth 子集——**正是我们 Browserless `?stealth=true` 底层做的事情，但他们自己掌控**。

2. **从 HTTP 响应体检测 WAF 挑战页**（很实用）
   ```javascript
   function isLowQualityContent(body) {
     return body.length < 100  // 太短
       || body.includes('Please enable JavaScript')
       || body.includes('captcha')
       || body.includes('unusual traffic')
       || body.includes('Access Denied');
   }
   ```
   检测到就抛"低质量内容"错误 → 触发浏览器兜底。**这正是我们 `search_and_fetch` 乱码问题的解法**。

3. **信号驱动的浏览器降级**（不是死板的计数）
   ```javascript
   function shouldUseBrowser(error, url) {
     return error.status === 403 || error.status === 429 || error.status === 503
       || /timeout|Access denied|Forbidden|Low quality/i.test(error.message)
       || isKnownJsHeavySite(url);  // twitter/medium/reddit 等
   }
   ```
   比我们的"永远不降级"和死板计数都好。

4. **多引擎质量评分级联**
   - Bing（浏览器）→ Brave（浏览器）→ DDG（axios）
   - 每个 4s 超时，快速失败
   - 对每个引擎的结果打质量分，`>=0.8` 立即返回，`<0.3` 继续下一个
   - 评分算法：关键词覆盖率 + 短语奖励 - 无关惩罚

5. **人类行为模拟**
   - 随机鼠标移动、随机滚动、500-1500ms 随机等待、偶尔点击
   - 对最难绕的 WAF 有效

6. **HTTP/2 → HTTP/1.1 降级恢复**
   - 遇到 `ERR_HTTP2_PROTOCOL_ERROR` 时关 context、重建、换 HTTP/1.1 + keep-alive
   - 实用的服务器兼容性兜底

**不值得学的**：
- `assessResultQuality` 的"无关惩罚"列表（recipe/weather/sports/travel 各扣 0.2）——领域偏见，会误伤合法查询
- `BROWSER_FALLBACK_THRESHOLD` 是**死代码**（解析了但没用，README 描述与实现不符）
- 直接爬搜索引擎 HTML（不通过 SearXNG）——容易因搜索引擎改版失效，可维护性差

---

## 四、综合：linkseek 该向谁学什么

### 4.1 搜索参数与工具设计 → 学 whw23

| 借鉴点 | 来源 | 对我们的意义 | 难度 |
|---|---|---|---|
| 暴露 `categories` 参数 | whw23 | AI 可按 `it`/`science`/`news` 分类搜索，质量飞跃 | 低（改 searxng.ts + web-search.ts） |
| 暴露 `engines` 参数 | whw23 | AI 可指定用 google/bing 等引擎 | 低 |
| 多页并行 fanout | whw23 | `pages` 参数，一次取多页 | 低（Promise.all） |
| 零结果诊断 | whw23 | 空结果时给 AI 纠错建议 | 低 |
| `rendered` 融合进 fetch 参数 | 88plug | 合并 web_fetch + web_fetch_render 为一个工具 | 中 |
| 自动补全工具 | whw23 | `autocomplete` 辅助 AI 扩展关键词 | 低 |

### 4.2 重排与后处理 → 学 88plug

| 借鉴点 | 来源 | 对我们的意义 | 难度 |
|---|---|---|---|
| 跨 query 共识重排 | 88plug | 多关键词/多引擎命中加分，质量提升 | 中（需 search_many 支撑） |
| URL 规范化去重 | 88plug | 剥离 utm/fbclid 等追踪参数，去重更准 | 低 |
| `top_domains` 多样性信号 | 88plug | 返回结果附"来源域名分布" | 低 |
| 用 `score` 排序 | 通用 | 我们声明了字段却没用 | 极低 |

### 4.3 WAF/反爬 → 学 mrkrsl

| 借鉴点 | 来源 | 对我们的意义 | 难度 |
|---|---|---|---|
| 真实浏览器 UA（非包名） | mrkrsl | 直接缓解 WAF 拦截 | 极低（改一个常量） |
| 完整请求头（Sec-Fetch-* 等） | mrkrsl | 降低被识别为爬虫概率 | 低 |
| WAF 挑战页检测 | mrkrsl | 解决 search_and_fetch 乱码问题 | 低（加 isLowQuality 检测） |
| 信号驱动浏览器降级 | mrkrsl | HTTP 失败/低质自动切浏览器 | 中 |
| stealth 注入脚本 | mrkrsl | `navigator.webdriver` 等补丁 | 中（或直接开 Browserless `?stealth=true`） |
| 质量触发自动渲染 | 88plug | 只在需要时才用浏览器，省资源 | 中 |

### 4.4 SearXNG 配置 → 三个项目都没给出好答案

**三个 SearXNG 项目都不调引擎权重**，都靠默认引擎 + 把选择权交给 AI。这给我们两个选择：

- **路线 A（学他们）**：保持 `use_default_settings: true`，但暴露 `categories`/`engines` 给 AI，让 AI 按 query 动态选。省心，但全局质量上限依赖 SearXNG 默认引擎的可用性。
- **路线 B（走自己的路）**：在 settings.yml 里调引擎权重 + 禁用低质引擎，同时暴露参数。比他们更进一步，但需要实测验证哪些引擎可用。

建议 **先走路线 A**（改动小、见效快），后续再叠加路线 B 的引擎权重调优。

---

## 五、优先级建议（取经后的更新版）

基于三个项目的实践，把上一份文档的优先级建议更新如下：

### P0 —— 投入小、收益大、有成功先例

1. **暴露 `categories` 参数**（学 whw23）—— 搜索质量立竿见影
2. **改抓取 UA 为真实浏览器 UA**（学 mrkrsl）—— 缓解 WAF
3. **加 WAF 挑战页检测**（学 mrkrsl 的 `isLowQualityContent`）—— 解决乱码
4. **用 `score` 排序结果**（通用）—— 几行代码
5. **URL 规范化去重**（学 88plug）—— 剥离追踪参数

### P1 —— 中等投入、质量跃升

6. **暴露 `engines` 参数 + 引擎发现工具**（学 whw23）
7. **多页并行 fanout**（学 whw23）
8. **信号驱动的浏览器降级**（学 mrkrsl 的 `shouldUseBrowser`）
9. **浏览器 stealth**（开 Browserless `?stealth=true` 或自注入脚本）

### P2 —— 较大投入、长期价值

10. **跨 query 共识重排**（学 88plug）—— 需 search_many 支撑
11. **多查询并行**（学 88plug 的 search_many）
12. **SearXNG 引擎权重调优**（路线 B）

---

## 六、一句话总结

**我们的工具设计偏"基础设施"（4 个独立工具），而成熟项目偏"AI 友好"——把 SearXNG 的能力（categories/engines/多页/分类）尽可能地暴露给 AI，让 AI 自己决策。这是最大也是最值得借鉴的设计差异。** 在 WAF 处理上，mrkrsl 的"检测挑战页 + 信号驱动降级 + stealth"三件套直接解决我们的乱码问题。在重排上，88plug 的"跨 query 共识"算法是零成本提升质量的利器。
