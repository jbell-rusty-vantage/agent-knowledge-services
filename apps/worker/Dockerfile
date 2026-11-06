FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY . .
RUN corepack enable && corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @aiengineer/knowledge-worker... build
RUN corepack pnpm --filter @aiengineer/knowledge-worker deploy --prod --legacy /release

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
USER node
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
