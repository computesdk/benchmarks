FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/benchsdk/package.json packages/benchsdk/
COPY packages/benchsdk-api/package.json packages/benchsdk-api/
COPY packages/benchsdk-worker/package.json packages/benchsdk-worker/
COPY packages/benchsdk-runner/package.json packages/benchsdk-runner/
COPY packages/benchsdk-cli/package.json packages/benchsdk-cli/
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY benchmarks ./benchmarks
COPY packages/benchsdk ./packages/benchsdk
COPY packages/benchsdk-api ./packages/benchsdk-api
COPY packages/benchsdk-worker ./packages/benchsdk-worker
COPY packages/benchsdk-runner ./packages/benchsdk-runner
COPY packages/benchsdk-cli ./packages/benchsdk-cli
# Build @benchsdk/client and its workspace dependencies (runner, cli, api, worker)
# so the scale coordinator can resolve them at bundle time.
RUN pnpm --filter "@benchsdk/client..." run build
RUN pnpm run --silent bundle:scale

FROM node:24-alpine

WORKDIR /app
COPY --from=builder /app/dist/scale.mjs /app/coordinator.mjs

CMD ["node", "/app/coordinator.mjs"]
