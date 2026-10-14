# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data WEB_DIR=/app/web ACC_MIGRATIONS_DIR=/app/migrations
# único módulo nativo; versão fixada (a 13 exige Node 22 e foi evitada no desenvolvimento)
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund better-sqlite3@12.11.1
COPY --from=build /src/dist/api/main.mjs ./main.mjs
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/packages/storage/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
