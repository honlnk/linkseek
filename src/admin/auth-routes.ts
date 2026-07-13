import { Router } from 'express';
import argon2 from 'argon2';
import { prisma } from '../lib/prisma.js';
import { requireAdmin } from '../auth/session.js';

export function createAuthRouter(): Router {
  const router = Router();

  /** POST /api/login —— 密码登录 */
  router.post('/login', async (req, res) => {
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ error: '请输入密码' });
      return;
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: 1 } });
    if (!admin) {
      res.status(500).json({ error: '管理员账号未初始化，请先运行 db:seed' });
      return;
    }

    const ok = await argon2.verify(admin.passwordHash, password).catch(() => false);
    if (!ok) {
      res.status(401).json({ error: '密码错误' });
      return;
    }

    req.session.adminId = admin.id;
    res.json({ ok: true });
  });

  /** POST /api/logout —— 退出登录 */
  router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        res.status(500).json({ error: '退出失败' });
        return;
      }
      res.clearCookie('wf_admin_sid');
      res.json({ ok: true });
    });
  });

  /** GET /api/me —— 检查登录状态（前端路由守卫用） */
  router.get('/me', requireAdmin, (_req, res) => {
    res.json({ loggedIn: true });
  });

  /** POST /api/change-password —— 修改管理员密码 */
  router.post('/change-password', requireAdmin, async (req, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      res.status(400).json({ error: '新密码至少 6 位' });
      return;
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: 1 } });
    if (!admin) {
      res.status(500).json({ error: '管理员账号不存在' });
      return;
    }

    const ok = await argon2.verify(admin.passwordHash, currentPassword).catch(() => false);
    if (!ok) {
      res.status(401).json({ error: '当前密码错误' });
      return;
    }

    const passwordHash = await argon2.hash(newPassword);
    await prisma.adminUser.update({ where: { id: 1 }, data: { passwordHash } });
    res.json({ ok: true });
  });

  return router;
}
