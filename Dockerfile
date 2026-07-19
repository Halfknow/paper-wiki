# PaperWiki v3 生产镜像：node server.js 直跑（守护/重启交给 Docker restart 策略，pm2 退役）
FROM node:20-slim

WORKDIR /app

# 仅装生产依赖（pg/pdfjs-dist 等均为纯 JS，无需编译工具链）
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8888 \
    PAPERS_ROOT=/papers \
    BACKUP_DIR=/app/backups

# backups named volume 首次初始化会继承镜像内目录属主，先建好并交给 node（避免 EACCES）
RUN mkdir -p /app/backups && chown node:node /app/backups

EXPOSE 8888
USER node

CMD ["node", "src/server.js"]
