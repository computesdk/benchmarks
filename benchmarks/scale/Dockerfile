FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/benchsdk/package.json packages/benchsdk/
COPY tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY benchmarks ./benchmarks
COPY packages/benchsdk ./packages/benchsdk
RUN pnpm --filter benchsdk run build
RUN pnpm run --silent bundle:scale

FROM node:24-alpine

WORKDIR /app
COPY --from=builder /app/dist/scale.cjs /app/coordinator.cjs

CMD ["node", "/app/coordinator.cjs"]
