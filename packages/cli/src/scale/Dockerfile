FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/bench/package.json ./packages/bench/package.json
COPY packages/cli/package.json ./packages/cli/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages ./packages
RUN pnpm --filter benchmarks build
RUN pnpm exec esbuild packages/cli/src/scale/sdk-coordinator.ts \
      --bundle \
      --platform=node \
      --target=node20 \
      --format=cjs \
      --outfile=packages/cli/dist/scale.cjs

FROM node:24-alpine

WORKDIR /app
COPY --from=builder /app/packages/cli/dist/scale.cjs /app/coordinator.cjs

CMD ["node", "/app/coordinator.cjs"]
