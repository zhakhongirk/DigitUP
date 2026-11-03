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

# Worker bundle: esbuild (shipped with tsx) inlines the TypeScript sources and
# resolves the @/ alias, so the runtime image needs no node_modules.
FROM build AS worker-bundle
RUN <<'BUNDLE'
node --input-type=module -e '
import { createRequire } from "node:module";
import { cpSync } from "node:fs";
const esbuild = createRequire(createRequire(import.meta.url).resolve("tsx"))("esbuild");
await esbuild.build({
  entryPoints: { worker: "server/worker.ts", migrate: "db/migrate.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pg-native"],
  banner: { js: "import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);" },
});
cpSync("db/migrations", "dist/migrations", { recursive: true });
'
BUNDLE

# Event worker (plain node on the bundle)
FROM node:24-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
COPY --from=worker-bundle /app/dist ./dist
# The worker owns schema migrations: apply them, then start consuming jobs.
CMD ["sh", "-c", "node dist/migrate.js && node dist/worker.js"]
