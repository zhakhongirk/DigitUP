# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN npm install -g pnpm@10.34.9
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# Next.js app (standalone output)
FROM node:24-alpine AS app
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]

# Event worker (runs TypeScript through tsx)
FROM deps AS worker
COPY . .
ENV NODE_ENV=production
# The worker owns schema migrations: apply them, then start consuming jobs.
CMD ["sh", "-c", "pnpm db:migrate && pnpm worker"]
