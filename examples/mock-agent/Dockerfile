FROM node:20-alpine
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY examples/mock-agent/package.json ./examples/mock-agent/
COPY packages/sdk/package.json        ./packages/sdk/
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY examples/mock-agent/ ./examples/mock-agent/
COPY packages/sdk/src/    ./packages/sdk/src/

WORKDIR /app/examples/mock-agent
CMD ["node", "--import", "tsx/esm", "index.ts"]
