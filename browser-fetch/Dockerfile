# browser-fetch 微容器
# 基于官方 Playwright 镜像（自带 Chromium + 系统依赖）
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# 复制源码
COPY src ./src

EXPOSE 9100

# Playwright 镜像已预装浏览器，直接启动
CMD ["node", "src/index.js"]
