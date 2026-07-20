import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7317,
    proxy: {
      // 后台前端的 /api 请求转发到后端 7300。
      // 后端按 Host 分流：admin 域名才暴露 /api，默认站点（localhost）会 404。
      // 因此转发时必须把 Host 改成 admin 域名，让后端识别为后台请求。
      '/api': {
        target: 'http://localhost:7300',
        changeOrigin: true,
        headers: { Host: 'admin.linkseek.honlnk.com' },
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
