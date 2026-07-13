import { createRouter, createWebHistory } from 'vue-router';
import { checkLogin } from './api.js';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/Login.vue'),
    },
    {
      path: '/',
      component: () => import('./views/Layout.vue'),
      children: [
        {
          path: '',
          name: 'dashboard',
          component: () => import('./views/Dashboard.vue'),
        },
        {
          path: 'keys',
          name: 'keys',
          component: () => import('./views/KeyList.vue'),
        },
        {
          path: 'keys/:id',
          name: 'key-detail',
          component: () => import('./views/KeyDetail.vue'),
        },
      ],
    },
  ],
});

/** 路由守卫：非登录页检查登录状态 */
router.beforeEach(async (to) => {
  if (to.name === 'login') return true;
  const loggedIn = await checkLogin();
  if (!loggedIn) {
    return { name: 'login' };
  }
  return true;
});
