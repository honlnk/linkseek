import type { RequestHandler } from 'express';
import session from 'express-session';
import MemoryStore from 'memorystore';
import { config } from '../config.js';

const MemoryStoreTyped = MemoryStore(session);

/**
 * 管理后台会话中间件。
 *
 * 单实例部署用 memorystore 即可（进程内存，重启丢失）。
 * cookie 设 httpOnly + sameSite=lax。
 *
 * secure 选项：
 * - 生产环境在 HTTPS 反代后面，COOKIE_SECURE=true（需配合 trust proxy）
 * - 本地 HTTP 开发环境，COOKIE_SECURE=false
 */
export const sessionMiddleware = session({
  store: new MemoryStoreTyped({ checkPeriod: 86_400_000 }),
  name: 'wf_admin_sid',
  secret: config.SESSION_SECRET ?? 'dev-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 8, // 8 小时
  },
});

/** 扩展 session 类型，带上 adminId */
declare module 'express-session' {
  interface SessionData {
    adminId?: number;
  }
}

/** 要求管理员登录的中间件，未登录返回 401 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.session.adminId) {
    res.status(401).json({ error: '未登录' });
    return;
  }
  next();
};
