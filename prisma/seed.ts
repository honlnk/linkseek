import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma-client/index.js';

const prisma = new PrismaClient();

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 6) {
    throw new Error('ADMIN_PASSWORD 环境变量未设置或长度不足 6 位');
  }

  const passwordHash = await argon2.hash(password);

  // upsert：已存在则更新密码，不存在则创建（固定 id=1）
  const admin = await prisma.adminUser.upsert({
    where: { id: 1 },
    update: { passwordHash },
    create: { id: 1, passwordHash },
  });

  console.log(`✅ 管理员账号已就绪 (id=${admin.id})`);
}

main()
  .catch((e) => {
    console.error('❌ seed 失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
