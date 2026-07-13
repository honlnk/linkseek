#!/bin/sh
set -e

echo "==> 执行数据库迁移..."
prisma migrate deploy

echo "==> 初始化管理员账号（如果设置了 ADMIN_PASSWORD）..."
# 用 CJS 内联脚本跑 seed，无需 tsx
ADMIN_PASSWORD="${ADMIN_PASSWORD}" node --input-type=commonjs -e "
const { PrismaClient } = require('./dist/generated/prisma-client');
const argon2 = require('argon2');
(async () => {
  const pwd = process.env.ADMIN_PASSWORD;
  if (!pwd || pwd.length < 6) { console.log('  ADMIN_PASSWORD 未设置或太短，跳过'); return; }
  const prisma = new PrismaClient();
  const hash = await argon2.hash(pwd);
  await prisma.adminUser.upsert({
    where: { id: 1 },
    update: { passwordHash: hash },
    create: { id: 1, passwordHash: hash },
  });
  console.log('  ✅ 管理员账号已就绪');
  await prisma.\$disconnect();
})();
"

echo "==> 启动 linkseek 服务..."
exec node dist/index.js
