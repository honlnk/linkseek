import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7317,
    proxy: {
      '/api': {
        target: 'http://localhost:7300',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
