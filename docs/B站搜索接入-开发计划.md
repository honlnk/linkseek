# B 站搜索接入开发计划

> 状态：进行中（阶段一、二、三完成；阶段四发版部署待用户指令，2026-11-06）
> 日期：2026-11-06
> 目标：接入 bilibili 视频搜索——启用 SearXNG 自带的 bilibili 引擎，透出作者与发布时间字段，补充 week 时间档，并让 AI 调用方能发现并正确使用该能力。
> 范围：SearXNG 配置、搜索结果字段透出、三个 MCP 搜索工具与公开 API 的参数和输出、文档与 linkseek-usage 技能同步、发版部署与线上验收。
> 版本：v0.4.0

## 一、背景与目标

2026-10-01 的会话中首次提出「接入抖音、小红书、bilibili、微信公众号搜索」的想法，当时结论为四平台难度天差地别：B 站几乎零成本，其余三个分别需要养登录态或基本不可行。本次先落地 bilibili（本期唯一平台），验证「自媒体平台搜索」这条产品线的最小闭环。

本次施工前的实测复验（2026-11-06，全部通过）：

| # | 验证项 | 结论 |
|---|---|---|
| 1 | 上游 SearXNG bilibili 引擎现状 | 健在且带 time_range 过滤（day/week/month/year），无需登录、无需 wbi 签名，随机 buvid3 cookie + Referer 即可 |
| 2 | 生产容器（searxng/searxng:latest，已运行 5 周）内的 bilibili.py | 已含 `time_range_dict`（含 week）——**无需升级镜像** |
| 3 | B 站搜索 API 本机直连 | `code 0` 正常返回 |
| 4 | 服务器经 mihomo 代理（172.17.0.1:7890，生产出站真实路径）访问 B 站 API | `code 0` 正常返回，无风控 |
| 5 | linkseek 现有链路 | 完全现成：显式传 `engines` 即跳过云端直走本地链（src/search/fallback.ts:107），参数透传与 MCP 工具暴露均已存在 |
| 6 | 配置下发机制 | CI 发版流水线自动 rsync `searxng/` 目录到服务器；但 searxng 容器不跟发，需发版后手动重启一次容器 |

## 二、定稿行为约定

### 2.1 引擎启用

`searxng/settings.yml` 追加 engines 块（本地与生产共用同一份文件）：

```yaml
engines:
  - name: bilibili
    disabled: false
```

SearXNG 的 `use_default_settings: true` 合并语义下，仅覆盖 bilibili 引擎的 disabled 项，其余引擎配置不受影响。bilibili 引擎归属 videos 分类，启用后同时出现在 `categories=videos` 的聚合结果中。

### 2.2 调用方式

| 调用方式 | 行为 |
|---|---|
| `web_search(query, engines="bilibili")` | 跳过云端，本地 SearXNG 直查 B 站，返回视频结果 |
| `web_search(query, categories="videos")` | 本地 videos 分类聚合（bilibili 及其他已启用的视频引擎） |
| 不传 engines / categories | 行为与现在完全一致（云端优先 → 本地兜底），B 站不参与 general 搜索 |

### 2.3 结果字段透出

`SearchResult`（src/search/provider.ts）新增两个可选字段：

- `author?: string` —— SearXNG 结果中的 author（B 站场景为 UP 主；商业引擎与多数 general 引擎无此字段，保持 undefined）
- `publishedDate?: string` —— SearXNG 结果中的 publishedDate 原样字符串（解析层不加工，取不到则 undefined）

透出范围按「出口是否直接展示结果列表」一刀切：

| 出口 | 是否透出 | 形式 |
|---|---|---|
| web_search（MCP 文本输出） | 是 | URL 行后新增一行 `作者: {author} ｜ 发布: {date}`，仅当字段存在；date 取 publishedDate 前 10 位（YYYY-MM-DD），不足 10 位则原样输出 |
| search_and_fetch（结果列表部分） | 是 | 同上规则 |
| public-api `/v1/search`（JSON） | 是 | 响应对象新增可选 author / publishedDate 字段，原样字符串 |
| web_search_answer / web_research | 否 | AI 消化后重写的回答，字段由 LLM 自然融入，不做结构化透出 |

### 2.4 timeRange 新增 week 档

现状：linkseek 的 TimeRange 仅 day/month/year（当时注释「SearXNG 没有 week」已过时）。SearXNG 实际支持 week，且行为是——**time_range 传给不支持 time_range 的引擎时该引擎整体跳过**（上游 abstract.py `get_params` 返回 None）。

定稿：枚举加入 week，全部入口同步（MCP 三工具、公开 API、类型定义），描述文案写明适用范围：

> week 仅视频类引擎（bilibili）支持；general 搜索引擎普遍不支持 week，传了会导致引擎被跳过、召回变窄，通用时效过滤请用 day/month/year。

不做代码级拦截（与「参数交给调用方」的现有设计哲学一致），靠描述引导。云端优先路径不受影响（商业引擎本就不接收 timeRange）。

### 2.5 发现性（已拍板：文档/技能引导，不做自动路由）

AI 调用方通过三层描述发现能力，服务端不加启发式路由：

1. MCP 工具的 engines 参数描述：示例中加入 bilibili（「搜 B 站视频 → engines="bilibili"」）
2. MCP 工具的 categories 描述：videos 值的说明中提及 B 站
3. linkseek-usage 技能（honlnk-skills 仓库）：新增「B 站视频搜索」用法小节

## 三、新旧机制去向

纯新增，无机制替换：

- engines/categories 参数语义不变，bilibili 只是新可用值
- SearchResult 加可选字段，所有既有消费方（commercial 引擎等）不受影响，输出格式向后兼容
- timeRange 是枚举扩容，旧值行为不变
- SearXNG 其余引擎配置不动（engines 块仅含 bilibili 一项，不做全面引擎治理）

## 四、实施步骤

### 阶段一：SearXNG 配置 + 本地实测

1. `searxng/settings.yml` 追加 2.1 的 engines 块（含注释说明用途与来源）
2. 本地 `docker compose up -d searxng`，验证：
   - `curl 'http://localhost:8080/search?q=万物论&engines=bilibili&format=json'` 返回视频结果（title/url/content/author/publishedDate 齐全）
   - `time_range=week` 请求正常过滤
   - 不带 engines 的 general 请求行为与启用前一致（抽查一次）
3. 确认 SearXNG JSON 的 author / publishedDate 字段实际格式（拍板 2.3 的解析写法）

门禁：上述三项实测通过，配置文件已保存。

### 阶段二：TS 代码（字段透出 + week 档 + 描述更新）

改动点（均已定位）：

| 文件 | 改动 |
|---|---|
| src/search/provider.ts | TimeRange 类型加 'week'（更新过时注释）；SearchResult 加 author?/publishedDate? |
| src/search/searxng.ts:360 | timeRangeValues 加 'week'；结果解析透出 author/publishedDate（宽容处理：非字符串/缺失则 undefined） |
| src/tools/web-search.ts | timeRange 断言与描述加 week（含适用范围说明）；engines/categories 描述加 bilibili；文本输出加「作者｜发布」行（2.3 规则） |
| src/tools/search-and-fetch.ts | 同上（断言、描述、结果列表输出行） |
| src/tools/web-search-answer.ts | 断言与参数描述同步（engines 描述加 bilibili、week 说明）；输出不加字段行 |
| src/public-api/router.ts:43 | timeRange 的 z.enum 加 'week'；/v1/search 响应加可选 author/publishedDate |
| src/research/pipeline.ts | **不动**——web_research 的 categories/timeRange 白名单保持通用语义（见六） |

新增/更新单测：searxng.ts 解析新字段的用例（含缺失字段容错）、既有 fallback 测试回归。

门禁：`pnpm test` 全绿 + `pnpm build`（或项目等价的类型检查命令）干净。

### 阶段三：文档与技能同步

1. README.md：工具参数说明中 engines 示例加 bilibili、timeRange 加 week
2. 公开门户页与后台相关文案：grep `engines` 定位全部需同步处（对照 v0.3.1 文案同步提交 f25dc36 的触及面），逐处补 bilibili/week
3. docs/部署指南.md：若提及 searxng 配置，补充「engines 块的用途」
4. honlnk-skills 仓库 linkseek-usage SKILL.md：新增 B 站搜索用法（engines="bilibili"、timeRange=week、categories=videos 三个入口各自的适用场景）——该仓库独立提交，**push 与部署节奏听用户指令**
5. 本计划文档状态流转 + 施工日志随阶段追加

门禁：文档全部落盘；grep 复查无遗漏处。

### 阶段四：发版部署与线上验收

1. 版本号 v0.4.0（package.json + CHANGELOG 若有），提交、打 tag `v0.4.0` → CI 自动：构建 app 镜像 → rsync 配置（含新 settings.yml）→ deploy-release.sh（只动 app + gateway）
2. **发版成功后手动一步**：ssh 服务器执行 `docker compose --env-file .env -f docker-compose.prod.yml up -d searxng` 重启 searxng 容器（bind-mount 的 settings.yml + entrypoint 注入需重启生效）。影响：searxng 重启的数十秒内本地兜底不可用，云端搜索不受影响，选择低峰执行
3. 线上验收（见五）

门禁：线上验收全过，施工日志收尾。

## 五、验收标准

| # | 验收项 | 验证方式 |
|---|---|---|
| 1 | 本地 engines=bilibili 搜索 | 阶段一 curl 实测，返回含 author/publishedDate 的视频结果 |
| 2 | 单测与构建 | 阶段二门禁命令全绿 |
| 3 | MCP 端到端 | 线上（或 MCP 直连）`web_search(query="...", engines="bilibili", timeRange="week")` 返回带「作者｜发布」行的结果 |
| 4 | 通用搜索回归 | 线上一次不传 engines 的常规搜索，结果与行为无异常（云端优先路径未受影响） |
| 5 | 公开 API | `GET /v1/search?...&engines=bilibili` 返回含 author/publishedDate 的 JSON |
| 6 | 文档/技能 | README、门户页、linkseek-usage 技能均含 B 站搜索用法 |

降级预案：若线上 searxng 重启后 bilibili 引擎异常（unresponsive），回滚方式为还原 settings.yml 的 engines 块并再次重启容器——不影响其他引擎与云端路径。

## 六、本期不做

- 抖音、小红书、微信公众号接入（需登录态适配器或不可行，另行立项评估）
- SearXNG 镜像升级（当前生产镜像已含所需能力）
- SearXNG 全面引擎治理（engines 块的 weight 调优、其他引擎启用——三份调研文档点名的批次，与本次仅共享 settings.yml 这一个文件触点）
- web_research 流水线的 categories/timeRange 白名单扩展（保持通用研究语义，视频搜索走显式 web_search）
- SearchResult 的时长、缩略图、iframe 等字段透出
- 服务端自动路由（query 视频意图识别等启发式）

## 七、项目执行规范

- 提交信息格式沿用项目惯例：`feat(search): ...` / `docs(search): ...`，发版提交 `chore(release): v0.4.0（B 站搜索接入...）`
- 不 push、不发 PR、不打 tag，除非用户明说；honlnk-skills 子仓库先于本仓库文档提交（若有指针联动）
- 施工日志格式：日期 + 阶段 + 提交 hash + 验收结论 + 偏差记录，随阶段门禁落盘
- 测试命令：`pnpm test`；类型检查/构建以 package.json scripts 为准，开工前先核对

## 八、施工日志

### 2026-11-06 阶段一：SearXNG 配置 + 本地实测

- `searxng/settings.yml` 追加 engines 块（bilibili: disabled: false，含用途注释），本地 `docker compose up -d searxng` 启动实测。
- 实测一（engines=bilibili，q=万物论）：20 条视频结果，author（UP 主名）与 publishedDate 齐全。**偏差**：计划预期「content 齐全」，实际 B 站引擎 content 为空字符串——B 站 API 不返回摘要，属上游行为；TS 侧按 2.3 宽容规则处理（空/缺失不输出），不影响门禁。
- 实测二（time_range=week）：20 条结果全部落在近 7 天（2026-10-31 ~ 2026-11-06），过滤生效。
- 实测三（general 回归）：**本机 VPN 隧道不通**（宿主机直连与经 7897 代理均到不了 google），境外引擎全部超时、general 0 结果。改用 A/B 对照验证：git stash 还原旧配置重启容器后同样查询，结果形态（0 结果 + 相同引擎超时集合）与新配置**完全一致**——engines 块对 general 行为零影响，失败归因于本机网络环境。**待用户复核**：VPN 恢复后跑一次常规 general 搜索确认结果正常。
- 补充验证：`categories=videos` 聚合含 bilibili（+sepiaseearch 同分类默认引擎），与 2.1 声称一致。
- 字段格式确认（拍板 2.3 解析写法）：author 为普通字符串；publishedDate 为 `YYYY-MM-DDTHH:MM:SS`，前 10 位即日期，2.3 的「取前 10 位」规则成立。
- 端口偏差：本地 compose 将 searxng 映射到宿主 **8081**（计划 curl 示例写的 8080 为容器内端口），实测均用 8081。

### 2026-11-06 阶段二：TS 代码（字段透出 + week 档 + 描述更新）

- 改动与计划四表一致：provider.ts（TimeRange 加 week 并更新过时注释；SearchResult 加 author?/publishedDate?）、searxng.ts（timeRangeValues 加 week；解析宽容透出，新增 asOptionalString 助手）、web-search.ts / search-and-fetch.ts / web-search-answer.ts（断言改 `as TimeRange`、描述加 bilibili/week/视频分类文案；前两者输出加「作者｜发布」行）、public-api/router.ts（z.enum 加 week）。
- **计划外新增**：`src/search/result-format.ts`——「作者｜发布」行格式化助手，web_search 与 search_and_fetch 两出口共用（本仓库既有惯例：共享执行逻辑避免双份实现漂移）。纯实现细节自选，无行为影响。
- 实现口径细化（计划 2.3 只写了「仅当字段存在」）：两字段各自独立判断，只有一段就只输出一段（如仅有作者 → `作者: X`），都没有则整行不输出；已补单测锁定。
- web-search-answer 按计划仅同步断言与参数描述，输出不加字段行。
- 新增单测：`searxng.test.ts`（author/publishedDate 四种容错场景 + week 透传，mock undici fetch 不打真实服务）、`result-format.test.ts`（格式规则 5 例）。`pnpm test` 56 例全绿（新增 10 例），`pnpm typecheck`、`pnpm build` 干净（build 的 chunk 大小警告为既有，与本次无关）。
- 本地端到端实测：经 `searchWithFallback(engines='bilibili', timeRange='week')` 走真实本地 SearXNG，输出含 `作者: X ｜ 发布: 2026-11-04` 行，与 2.3 规范一致。

### 2026-11-06 阶段三：文档与技能同步

- README.md：工具表 `timeRange`(day/week/month/year) + `engines`(如 `bilibili`)；SearXNG 兜底特性行补 B 站搜索能力说明。
- public/docs.html 六处：web_search 卡片描述加 bilibili 示例、参数速查表 timeRange 枚举、categories 行补 videos（含 B 站）、engines 行补 bilibili、timeRange 参数说明加 week 适用范围、/v1/search 响应说明补可选 author/publishedDate。
- docs/部署指南.md：目录树 searxng/settings.yml 行补「engines 块按需启用默认关闭引擎（如 bilibili）」用途说明。
- honlnk-skills 仓库 linkseek-usage SKILL.md：参数手册 timeRange 行删过时的「没有 week」并写明适用范围、engines 行加 bilibili；第六节末新增「B 站视频搜索（v0.4.0+）」小节（三入口表 + 适用场景 + 无摘要/抓取注意事项）；已知边界 videos 行与版本依赖清单同步。
- **grep 复查结论**：`day/month/year` 旧枚举仅存于本计划文档引文与 docs.html 新文案的对比句（均应保留）；后台管理页（web/）grep `engines` 命中全为商业引擎配置页，与 bilibili 无关，无需同步；设计方案文档 engines 提及为降级链机制描述，不涉及引擎目录，无需同步；门户首页 index.html 无 engines/timeRange 文案。

### 2026-11-06 阶段四：发版准备（本地完成，部署待用户指令）

- 无 CHANGELOG 文件（计划「若有」条件不成立），版本号仅 package.json 一处：0.3.1 → 0.4.0。
- 提交分笔（沿用 v0.3.0/v0.3.1 发版惯例，honlnk-skills 子仓库先行）：
  - honlnk-skills `901b114` docs(skills): linkseek-usage 新增 B 站视频搜索用法
  - 本仓库 `7a98530` feat(search): B 站搜索接入（代码 + 配置 + 测试）
  - 本仓库 docs(search): 文案同步与本计划施工日志（本笔）
  - 本仓库 chore(release): v0.4.0（package.json，紧随其后）
- **按项目执行规范暂停点**：打 tag `v0.4.0` / push（触发 CI 构建部署）/ ssh 服务器重启 searxng 容器 / 线上验收（验收表 3、4、5）均属对外不可逆操作，等用户明示后执行。重启影响与低峰选择见计划四.2。
