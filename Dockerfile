# syntax=docker/dockerfile:1.7
# ---- 阶段 1: builder ----
FROM node:20-slim AS builder

# 装构建依赖（argon2 等原生模块需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 装 pnpm
RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

WORKDIR /app

# 先复制依赖描述文件 + workspace 配置，利用 Docker 层缓存做依赖安装
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json ./web/package.json

# 装全部依赖（含 devDeps，构建需要 tsc/vite/vue-tsc）
RUN pnpm install --frozen-lockfile \
    && pnpm store prune

# 生成 Prisma 客户端（schema 引用 src/generated 路径，需要先有 schema）
COPY prisma ./prisma
RUN pnpm exec prisma generate

# 复制源码（注意：用 .dockerignore 排除了 node_modules/dist，
# 所以 web/node_modules 不会被覆盖）
COPY tsconfig.json ./
COPY types ./types
COPY src ./src
COPY web/index.html web/vite.config.ts web/tsconfig.json web/tsconfig.node.json ./web/
COPY web/src ./web/src

# 构建前端 SPA
RUN pnpm web:build

# 构建后端 TypeScript
RUN pnpm exec tsc

# ---- 阶段 2: deps（专门装生产依赖，与 runner 分离便于清理）----
FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json ./web/package.json

# 装生产依赖（prisma 已在 dependencies，迁移时用 ./node_modules/.bin/prisma）
RUN pnpm install --frozen-lockfile --prod \
    && pnpm store prune

# ---- 阶段 3: runner（最终镜像）----
FROM node:20-slim AS runner

# 装 openssl（Prisma 引擎依赖）+ curl（排障用），合并为一层并清理缓存
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl curl tini \
    && rm -rf /var/lib/apt/lists/*

# 用 tini 做 PID 1，正确处理信号（优雅退出）
ENTRYPOINT ["/usr/bin/tini", "--"]

WORKDIR /app

# 从 deps 阶段拷贝生产依赖（已 prune，无 store）
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules

# 从 builder 拷贝构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
# Prisma client 是预生成的 JS，tsc 不会编译它；手动复制到 dist/generated
# （src/lib/prisma.ts 引用 ../generated/prisma-client，编译后路径是 dist/generated/...）
COPY --from=builder /app/src/generated ./dist/generated

# 复制 Prisma migration + schema（启动时执行 migrate）
COPY --from=builder /app/prisma ./prisma

# 复制 package.json（运行时 prisma CLI 通过 pnpm exec 调用）
COPY package.json pnpm-workspace.yaml ./

# 启动脚本：先跑迁移，再启动应用
COPY deploy/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
