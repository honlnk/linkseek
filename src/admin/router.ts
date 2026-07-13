import { Router } from 'express';
import { createAuthRouter } from './auth-routes.js';
import { createKeyRouter } from './key-routes.js';
import { createStatsRouter } from './stats-routes.js';

/**
 * 管理后台 REST API 总路由。
 * 挂载在 /api 下。
 *
 * /api/login、/api/logout、/api/me 无需登录即可访问（login 除外逻辑特殊）。
 * 其余路由均需 requireAdmin 中间件保护（在各子路由内部挂载）。
 */
export function createAdminRouter(): Router {
  const router = Router();
  router.use('/', createAuthRouter());
  router.use('/keys', createKeyRouter());
  router.use('/stats', createStatsRouter());
  return router;
}
