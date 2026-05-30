FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/server/package.json ./packages/server/
COPY packages/sdk/package.json     ./packages/sdk/
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY packages/ ./packages/
RUN pnpm --filter @kaif/server build

FROM node:20-alpine AS runtime
WORKDIR /app

COPY --from=builder /app/node_modules                  ./node_modules
COPY --from=builder /app/packages/server/dist          ./packages/server/dist
COPY --from=builder /app/packages/server/node_modules  ./packages/server/node_modules
COPY --from=builder /app/packages/server/package.json  ./packages/server/package.json
COPY packages/server/config ./config

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

WORKDIR /app/packages/server

CMD ["node", "dist/index.js"]
