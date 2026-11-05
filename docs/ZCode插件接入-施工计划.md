# linkseek ZCode 插件接入 —— 施工计划

> 状态：已定稿，待施工
> 创建日期：2026-11-06
> 关联会话：sess_766ca710（zcode 与 dsh 插件机制对比）、本计划所在会话

## 一、背景与目标

linkseek 是自托管的远程 MCP 服务（Streamable HTTP + Bearer 鉴权，9 个工具）。ZCode 支持以「插件」形式分发 MCP 配置 + Skill。本计划为 linkseek 仓库新增一层插件壳，让 ZCode 用户可以通过「插件市场 → 添加市场 → 安装 linkseek」完成接入，替代当前「手抄 MCP 配置 + 手装 Skill」的方式。

**核心判断（已核实）**：服务端零改动。插件是客户端侧的「配置 + 技能」壳，复用现有 MCP 端点。仓库为 public（github.com/honlnk/linkseek），市场索引可以用 `git-subdir` 直接指到本仓库子目录，免去 zip / sha256 / 独立市场仓库 / CI 改动。

## 二、已拍板的决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| API Key 配置方式 | 先按「manifest 普通字符串字段 + 明文警告」实现；冒烟测试若发现 headers 里 `${user_config.apiKey}` 不展开，退回「README 引导用户手填 `.mcp.json`」 | 官方样本只证明 `${user_config.*}` 在 env 和 url 字段可展开，headers 无先例，需实验确认 |
| Skill 内容来源 | 把 `~/.agents/skills/linkseek-usage/SKILL.md` + `references/findings.md` 复制进插件目录，两处并存 | 个人技能库那份继续用于非插件场景；插件版去硬编码工具前缀 |
| marketplace.json 位置 | 放仓库根目录，插件壳放 `zcode-plugin/` 子目录 | 仓库 public，`git-subdir` 直接可用；不打 zip |
| 本期范围 | **只做 linkseek 插件**；PicSense 插件留到下期 | 跑通一个再复制结构，风险更低 |
| 本地验证实例 | `http://localhost:7300`（本机 dev）+ 真实 API Key | 生产实例留到验收尾段可选验证 |

## 三、改动范围

### 3.1 新增文件（全部新增，不改已有文件）

```
linkseek/
├── zcode-plugin/                        # 新增：插件根目录
│   ├── .zcode-plugin/
│   │   └── plugin.json                  # manifest
│   ├── .mcp.json                        # HTTP MCP 配置（含占位符）
│   └── skills/
│       └── linkseek-usage/
│           ├── SKILL.md                 # 从个人技能库复制后改写
│           └── references/
│               └── findings.md          # 一并复制（含模板）
├── marketplace.json                     # 新增：市场索引（根目录）
└── docs/
    └── ZCode插件接入-施工计划.md          # 本文档
```

### 3.2 不动的东西

- `src/` `web/` `prisma/` `Dockerfile` `docker-compose*.yml` —— 服务端代码与部署产物零改动
- `pnpm-workspace.yaml` —— 不加入 `zcode-plugin/`（它不是工作区包）
- `.github/workflows/` —— 不动 CI
- `package.json` —— 插件版本独立于服务端版本，plugin.json 自带 version 字段

### 3.3 需要改动的已有文件

仅 `README.md` 的「使用流程 → 接入 AI 工具」小节：在现有「一键接入」「手动配置」两条路径之前新增第三条路径「ZCode 插件安装（推荐 ZCode 用户）」，指到插件市场安装方式。原有手动配置路径保留，作为插件不可用或占位符实验失败时的兜底方案。

## 四、插件内容设计

### 4.1 plugin.json 字段

| 字段 | 值 |
|---|---|
| name | `linkseek` |
| version | `0.1.0`（插件独立版本号，与服务端 0.3.0 解耦） |
| description | 自托管联网搜索与网页抓取 MCP 服务（含 9 个工具） |
| description_i18n | en / zh-CN 双语 |
| author | `{ "name": "honlnk" }` |
| license | MIT |
| mcpServers.linkseek.type | `http` |
| mcpServers.linkseek.url | `${user_config.instanceUrl}` |
| mcpServers.linkseek.headers.Authorization | `Bearer ${user_config.apiKey}` |
| mcpServers.linkseek.timeoutMs | `200000` |
| skills | `"skills"` |

### 4.2 userConfig 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| instanceUrl | string | 是 | 实例地址，如 `https://linkseek.honlnk.com` 或 `http://localhost:7300`；描述里给三选一获取途径（自己部署 / 借用 / 体验） |
| apiKey | string | 是 | API Key；描述里明确写「以普通字符串字段存储，请使用专用 Key，避免复用高权限凭证」 |

两个字段均无默认值，由用户在插件设置里填写。不引入 sensitive 字段（已验证官方样本无先例，且历史调研表明 UI 无法持久化）。

### 4.3 .mcp.json

内容与 plugin.json 的 mcpServers 节保持一致（官方样本中两者并存，`.mcp.json` 用于本地直读，`plugin.json` 内联用于市场分发场景）。

### 4.4 Skill 改写规则

从 `~/.agents/skills/linkseek-usage/` 复制 `SKILL.md` 与 `references/findings.md`，做以下定向修改，**其余正文不动**：

| 位置 | 改动 |
|---|---|
| frontmatter `description` | 「出现 `mcp__linkseek__*` 工具」改为「出现 linkseek 提供的联网搜索 / 抓取工具（`web_search` / `web_fetch` 等，前缀以实际配置为准）」，不再硬编码 MCP 命名空间 |
| 第七节「已知边界」 | 末尾追加一条：「本技能通过 ZCode 插件分发时，MCP 工具名可能带插件命名空间前缀，实际以当前会话工具列表为准」 |
| 其余全部正文、模板、findings.md 内容 | 原样保留 |

### 4.5 marketplace.json

放仓库根目录，结构对齐官方 claude 市场：

```json
{
  "name": "honlnk-plugins",
  "version": 1,
  "description": "honlnk 自托管工具的 ZCode 插件市场",
  "owner": { "name": "honlnk", "url": "https://github.com/honlnk" },
  "plugins": [
    {
      "name": "linkseek",
      "version": "0.1.0",
      "description": "自托管联网搜索 + 网页抓取 MCP 服务",
      "author": { "name": "honlnk" },
      "category": "developer-tools",
      "keywords": ["mcp", "search", "fetch", "linkseek"],
      "componentTypes": ["mcp", "skill"],
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/honlnk/linkseek.git",
        "path": "zcode-plugin",
        "ref": "main",
        "sha": "<施工时填入提交 hash>"
      }
    }
  ]
}
```

## 五、阶段划分与验收

### 阶段一：骨架与静态检查

**任务**：
1. 创建 `zcode-plugin/` 目录及全部文件（plugin.json / .mcp.json / SKILL.md / findings.md）
2. 创建根目录 `marketplace.json`（`sha` 字段先占位为 `"TBD"`）
3. 不动 README、不动服务端代码

**验收**：
- 所有新增 JSON 文件通过 `python3 -I -m json.tool` 语法校验
- `plugin.json` 与 `.mcp.json` 的 mcpServers 节字段值完全一致
- Skill 的 frontmatter `description` 中不再出现 `mcp__linkseek__*` 字面量
- 目录结构与 3.1 节一致，无遗漏

**门禁**：全过才进阶段二。

### 阶段二：本地市场安装冒烟测试

**前置**：本地 `http://localhost:7300` 实例已启动，已创建测试用 API Key。

**任务**：
1. ZCode 插件市场添加本地目录（指向本仓库根，让 marketplace.json 生效）
2. 安装 linkseek 插件
3. 在插件设置里填入 instanceUrl = `http://localhost:7300`，apiKey = 测试 Key
4. **新建任务**（插件机制要求新任务才加载 MCP），观察工具列表

**验收**：
- 工具列表出现 linkseek 的 9 个工具（web_search / web_fetch / web_fetch_answer / web_fetch_render / web_search_and_fetch / web_search_answer / web_research / get_result / list_models）
- 调用 `list_models` 返回正常响应（证明鉴权通过、userConfig 展开正确）
- 调用 `web_search` 用关键词 `github` 测试，返回非空结果

**关键判定点**：
- 若 `list_models` 返回 401 / 鉴权错误 → 说明 `${user_config.apiKey}` 在 headers 中未展开。记录到「偏差与备选方案」节，执行备选方案（见 6.2）
- 若工具列表为空 → 检查插件是否正确加载、是否需要重启 ZCode，排查后再继续

**门禁**：冒烟通过才进阶段三。

### 阶段三：README 与文档收尾

**任务**：
1. README「使用流程 → 接入 AI 工具」小节新增「ZCode 插件安装」段落（位于原「一键接入」之前）
2. 段落内容：三步——添加市场 URL（`https://raw.githubusercontent.com/honlnk/linkseek/main/marketplace.json`）→ 安装 linkseek → 设置里填实例地址和 API Key，附截图占位（截图留给后续补）
3. 把 marketplace.json 中的 `sha` 字段从 `"TBD"` 替换为阶段一提交的真实 commit hash
4. 提交（遵循本仓库 commit 规范：`feat(plugin): ...` 前缀）

**验收**：
- README 渲染正常，新增段落不与原「一键接入」「手动配置」冲突
- marketplace.json 的 `sha` 指向有效 commit
- 提交信息符合仓库风格（参考 `feat(search): 新增 Exa/DeepSeek 商业兜底引擎`）

## 六、偏差与备选方案

### 6.1 已预见的偏差

无。

### 6.2 备选方案：headers 占位符不展开时的退路

若阶段二验证发现 `${user_config.apiKey}` 在 HTTP headers 中不展开：

1. **首选退路**：改 `.mcp.json` 与 `plugin.json`，headers 字段写死为 `"Authorization": "Bearer REPLACE_ME"`，并在 plugin.json 的 userConfig 描述和 README 里明确引导用户「安装后编辑插件目录下的 `.mcp.json`，把 REPLACE_ME 替换为真实 Key」
2. **次选退路**：在服务端 `src/` 增加 `?key=` 查询参数鉴权作为备选通道（这会突破「服务端零改动」原则，需要单独立项评审，不在本期范围）

## 七、明确不做清单

- **不改服务端代码**：`src/` `web/` `prisma/` 全部冻结
- **不改 CI / CD**：不新增 workflow、不改现有 deploy/release 流程
- **不动 honlnk-skills 仓库**：插件版 Skill 是副本，个人技能库那份不动
- **不做 PicSense 插件**：留到下期，复用本期结构
- **不做插件自动更新机制**：依赖 ZCode 自带的市场刷新机制
- **不发 zip 到 CDN**：仓库 public + git-subdir 已够用
- **不做插件官网/落地页**：README 一个段落即可
- **不提交、不 push**：除非用户明确要求

## 八、新旧机制替代关系

| 接入方式 | 去向 |
|---|---|
| 现有 README「一键接入」（复制提示词给 AI） | **保留**，适用于所有 MCP 宿主，不限于 ZCode |
| 现有 README「手动配置」 | **保留**，作为插件不可用或自定义场景的兜底 |
| 新增「ZCode 插件安装」 | **新增**，ZCode 用户的首选路径 |

三者并存，README 段落顺序：插件安装（ZCode 用户）→ 一键接入（其他宿主）→ 手动配置（兜底）。

## 九、文档同步计划

| 时机 | 动作 |
|---|---|
| 阶段一完成 | 本文档顶部「状态」改为「阶段一完成」，追加施工日志条目（日期 + 提交 hash + 验收结论） |
| 阶段二完成 | 状态改为「阶段二完成」，追加日志，记录关键判定点的实际结果（headers 是否展开） |
| 阶段三完成 | 状态改为「已完成」，追加日志与最终提交 hash |
| 触发备选方案 | 在 6.2 节下方追加「实际选用」记录，写明选了哪条退路、为什么 |

施工日志格式：

```
## 施工日志

### YYYY-MM-DD 阶段N
- 提交：<hash>
- 验收结论：<全过 / 哪项不过>
- 偏差：<无 / 描述>
```

## 十、本项目规范速查（施工时遵守）

- **commit 前缀**：`feat(plugin):` / `docs(plugin):` / `chore(plugin):`，参考 `git log` 风格
- **测试命令**：本期不涉及业务代码，无需跑 `pnpm test`；JSON 语法校验用 `python3 -I -m json.tool`
- **验收环境限制**：阶段二需要本机 linkseek dev 实例 + 真实 API Key，如无法启动则与用户协商改用官网生产实例（https://linkseek.honlnk.com）
- **推送纪律**：本计划不含 push / PR，需要时用户另行指示

## 施工日志

（待施工时填写）
