# IF TERMINAL —— 零 npm 依赖, 无需构建步骤
FROM node:22-alpine

WORKDIR /app

# 零依赖: 没有 package-lock / node_modules, 直接拷贝源码即可运行
COPY server.js package.json ./
COPY public/ ./public/
COPY docs/ ./docs/
COPY test/ ./test/
COPY README.md AGENT-API.md LICENSE ./

ENV PORT=8787
ENV TZ=Asia/Shanghai

EXPOSE 8787

# 健康检查: /api/health 返回 ok 即视为存活
HEALTHCHECK --interval=60s --timeout=8s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
