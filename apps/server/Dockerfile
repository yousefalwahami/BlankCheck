# Game server image (Railway / Render / Fly). Build from the repo root:
#   docker build -f apps/server/Dockerfile -t blank-check-server .
FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@blankcheck/server..."

COPY packages/shared packages/shared
COPY apps/server apps/server

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
CMD ["pnpm", "--filter", "@blankcheck/server", "start"]
