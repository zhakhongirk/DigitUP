# Agentic Storefront

AI commerce infrastructure for small businesses. An owner uploads price lists and documents (spreadsheets, PDFs, Word files, CSV), reviews the business model drafted from them, and launches a storefront. The storefront has a store assistant chat for shoppers and MCP endpoints that other AI agents can use to browse the catalog and place orders.

## How it works

### Owner flow

1. Sign up and upload files at `/onboarding`.
2. The worker extracts the files and drafts a business model (profile, categories, offers, policies). With an LLM configured the business agent writes the draft; without one a rule-based importer builds it from the tables and text (prices, currencies, stock, contacts, policies) and lists what is missing.
3. The owner reviews and edits the draft at `/onboarding/review`, then launches the store.
4. The storefront goes live at `/s/:slug`.
5. `/app` is the owner area (see below).

Sign in at `/signin`. Signing out ends the session on this device. Settings has "Sign out everywhere" to end all of them.

#### Owner area

- **Workspace home**: overview of the store.
- **Notifications** (`/app/notifications`): linked from the Workspace header with an unread count. The worker adds a notification for each new order, new question, approval requested by an agent, and when the store goes live. Opening one marks it read and takes you to it; "Mark all as read" clears the rest.
- **Inbox** (`/app/inbox`): orders and shopper questions. The owner changes order statuses and answers questions; customer agents read the answer through `get_inquiry`.
- **Approvals** (`/app/approvals`, change sets in the API): approve or reject risky catalog edits proposed by the business agent.
- **Catalog**: search, edit and archive offers. "Update from file" (`/app/catalog/import`) reads a new price list and creates one pending approval; offers missing from the file are listed but not deleted. The catalog can be exported as CSV.
- **Analytics**: activity over the last 7 or 30 days, with an orders CSV export. Orders and catalog exports are served at `/app/export/orders` and `/app/export/catalog`.
- **Connect agents**: MCP endpoint URLs, and creating and revoking API keys.
- **Audit log**: everything that changed the store.
- **Settings**: store profile and policies, and password change (other sessions are signed out).

The inbox and the audit log are paginated without a cap on the number of pages.

### Customer side

- Shoppers chat with the store assistant on `/s/:slug`. It can search the catalog, check prices and availability, answer questions about the store, and prepare a draft order that is only placed after confirmation. Without an LLM a rule-based assistant handles the chat (English and Russian).
- Orders are only submitted after the buyer explicitly confirms the summary.
- Anything the assistant cannot handle becomes a question (inquiry) for the owner, visible in the inbox.
- After an order is confirmed, the chat links to the buyer order status page at `/s/:slug/orders/:orderId`. The link itself is the credential, so keep it private.
- Offer images on the storefront are served through `next/image`.
- Storefront pages carry metadata, Open Graph tags and JSON-LD, and the app serves `/sitemap.xml` and `/robots.txt`. `APP_URL` sets the public base URL used for them (for example `https://shop.example.com`; defaults to the request host or `http://localhost:3000` locally).

### Agent side (MCP)

All endpoints are served by the Next.js app over HTTP. The tenant is fixed by authentication or by the slug before any tool runs.

| Endpoint              | Auth                            | Tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/mcp/public/:slug`   | none                            | `talk_to_store` (talks to the store assistant, keep one `session_id` per conversation)                                                                                                                                                                                                                                                                                                                                                                                   |
| `/mcp/customer/:slug` | customer-agent API key (bearer) | `search_offers`, `get_offer_details`, `check_availability`, `compare_offers`, `get_business_info`, `create_order`, `submit_inquiry`, `get_inquiry`                                                                                                                                                                                                                                                                                                                       |
| `/mcp/business`       | owner API key (bearer)          | `get_business_model`, `search_offers`, `list_source_assets`, `propose_business_model`, `confirm_business_model`, `upsert_offers`, `update_prices`, `update_offer_types`, `update_policies`, `delete_offers`, `list_orders`, `get_order`, `update_order_status`, `list_inquiries`, `get_inquiry`, `answer_inquiry` (owner session only), `update_inquiry_status`, `list_conversations`, `get_conversation`, `list_change_sets`, `approve_change_set`, `reject_change_set` |

`create_order` is two-step: call it with `submit=false` to get a summary, then again with the same idempotency key and `submit=true` once the shopper has confirmed. A `contact` (name, phone, email or note) passed on the confirming call is saved on the draft before it is submitted.

High-risk catalog changes made through the business endpoint (price updates, deletions, bulk upserts) are not applied directly. They create a pending approval (a change set in the API) that the owner approves in the UI first.

`pnpm db:seed` creates API keys for the demo stores (see below).

## LLM configuration

The LLM is any OpenAI-compatible API. The app uses three Meta models, one per tier (`server/llm/router.ts` maps each call site to a tier):

| Tier  | Model                   | Provider              | Used for                                                                                      |
| ----- | ----------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| main  | `muse-spark-1.3`        | Meta Model API        | storefront chat, `talk_to_store` on the public MCP endpoint, the owner agent                  |
| fast  | `meta/muse-glimmer-30b` | NVIDIA (open weights) | rewriting shopper phrases the deterministic search in `server/services/intent` could not read |
| heavy | `muse-wonder-1.0`       | Meta Model API        | onboarding: reading files and proposing the catalog                                           |

Variables read by `server/llm` (see `.env.example`):

| Variable                                                                     | Required | Notes                                                                                       |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL`                                   | yes      | main tier; base URL defaults to `https://api.meta.ai/v1`                                    |
| `LLM_FAST_API_KEY`, `_MODEL`, `_BASE_URL`                                    | no       | fast tier; `LLM_FAST_BASE_URL=https://integrate.api.nvidia.com/v1`                          |
| `LLM_HEAVY_API_KEY`, `_MODEL`, `_BASE_URL`                                   | no       | heavy tier                                                                                  |
| `LLM_*_REASONING_EFFORT`, `LLM_*_REASONING_TOKENS`                           | no       | per tier, falls back to the main value                                                      |
| `LLM_TOOL_CALL_MODE`, `LLM_*_TOOL_CALL_MODE`                                 | no       | `native` (default) or `json`                                                                |
| `LLM_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_*_TIMEOUT_MS`, `LLM_*_MAX_RETRIES` | no       | request timeout (25000 ms; heavy tier 90000) and retries (1)                                |
| `LLM_DAILY_TOKEN_BUDGET`                                                     | no       | tokens per store and UTC day for shopper chat and `talk_to_store` (2000000; `0` = unlimited) |
| `LLM_JSON_RESPONSE_FORMAT`                                                   | no       | `true` (default) or `false`                                                                 |

A tier without settings of its own uses the main one. The main API key is sent only to the main base URL, never to the host of another tier. Token usage of every call is stored in `llm_usage` with the tier.

When a model call fails (timeout, API error, empty reply) before any tool ran, or a store has used its daily token budget, the same message is answered by the rule-based assistant instead. The owner agent and onboarding are not limited by the budget.

Without a key and model the app still runs. The store assistant (storefront chat and `talk_to_store`) falls back to a rule-based assistant (`server/storefront/fallback-assistant.ts`) that searches the catalog, answers price, availability and store info questions, drafts an order and asks for confirmation, and passes other questions to the owner. It understands English and Russian. Onboarding drafts come from the rule-based importer. The customer and business MCP tools, the inbox and the audit log do not call the LLM, so the seeded demo stores work fully without a key.

Run `pnpm llm:probe` to test your provider and see which tool call mode it recommends.

### Evaluation

`scripts/eval` measures how well a shopper agent does on the seeded stores in three setups: A uses only the raw customer tools, B uses `find_offers` and `get_business_info`, C uses `find_offers`, the raw tools and `report_answer`. The shopper model is the main tier at temperature 0. The run reads the stores through the keyed customer MCP endpoint and writes only analytics rows (intent events, search misses, LLM usage); no orders or inquiries are created.

```bash
pnpm db:seed                      # once; prints a customer-agent key per store
pnpm eval:gold                    # resolves queries.jsonl to offer ids and copies prices and availability from the database
export EVAL_CUSTOMER_KEY=...      # or EVAL_CUSTOMER_KEY_STRIDE_SHOES / EVAL_CUSTOMER_KEY_FADE_FACTORY
pnpm dev                          # in another terminal
pnpm eval -- --config B --runs 1 --limit 3     # quick check
pnpm eval                         # all configs, 3 runs per query
```

Flags: `--config A,B,C`, `--runs N`, `--limit N`, `--lang ru|kk|en`, `--query <id>`, `--base-url`, `--out <dir>`. Results go to `scripts/eval/out/<date>/` (`runs.jsonl`, `report.md`, `report.html`, `scores.json`); `pnpm eval:report [dir]` rebuilds the report from a finished run. Set `EVAL_PRICE_INPUT` and `EVAL_PRICE_OUTPUT` (USD per million tokens) to fill the cost column. `gold.jsonl` and `catalog.json` are generated, so run `pnpm eval:gold` again after `pnpm db:reset`. Expected offers are written by title in `queries.jsonl`.

## Architecture

- **Next.js 16 app** (App Router): pages, server actions, API routes and the MCP endpoints.
- **Worker process** (`server/worker.ts`): a separate Node process that consumes pg-boss jobs (file extraction, model drafting and other event handlers). Handlers are idempotent.
- **PostgreSQL**: application data (Drizzle ORM, SQL migrations in `db/migrations`) and the pg-boss queues.
- **Services** (`server/services`): tenancy, catalog, orders, conversations, ingestion, approvals, audit and provisioning. Every call carries a tenant context, so data is isolated per store, and changes are recorded in the audit log.
- **Rate limits** (`server/http/rate-limit.ts`): per-IP limits on sign-up, sign-in, the storefront chat, order confirmation and the public MCP endpoint. They are kept in process memory, which fits a single app instance. The client IP is read from `X-Forwarded-For`, counting `TRUST_PROXY_HOPS` entries from the right (default 1, the nearest proxy). Set it to 0 when the app runs behind no proxy, so the header is ignored and `X-Real-IP` or `unknown` is used. Sign-in is also limited per account (failed attempts only), password changes are limited too, and re-analyzing a store is limited per store. Set `RATE_LIMIT_DISABLED=1` to turn the limits off.
- **Logging** (`server/log.ts`): structured JSON lines, warnings and errors on stderr, the rest on stdout. Fields such as passwords, tokens and keys are redacted. `LOG_LEVEL` (`debug`, `info`, `warn` or `error`, default `info`) sets the minimum level. `proxy.ts` assigns an `x-request-id` to requests on `/api` and `/mcp` (an incoming valid id is kept) and returns it in the response header.
- **File storage**: uploads are written to `STORAGE_DIR`. The app and the worker must see the same directory. Upload size is counted on the actual stream, and zip-based archives are checked before they are parsed.
- **Sessions**: each account has a session version. "Sign out everywhere" and password changes increment it, so previously issued session cookies stop working. Plain sign-out only clears the cookie on that device.

## Running locally

Prerequisites: Node.js 22 or newer, pnpm 10, Docker.

```bash
docker compose up -d postgres
cp .env.example .env        # then fill in AUTH_SECRET and the LLM variables
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev                    # http://localhost:3000
pnpm worker                 # in a second terminal
```

`AUTH_SECRET` is any long random string. `DATABASE_URL` in `.env.example` already matches the compose database. `APP_TIMEZONE` (default `Asia/Almaty`) sets the time zone for dates shown to owners and buyers.

`pnpm db:seed` creates two live demo stores, skipping any that already exist:

| Slug           | Owner login               | Store      |
| -------------- | ------------------------- | ---------- |
| `stride-shoes` | `owner@stride-shoes.demo` | shoe store |
| `fade-factory` | `owner@fade-factory.demo` | barbershop |

The password for both is `demo-password-123`. For each store it creates, the seed also adds demo activity spread over the last two weeks: conversations, orders, questions and approvals. Existing stores are left untouched. The seed also prints an owner API key and a customer-agent API key for each new store (shown once, so copy them from the output).

`pnpm demo:data` writes sample onboarding files to `demo-data/`: `shoe-catalog.xlsx`, `store-terms.pdf` and `barbershop-prices.csv`. Upload them at `/onboarding` to try the full flow.

### Everything in Docker

`docker-compose.yml` also defines `app` (port 3000) and `worker` services built from the `Dockerfile`. They read `.env` if present, use the compose Postgres, and share an `uploads` volume.

```bash
docker compose up --build
```

The worker image runs a bundled `dist/worker.js` with plain node (built in the Dockerfile), and applies migrations on start. `GET /api/health` checks the database and returns 503 when it is down. `/api/health?live=1` is a liveness check that does not touch the database.

## Scripts

| Script              | What it does                              |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Next.js dev server                        |
| `pnpm build`        | Production build                          |
| `pnpm start`        | Start the production build                |
| `pnpm worker`       | Run the event worker                      |
| `pnpm lint`         | ESLint                                    |
| `pnpm typecheck`    | `tsc --noEmit`                            |
| `pnpm test`         | Run the test suite once (Vitest)          |
| `pnpm test:watch`   | Vitest in watch mode                      |
| `pnpm format`       | Prettier, write                           |
| `pnpm format:check` | Prettier, check only                      |
| `pnpm llm:probe`    | Check the LLM provider and tool call mode |
| `pnpm db:generate`  | Generate a migration from schema changes  |
| `pnpm db:migrate`   | Apply migrations                          |
| `pnpm db:seed`      | Create the demo stores and demo activity  |
| `pnpm demo:data`    | Generate sample files in `demo-data/`     |
| `pnpm eval`         | Run the shopper-agent evaluation          |
| `pnpm eval:gold`    | Build the gold set from the seeded stores |
| `pnpm eval:report`  | Rebuild the report of a finished run      |

## Testing

```bash
docker compose up -d postgres
pnpm test
pnpm lint
pnpm typecheck
pnpm format:check
```

GitHub Actions (`.github/workflows/ci.yml`) runs the format check, lint, typecheck, tests against a Postgres service, and the build on every push and pull request.

The tests need Postgres. On start, they create a separate database named like the one in `DATABASE_URL` with `_test` appended (or use `TEST_DATABASE_URL`) and apply migrations to it, so your development data is not touched.

## Project layout

```
app/          Next.js routes: onboarding, owner area (app), storefront (s), signin, mcp, api
db/           Drizzle schema, migrations, migrate and seed scripts, seed data
server/       Backend code
  agents/     Business (onboarding) and customer agents, agent runtime
  events/     pg-boss publisher, event types and handlers
  llm/        LLM client and configuration
  mcp/        MCP servers (public, customer, business) and HTTP entry points
  onboarding/ Onboarding flow and review logic
  owner/      Owner session and data for the owner area (workspace, inbox, approvals, catalog, analytics, audit, settings)
  http/       Rate limiting and bounded form parsing
  services/   Tenant-scoped domain services
  storage/    Upload storage
  storefront/ Storefront data and chat
  worker.ts   Worker entry point
shared/       Types and schemas shared by app and server (business model)
scripts/      demo-data and llm-probe
demo-data/    Sample onboarding files
tests/        Vitest suites and helpers (app: owner actions, e2e: owner journey)
.github/      CI workflow
public/       Static assets
```
