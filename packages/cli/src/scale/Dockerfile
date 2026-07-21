FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
RUN npm run --silent bundle:scale

FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/scale.cjs /app/coordinator.cjs

CMD ["node", "/app/coordinator.cjs"]
