# linkseek

自托管的远程 MCP 服务，通过 HTTP 提供「联网搜索 + 网页获取」能力给 AI 编程工具（Claude Code / Cursor 等），并配套网页端管理后台。

## 域名结构（多域名分流）

linkseek 默认行为是「文档站 + MCP 服务」，后台管理是特例（按 Host 头区分）：

| 入口 | 用途 |
|------|------|
| `linkseek.honlnk.com`（默认） | **文档页**（浏览器 `GET /`）+ **MCP 端点**（AI 工具 `POST /` + Authorization，同一 URL） |
| `admin.linkseek.honlnk.com`（后台域名） | **管理后台**（登录 + Key 管理 + 用量统计） |

- 浏览器访问 `linkseek.honlnk.com` 看到的是使用文档与自部署教程（GET 请求）
- AI 工具配 `https://linkseek.honlnk.com` + Bearer Token，POST 同一个 URL 走 MCP 服务（靠 HTTP 方法 + Authorization 区分，零冲突）
- 后台管理需访问 `admin.linkseek.honlnk.com`（`ADMIN_DOMAIN` 配置项控制）
- `/mcp` 路径在所有域名下依然可用（兼容已部署客户端）

### 本地开发端口对应

本地两个端口与线上两个域名一一对应，无需改 `/etc/hosts`：

| 本地端口 | 对应线上 | 内容 | 启动 |
|---------|---------|------|------|
| `localhost:7300` | `linkseek.honlnk.com` | 文档页 + MCP | `pnpm dev` |
| `localhost:7317` | `admin.linkseek.honlnk.com` | 后台 SPA（热重载） | `pnpm web:dev` |

## 已实现功能

### MCP 服务（给 AI 工具调用）
- ✅ 9 个 MCP 工具：
  - 基础（常驻）：`web_search` / `web_fetch` / `web_search_and_fetch` / `web_fetch_render`
  - 异步任务（常驻）：`get_result`
  - AI 增强（后台配置 LLM Provider 后自动启用）：`web_search_answer` / `web_fetch_answer` / `list_models` / `web_research`
- ✅ 异步任务系统：4 个慢工具支持 `defer: true` 脱手执行（立即返回 taskId）；`web_research` 深度研究流水线（问题改写 → 多轮搜索 → LLM 筛选来源 → 分块蒸馏 → 综合回答，纯异步 1-3 分钟）；`get_result` 查进度取结果；任务结果保留 60 分钟，每 Key / 全局并发上限后台可调（热生效）
- ✅ Streamable HTTP 传输（单一 `/mcp` 端点）
- ✅ API Key 鉴权（Bearer Token）
- ✅ 公开 REST API（`POST /v1/search` / `POST /v1/fetch`）：浏览器端直接调用，API Key 或匿名绿灯（Origin 白名单 + 日配额）两种鉴权
- ✅ SSRF 防护（IP 范围拦截 + DNS rebinding 防护 + 重定向逐跳校验）
- ✅ HTML → Markdown 转换（正文提取 + 噪音去除）
- ✅ SearXNG 元搜索引擎集成
- ✅ 多 LLM Provider（OpenAI / Anthropic / Gemini / OpenAI Responses 协议），AI 工具可按调用切换模型，token 用量与成本自动记账

### 管理后台（网页端）
- ✅ 管理员密码登录（argon2 哈希 + session cookie）
- ✅ Key 管理：创建 / 列表 / 启停 / 删除
- ✅ LLM Provider 管理：多协议接入、默认模型、启停
- ✅ 任务设置：每 Key / 全局并发上限，保存即生效
- ✅ 请求总览：总请求数、按工具分布、近 14 天趋势
- ✅ Key AI 成本：按 Key 聚合的 AI 请求数 / 输入输出 token / 成本
- ✅ 单 Key 用量统计：按工具分布 + 趋势图
- ✅ 用量自动记录：每次 MCP 工具调用写入数据库（异步任务完成时聚合为一条）

### 基础设施
- ✅ MySQL 8.0 + Prisma ORM（数据持久化）
- ✅ 用量统计（每次调用自动记录 keyId / toolName / 时间）
- ✅ Vue 3 + Naive UI 管理界面（SPA）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动依赖容器（MySQL + SearXNG）

```bash
docker compose up -d
# 等待 MySQL 就绪（约 5 秒）
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env：
# - ADMIN_PASSWORD：管理员登录密码（首次 seed 用）
# - SESSION_SECRET：会话密钥（openssl rand -hex 32 生成）
```

### 4. 初始化数据库

```bash
pnpm db:deploy    # 执行迁移建表
pnpm db:seed      # 初始化管理员账号
```

### 5. 构建前端 + 启动服务

```bash
pnpm web:build    # 构建管理后台 SPA
pnpm dev          # 启动后端（含 MCP + 文档页 + REST API + 后台 SPA 静态托管）
```

- 浏览器打开 `http://localhost:7300` → **文档页**（对应线上 `linkseek.honlnk.com`）
- 后台管理需启动前端 dev server（见下），或访问 `http://localhost:7300` 的 admin 域名

### 开发模式（前后端分离热重载）

后台管理前端单独启动，与线上 `admin.linkseek.honlnk.com` 对应：

```bash
# 终端 1：后端（文档页 + MCP + REST API）
pnpm dev
# http://localhost:7300 → 文档页 / MCP 端点

# 终端 2：后台前端（Vite dev server，代理 /api 到 7300）
pnpm web:dev
# http://localhost:7317 → 管理后台
```

## 使用流程

1. 浏览器打开 `http://localhost:7317`（后台前端），用 `ADMIN_PASSWORD` 登录
2. 在「Key 管理」新建一个 Key（明文只显示一次，立即保存）
3. 接入 AI 工具，二选一：

   **一键接入（推荐）**：把下面这段话原样复制给你的 AI 编程工具即可——它会先向你要实例地址和 API Key（并告知三条获取途径），然后自己完成 MCP 配置与技能安装（本地部署的话实例地址就是 `http://localhost:7300`）：

   ```text
   请帮我接入 linkseek——自托管的联网搜索/网页抓取 MCP 服务，并安装它的配套使用技能。

   第一步：确认服务信息。检查我在对话中是否已给出「实例地址 + API Key」；如果没有，停下来向我询问，并顺带告诉我获取方式（三选一）：
   1. 自己部署：linkseek 开源免费，服务器或本地电脑均可（官网 https://linkseek.honlnk.com/ 有 5 分钟部署指南）
   2. 借用他人部署：找已部署 linkseek 的人，请他在管理后台为你创建一对 API Key
   3. 体验通道：到 github.com/honlnk/linkseek 的 Issues 联系作者申请体验用 Key（体验 Key 对应的实例地址即官网 https://linkseek.honlnk.com/）
   拿到实例地址和 API Key 之前不要进行后续步骤。

   第二步：添加远程 MCP 服务器。名称 linkseek，Streamable HTTP 传输，URL 为实例地址，鉴权头 Authorization: Bearer 你的Key。按你所在环境的标准方式写入：
   - ZCode：~/.zcode/cli/config.json 的 mcp.servers，形如 {"type":"http","url":"...","headers":{"Authorization":"Bearer ..."}}，timeoutMs 建议 200000（web_research 深度研究全程 1-3 分钟）
   - Claude Code：claude mcp add --transport http linkseek 实例地址 --header "Authorization: Bearer Key"
   - Claude Desktop / Cursor / Continue 等：mcpServers 配置节，url 与 headers 同上

   第三步：安装配套技能——只装 linkseek-usage 这一个，不要把技能仓库里的其他技能装进技能目录。
   git clone --depth 1 https://github.com/honlnk/honlnk-skills /tmp/honlnk-skills
   把 /tmp/honlnk-skills/skills/linkseek-usage 复制到你的技能目录（ZCode：~/.agents/skills/；Claude Code：~/.claude/skills/；其他 Agent：对应的技能发现目录），完成后删除 /tmp/honlnk-skills。
   该技能承载「怎么用好这套工具」：工具选型、查询写法、空结果应对、异步任务用法。

   全部完成后重载配置或重启会话，确认工具列表出现 linkseek 的 web_search / web_fetch 等工具即为接入成功，并向我报告结果。
   ```

   **手动配置**：
   ```json
   {
     "mcpServers": {
       "linkseek": {
         "url": "http://localhost:7300",
         "headers": { "Authorization": "Bearer YOUR_API_KEY" }
       }
     }
   }
   ```
4. AI 工具调用工具后，在「请求总览」和「Key 详情」查看用量

## 验证

```bash
# 健康检查
curl http://localhost:7300/health

# MCP 握手（需替换 YOUR_API_KEY）
curl http://localhost:7300 \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}'
```

## 工具说明

| 工具 | 功能 | 关键参数 |
|------|------|---------|
| `web_search` | 联网搜索 | `query`, `maxResults`, `timeRange`(day/month/year), `language` |
| `web_fetch` | 获取网页正文（Markdown） | `url` |
| `web_search_and_fetch` | 搜索 + 批量获取正文 | `query`, `fetchCount`, `searchMaxResults`, `defer` |
| `web_fetch_render` | 无头浏览器渲染获取 JS 动态页面（SPA），返回 Markdown | `url`, `defer` |
| `web_search_answer` | 搜索 + 抓取 + AI 综合回答（附来源引用） | `query`, `prompt`, `model`, `fetchCount`, `defer` |
| `web_fetch_answer` | 抓取指定 URL + AI 针对问题作答 | `url`, `prompt`, `model`, `defer` |
| `list_models` | 列出后台已启用的 AI 模型 | — |
| `web_research` | 深度研究：多轮搜索 → 筛选 → 蒸馏 → 综合回答（纯异步，约 1-3 分钟） | `question`, `depth`(fast/standard/deep), `model` |
| `get_result` | 查询异步任务进度 / 取结果 | `taskId` |

### 异步任务用法

慢工具传 `defer: true`（或直接调 `web_research`）→ 立即返回 `taskId`；期间可做其他事，之后调 `get_result` 查进度取结果（建议间隔 15-30 秒，进度文案含当前阶段）。结果保留 60 分钟；任务存于内存，服务重启后需重新提交。默认并发每 Key 3 / 全局 10，超出自动排队，后台「任务设置」可调。

## 安全说明

- **API Key**：以 SHA-256 哈希存储在数据库，明文仅在创建时返回一次
- **管理员密码**：argon2id 哈希存储
- **SSRF 防护**：阻断 RFC1918 私有地址、`169.254.169.254`（云元数据）、loopback 等危险范围；自定义 DNS lookup 固定解析结果防 rebinding；重定向逐跳重新校验
- **浏览器渲染的 SSRF 防护**：`web_fetch_render` 依赖独立 browser-fetch 微容器，微容器内部自行做 URL 校验 + DNS 解析过滤（浏览器自己做 DNS 会绕过主服务防护），用安全 IP 直连 + 原 Host 头
- **SSRF_STRICT**：设为 `true` 额外阻断 `reserved`/`multicast` 段（生产服务器推荐；开发机用 fake-ip 代理时保持 `false`）

## 项目结构

```
├── prisma/                  # 数据库 schema + 迁移 + seed
├── src/                     # 后端（Node.js + Express + TypeScript）
│   ├── index.ts             # 入口：MCP + REST API + 静态托管
│   ├── config.ts            # 环境变量校验
│   ├── lib/                 # Prisma 客户端 / SystemSetting 存取
│   ├── auth/                # 鉴权（KeyStore / verifier / session）
│   ├── admin/               # 管理 REST API（auth/keys/stats/settings 路由）
│   ├── tools/               # MCP 工具实现
│   ├── tasks/               # 异步任务系统（TaskManager 队列与调度 / defer / 执行器）
│   ├── research/            # web_research 深度研究流水线
│   ├── llm/                 # 多协议 LLM Provider 适配（OpenAI/Anthropic/Gemini/Responses）
│   ├── search/              # SearXNG 搜索
│   ├── fetch/               # 网页获取 + SSRF 防护
│   └── utils/               # 日志 + 用量记录 + 请求上下文
├── web/                     # 管理后台 SPA（Vue 3 + Naive UI + Vite）
│   └── src/views/           # 登录 / 总览 / Key列表 / Key详情
├── searxng/                 # SearXNG 配置
│   ├── settings.yml         # 配置模板（含 __SEARXNG_PROXY__ 占位符）
│   └── docker-entrypoint.sh # 启动时注入代理地址到 settings.yml
├── browser-fetch/           # 浏览器渲染微容器（Playwright + Chromium，独立进程）
│   └── src/                 # Express /render 服务 + SSRF 防护
├── deploy/                  # 生产部署配置
│   ├── docker-entrypoint.sh # 容器启动：migrate → 初始化管理员 → 启动 node
│   └── nginx/               # Nginx 配置（linkseek-gateway 专属 + honlnk-gateway 分流）
├── Dockerfile               # 主服务镜像（多阶段构建，已发布 honlnk/linkseek）
├── docker-compose.yml       # 本地开发（仅 MySQL + SearXNG + browser-fetch 依赖容器）
└── docker-compose.prod.yml  # 生产编排（双层网关 + 全量服务）
```

## 生产部署

生产采用**双层网关模式**，让 linkseek 作为独立项目自洽运行：

```
公网:443 → honlnk-gateway(共享, HTTPS 终止) → linkseek-gateway(项目专属, HTTPS) → linkseek-app:7300
```

- `honlnk-gateway` 是全机共享的 Nginx（占 80/443），只做按域名分流
- `linkseek-gateway` 是项目专属 Nginx 容器，自管 SSE 长连接 / SPA 路由 / 安全头
- 镜像 `honlnk/linkseek` / `honlnk/linkseek-browser-fetch` 从 Docker Hub 拉取，服务器上无需源码

详见 [`docs/部署指南.md`](docs/部署指南.md)。
