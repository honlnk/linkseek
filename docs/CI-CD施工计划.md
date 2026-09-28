# linkseek CI/CD（GitHub Actions + Docker Hub + 服务器脚本化发布）—— 施工计划

> 状态：**已完工**（2026-09-29 验收通过：v0.2.0/v0.2.1 双版本发布 + 回滚实证，详见施工日志）
> 定稿：2026-09-29 与用户对齐（方案选型：GitHub Actions + 继续用 Docker Hub + ssh 到 volcano-honlnk 执行发布脚本；借鉴 ~/work/jiyacr 的云效 Flow 方案思路，逐项映射到 GitHub 生态）
> 前置调研：jiyacr 方案的核心资产是「tag 驱动构建 + 语义化镜像版本钉在服务器 .env + deploy-release.sh（备份/健康检查/回滚）」，该脚本不依赖任何云厂商，可近乎原样移植。

## 0. 背景与目标

现状是纯手动部署：本地 `docker build && push latest` → ssh 服务器 `compose pull && up -d`。问题：latest 滚动无版本、发布无门禁无验收、出问题没有回滚路径、手工步骤易漏易错。

本期建成一条自动化发布链：

```
push tag v* → GitHub Actions：
  校验（版本号/main 归属/类型检查）
  → 构建并推 Docker Hub（honlnk/linkseek:<版本> + latest）
  → rsync 同步部署文件到 volcano-honlnk
  → ssh 执行 deploy-release.sh（备份 → 改版本 → pull → up → 健康检查 → 失败自动回滚）
手动通道：deploy.yml（workflow_dispatch 输入版本号，可部署/回滚任意历史版本）
```

## 1. 已拍死的决策（无开放选择题）

| 决策点 | 结论 |
|---|---|
| CI 平台 | GitHub Actions，workflow 放 `.github/workflows/`（天然版本管理，无需同步脚本） |
| 镜像仓库 | **继续 Docker Hub**（`honlnk/linkseek`，镜像开源给人 pull）；不迁 GHCR、不双推 |
| 触发方式 | `push: tags: ['v*']` → **全自动构建+部署**（打 tag 本身就是显式发布动作，不再加审批卡点） |
| 人工审批卡点 | **不做**（单人项目）；将来要加只需给 deploy job 加 `environment: production` 一行 |
| 镜像 tag 策略 | 每次发布推两个 tag：`<语义化版本>`（部署用）+ `latest`（仅供开源用户 pull，**服务器永不部署 latest**） |
| 版本纪律 | tag `v0.2.0` ↔ 镜像 tag `0.2.0` ↔ `package.json` version 三者一致；CI 校验 tag==package.json version，不一致即失败；**tag 必须打在 main 上**（`git merge-base --is-ancestor` 校验） |
| 服务器版本钉法 | `docker-compose.prod.yml` 的 app image 改为 `honlnk/linkseek:${APP_IMAGE_TAG:-latest}`；服务器 `.env` 里的 `APP_IMAGE_TAG` 由 deploy 脚本 `sed` 写入（追加式，不动 MYSQL_* 既有键） |
| 部署通道 | Actions 云端 runner → ssh/rsync 直连 volcano-honlnk。**不用 appleboy/\* 等第三方 action**——deploy job 手工装配 ssh key（secret 写入 runner 的 `~/.ssh` + keyscan），用原生 `ssh`/`rsync`，供应链依赖最小化 |
| 发布脚本 | 新增 `deploy/deploy-release.sh`（POSIX sh，移植 jiyacr 方案 §9-2），CI 每次发布前 rsync 到服务器 `/home/honlnk/linkseek/` 执行——**脚本版本与 tag 严格同步，服务器不留独立副本漂移** |
| 同步的部署文件 | 每次发布 rsync：`docker-compose.prod.yml` + `deploy/deploy-release.sh` → 服务器根目录；`deploy/nginx/` → `nginx/`；`searxng/` → `searxng/`。**不带 --delete**，绝不触碰 `.env`、`env/`、`ssl/`、`backups/`、状态文件 |
| 发布动作范围 | `$dc up -d app gateway`（只动业务与项目网关，mysql/searxng/browser-fetch 不跟发）；up 后追加 `nginx -t && nginx -s reload` 让 linkseek-gateway 感知同步来的 conf 变更（`-t` 失败则告警跳过，运行中的旧 conf 不受影响） |
| 部署前备份 | 每次发布前 `mysqldump`（linkseek 库，gzip，`backups/pre-release-*.sql.gz`，保留最近 5 份）——无条件执行 |
| 健康检查 | 两个 URL，`curl --resolve <host>:443:127.0.0.1` 打本机 honlnk-gateway 全链路：① `https://linkseek.honlnk.com/health`（HTTP 200）② `https://admin.linkseek.honlnk.com/`（HTTP 200）；36 次 × 5s 轮询 |
| 自动回滚 | **默认开启**（ALLOW_ROLLBACK=true）：健康检查失败 → dump linkseek-app/linkseek-gateway 日志 → `.env` 改回旧版本 tag → pull + up -d → exit 1；旧版本取自状态文件 `.last-deployed-linkseek`，兜底从运行容器镜像名提取 |
| 回滚边界 | 只回滚镜像，**不回滚数据库迁移**（迁移在容器启动时执行）；失败提示语沿用 jiyacr：「若本次发布含迁移，注意旧代码+新 schema 混合态」 |
| 磁盘水位 | 发布前检查 `/` 剩余 ≥ 2048MB，不足拒绝部署 |
| Docker Hub 拉取限流 | 部署时 CI 把 `DOCKERHUB_USERNAME/TOKEN` 经 ssh 环境变量传入脚本，脚本先 `docker login`（公共镜像本可匿名拉，登录消除火山云出口 IP 共享限流风险）；未注入时沿用服务器已保存登录态 |
| 构建平台 | 仅 `linux/amd64`（服务器已核实 x86_64）；multi-arch 列入不做清单 |
| check job | `pnpm install --frozen-lockfile && pnpm db:generate && pnpm typecheck`（后端类型检查快速失败；web 的 vue-tsc 在镜像构建内完成，不重复跑） |
| 专用 ssh key | 新生成 ed25519 密钥对（`linkseek-ci`），公钥追加到 volcano 的 `authorized_keys`，私钥进 GitHub secret；不复用个人密钥，泄露可单独吊销 |
| 权限基线 | workflow 顶层 `permissions: contents: read` |

### GitHub Secrets 清单（阶段 2 配置）

| Secret | 用途 |
|---|---|
| `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` | build job 推镜像 + deploy 时服务器拉取登录 |
| `VOLCANO_HOST` / `VOLCANO_USER` / `VOLCANO_SSH_KEY` | deploy job ssh/rsync（115.190.219.215 / honlnk / 专用私钥） |

## 2. 明确不做清单（本期诱惑项）

- ❌ GitHub Environments 人工审批卡点（单人项目；加卡点=一个 `environment:` 字段，将来随要随加）
- ❌ multi-arch 镜像（arm64 等真有开源用户提出再加：buildx + QEMU 平台矩阵已预留）
- ❌ GHCR 迁移 / 双仓库推送
- ❌ release-please / semantic-release 自动版本管理（手动打 tag，CI 只做一致性校验）
- ❌ staging 环境、多服务器部署
- ❌ mysql / searxng / browser-fetch 的自动重建（`up -d app gateway` 不触碰；searxng 配置变更属罕见操作，手动 `docker compose -f docker-compose.prod.yml up -d --force-recreate searxng`，写入文档）
- ❌ 数据库迁移失败的自动回滚（人工处置，脚本给混合态警告）
- ❌ 单元测试 / e2e job（项目无测试基建，异步任务批次后再议；本期只做 typecheck 门禁）
- ❌ 服务器上装 self-hosted runner（选择 ssh 模式，生产机不常驻 CI 进程）
- ❌ 不 push、不打 tag，除非用户明示（本任务验收依赖真实 push，见阶段 3——**打 tag 由用户执行或明确授权后执行**）

## 3. 新旧机制替代表

| 机制 | 去向 |
|---|---|
| 本地手动 `docker build + push latest` | **删除**（CI 接管；latest 仍由 CI 推，但仅面向开源用户） |
| 服务器手动 `compose pull && up -d` 更新 | **降级为应急通道**（部署指南改写为「应急手册」：CI 挂了/需要手工介入时的操作步骤） |
| `docker-compose.prod.yml` 写死 `image: honlnk/linkseek:latest` | **替换**为 `honlnk/linkseek:${APP_IMAGE_TAG:-latest}`（fallback latest 保证旧 .env 也能 up） |
| `.env.production.example` | 追加 `APP_IMAGE_TAG` 说明项 |
| `docs/部署指南.md`「更新版本」章节 | **改写**为「版本发布（CI/CD）」：打 tag 全自动 + workflow_dispatch 手动回滚 + secrets 清单 + 应急手册 |
| README 若含手动部署叙述 | 施工时核对，改一句话指向部署指南（有才改，没有不加） |
| jiyacr 的 VMDeploy / 人工卡点 / 子模块锚定 | **不迁移**（对应替换为 ssh 直连 / 不设卡点 / 单仓 tag 天然锚定） |

## 4. 施工波次

### 阶段 1：仓库侧交付物（纯本地，不 push）

新增/修改：

1. **`deploy/deploy-release.sh`**（新）——移植 jiyacr `deploy-release.sh`，按 §1 决策裁剪：
   - 单项目化：去掉 PROJECT 映射表，入参只有 `APP_VERSION` 环境变量（semver 强校验）
   - 流程：磁盘水位 → docker login（可选）→ 记旧版本 → mysqldump 备份 → 写 `.env` 的 `APP_IMAGE_TAG` → `compose config` 校验 → `pull app` → `up -d app gateway` → gateway `nginx -t && reload` → 健康检查（2 URL × 36×5s）→ 失败 dump 日志 + 回滚 → 成功写状态文件
   - 无 sudo（volcano 的 honlnk 在 docker 组，已核实）
   - 验证门禁：`sh -n` 语法过 + 逐段人工核对与 jiyacr 原版的行为差异记录进施工日志
2. **`docker-compose.prod.yml`**（改）——app image 变量化；注释块同步改（「镜像从 Docker Hub 拉取」补版本钉定说明）
3. **`.github/workflows/release.yml`**（新）——tag 触发四 job：`validate`（semver + package.json 一致 + tag 在 main 上）→ `check`（typecheck）→ `build`（buildx + login-action + metadata-action semver 双 tag + gha 缓存，仅 amd64）→ `deploy`（装配 ssh key → rsync 四组文件 → ssh 执行脚本，传 APP_VERSION/DOCKERHUB_*）
4. **`.github/workflows/deploy.yml`**（新）——`workflow_dispatch` 输入 `version`，跑与 release.deploy 相同的同步+执行（回滚=部署旧版本号）
5. **`.env.production.example`**（改）——补 `APP_IMAGE_TAG` 示例与注释
6. **`docs/部署指南.md`**（改）——§3 替代表所述章节改写
7. **`docs/CI-CD施工计划.md`**（本文档）——状态流转 + 施工日志随门禁落盘

门禁：`sh -n deploy-release.sh` 通过；`pnpm typecheck` 不回归；workflow YAML 过 actionlint（本机 brew 装，装不上则降级为缩进/字段人工核对并在日志记录）；文档全部写盘。

### 阶段 2：一次性环境准备（本机 + 服务器 + GitHub）

1. 本机生成专用密钥对 `ssh-keygen -t ed25519 -f ~/.ssh/linkseek_ci -C linkseek-ci`；公钥追加 volcano 的 `authorized_keys`（验通：`ssh -i ~/.ssh/linkseek_ci honlnk@115.190.219.215 true`）
2. `gh secret set` 写入 5 个 secrets（gh 未登录则给用户网页操作清单，属用户动作）
3. Docker Hub 确认 `honlnk/linkseek` 仓库存在（已存在，latest 在推）
4. 服务器 `mkdir -p /home/honlnk/linkseek/backups`

门禁：ssh 专用密钥验通；`gh secret list` 五项齐全。

### 阶段 3：首次发布全链路演练（含回滚实证）

> 打 tag 属于对外发布动作：**每一步 push 前向用户确认，或由用户亲自执行**。

1. dev 合入 main，bump `package.json` version → `0.2.0`，用户打 tag `v0.2.0` 并 push
2. 观察 release.yml 全链路：validate/check/build 绿 → Docker Hub 出现 `0.2.0` + `latest` 双 tag → deploy job 同步文件、执行脚本、健康检查通过
3. 服务器核验：`docker ps`（app 用新镜像）、`.env` 多出 `APP_IMAGE_TAG=0.2.0`、`backups/` 有 pre-release 备份、`.last-deployed-linkseek` 存在、`https://linkseek.honlnk.com/health` 返回 ok
4. **回滚实证**：bump `0.2.1` → 发 v0.2.1 → 成功后用 deploy.yml 手动部署 `0.2.0` → 核验容器回到 0.2.0 且健康 → 再手动部署 `0.2.1` 恢复最新。回滚路径由此被真实执行过一次，不是纸面能力
5. 收尾：文档状态流转「已完工」、施工日志补齐、结项提交（文档与代码一笔，遵循仓库 `feat(docs)/fix(scope)` 前缀惯例）

门禁：上述 3、4 全部通过；异常时走应急手册恢复（手动 `APP_IMAGE_TAG=<旧> up -d`），修完重新演练。

## 5. 验收清单（含降级方案）

| 验收项 | 验证方式 | 降级兜底 |
|---|---|---|
| workflow 语法合法 | actionlint（本机） | 无 brew 则首跑让 GitHub 解析报错兜底 |
| 发布脚本语法 | `sh -n` | 无需降级 |
| 镜像构建与双 tag | Docker Hub 页面见 `0.2.0`+`latest` | — |
| 自动部署+健康检查 | release.yml 绿 + /health ok | 失败自动回滚 + 应急手册 |
| 回滚路径真实可用 | 阶段 3 第 4 步实证 | — |
| secrets/密钥配好 | `gh secret list` + 专用 key ssh 验通 | 网页操作清单交用户 |
| 迁移/管理员初始化不被破坏 | 部署后 `docker logs linkseek-app` 见迁移成功与启动日志 | — |

## 6. 文档同步计划

- 本文档：门禁时点更新状态行与施工日志（日期+阶段+验收结论+偏差）
- `docs/部署指南.md`：阶段 1 内改写完成，阶段 3 后按实证结果修正细节（如健康检查耗时段位）
- 施工日志格式：`日期 | 阶段 | 关键改动/偏差 | 验收结论`

## 施工日志

### 2026-09-29 | 阶段 1：仓库侧交付物

- 新增 `deploy/deploy-release.sh`（自 jiyacr §9-2 移植，单项目化、无 sudo、Docker Hub 登录、双 URL 健康检查、默认自动回滚、gateway reload 感知 conf 变更）
- `docker-compose.prod.yml`：app image → `honlnk/linkseek:${APP_IMAGE_TAG:-latest}`，头注释同步
- 新增 `.github/workflows/release.yml`（validate → check → build → deploy 四 job）与 `deploy.yml`（workflow_dispatch 手动部署/回滚）
- `.env.production.example` 补 `APP_IMAGE_TAG` 说明；`docs/部署指南.md`「更新版本」改写为「版本发布（CI/CD）+ 应急手册」，修正过时的 browser-fetch 镜像描述
- 门禁：`sh -n` / `bash -n` PASS；actionlint PASS（brew 安装）；`pnpm typecheck` PASS
- **偏差记录**：
  1. mysqldump 由 jiyacr 的「管道直灌 gzip」改为「先落临时文件校验退出码与非空，再压缩」——原写法在 dash 下 mysqldump 失败会被 gzip 的成功退出码掩盖，产生空备份假成功。行为增强，流程不变。
  2. 两个 workflow 的 ssh 命令加 `# shellcheck disable=SC2029` 豁免注释——变量在 runner 侧展开后随命令传入服务器是设计意图（GitHub step env → 远端命令字符串），非缺陷。
  3. `deploy.yml` 增加 `ref` 输入参数（计划未显式列出）——部署文件默认取 main，可填历史 tag 精确复现当时配置，等价 jiyacr 的 DEPLOY_REF 锚定能力，成本一个参数。

### 2026-09-29 | 阶段 2：一次性环境准备

- 生成专用密钥 `~/.ssh/linkseek_ci`（ed25519，无口令），公钥追加 volcano `authorized_keys`（幂等 grep 防重复）
- 专用密钥直连验通（`honlnk@115.190.219.215`，主机名 honlnk-huoshan）
- `gh secret set` 写入 VOLCANO_SSH_KEY / VOLCANO_HOST / VOLCANO_USER / DOCKERHUB_USERNAME（DOCKERHUB_TOKEN 由用户先行配置）
- `gh secret list` 五项齐全 ✅；服务器 `backups/` 目录已建
- 无偏差

### 2026-09-29 | 阶段 3：首发演练 + 回滚实证（全链路验收）

**发布流程**（按用户指定：PR → 合 main → 打 tag）：
- CI/CD 批次 + v0.2.0 bump 提交到 dev（PR #2），merge commit `a982e9c`，tag `v0.2.0`
- release run `36473048472`：校验/类型检查/构建推送/发布到生产四 job 全绿
- 服务器核验 ✅：`linkseek-app` 运行 `honlnk/linkseek:0.2.0`、`.env` 多出 `APP_IMAGE_TAG=0.2.0`、`backups/pre-release-*.sql.gz` 生成、`.last-deployed-linkseek=0.2.0`、`/health` 返回 ok、admin 站 200

**回滚实证**（计划阶段 3 第 4 步）：
- v0.2.1 版本基线经 PR #3（`a49c2fc`）合入并发布成功（run `36473879738`，gha 缓存已热，构建明显加速）
- deploy.yml workflow_dispatch `version=0.2.0`（run `36474671251`）✅：服务器回到 0.2.0，健康检查通过——**回滚路径经真实执行验证，非纸面能力**
- 再 `version=0.2.1`（run `36474818877`）✅：恢复最新版，最终态 0.2.1 + 健康
- 副产物：backups/ 积累 4 份 pre-release 备份（保 5 策略内，下次发布自动裁剪）

**偏差与备注**：
1. v0.2.0 内容范围：dev 全量合入（含异步任务系统 `7d4212a` 与 CORS 修复 `660edd6`）；另一在途批次的未提交改动（README + 门户页工具文档）**有意排除**，未混入发布提交。后续补记：该批次在窗口期内被提交为 `0f57840`，位于 v0.2.1 bump 之前，**已随 PR #3 / v0.2.1 上线**（纯文档改动，即异步计划中「随部署批次一起做」项，结果符合其本意）
2. CI 构建告警（不影响功能，记录备查）：actions Node 20 弃用提示、ubuntu-latest 将于 2026-10-19 迁移 Ubuntu 26——届时如构建异常先查这两个公告
3. 验收清单全部通过；「回滚实证」从降级项升级为真实执行项
