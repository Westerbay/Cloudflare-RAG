# Small RAG

A source-grounded Markdown chatbot hosted on **Cloudflare Workers, Workers AI, D1 and Vectorize**, using **Cloudflare’s own service quotas**, without a manual daily question counter. No Raspberry Pi, GPU server, PostgreSQL instance or Docker deployment is required for the active architecture.

The deployment uses free-tier-eligible products. **There is no guaranteed daily answer count or application spending cap.** AI input/output length, indexing, other applications sharing the account, and platform limits determine when a free allocation is exhausted. Stay on Workers Free, do not enable prepaid AI Gateway billing, and review the [free-tier limits](docs/deployment.md#free-tier-boundaries). This project never automatically upgrades a plan or retries through a paid provider.

## Architecture

- **Workers:** authenticated `POST /v1/chat` and health endpoints.
- **Workers AI:** `@cf/meta/llama-3.1-8b-instruct-fp8` for generation and `@cf/qwen/qwen3-embedding-0.6b` for 1024-dimensional embeddings.
- **D1:** source passages, original chunk hashes, line ranges and the active index generation.
- **Vectorize:** cosine search, isolated by index-generation namespace.
- **Wrangler:** infrastructure bindings, migrations, secrets and deployment. The configuration and repeatable resource setup live in `infra/`.
- **TypeScript:** the Worker, Markdown extraction, deterministic chunking, ingestion and infrastructure tooling use one pnpm workspace.

The pnpm workspace layout and shared Zod contracts are inspired by [WebApp Template](https://github.com/Westerbay/WebApp-Template). `apps/api` owns the Worker; `packages/core`, `packages/contracts` and `packages/database` own pure rules, boundary schemas and D1 persistence. See [development](docs/development.md) for commands and boundaries.

The [architecture guide](docs/architecture.md) describes indexing, grounding and the quota. The [deployment guide](docs/deployment.md) contains account setup, permissions, secrets, testing and recovery.

## Install and validate locally

Use Node.js 24 and pnpm 12. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm infra:setup
pnpm corpus:index
```

The last two commands are **plans**: they neither create Cloudflare resources nor send documents to a provider. `build` bundles the Worker with `wrangler deploy --dry-run`; it does not deploy. Tests use local SQLite and model stand-ins, without a Cloudflare account. No Python installation, virtual environment or Docker service is needed for these commands.

## Configure and deploy

Use a **Workers Free** account. Supply `CLOUDFLARE_ACCOUNT_ID` and an account-scoped `CLOUDFLARE_API_TOKEN` through your operator environment; see [permissions and secure entry](docs/deployment.md#operator-credentials). Never commit a token. Then run:

```sh
pnpm infra:setup --apply
pnpm db:migrate:remote
pnpm corpus:index --corpus examples/corpus --apply
pnpm deploy
node infra/wrangler.ts secret put BASIC_AUTH_PASSWORD
```

`infra:setup --apply` reuses or creates the named D1 database and Vectorize index, checks dimensions/metric and saves non-secret IDs in ignored `infra/wrangler.local.json`. It does not change billing, deploy code, write secrets or apply migrations. Each later remote command is explicit. Choose an authentication password of at least 16 characters; Wrangler prompts for it. Until configured, the service returns 503. The HTTP Basic username is `rag` for every route, including health checks.

Wrangler prints your `https://small-rag.<subdomain>.workers.dev` URL. A purchased domain is optional. Test with your actual URL:

```sh
curl -u rag https://small-rag.YOUR-SUBDOMAIN.workers.dev/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What does the corpus say about the Raspberry Pi?","history":[]}'
```

`curl` prompts for the password. The response includes `status` (`answered`, `insufficient_context` or `out_of_scope`), `answer`, and `citations` with original chunk IDs, relative source paths and line ranges. This is an API; it does not include a chat web interface.

## Cloudflare quotas and service sleep

There is no local question quota. When a Cloudflare binding fails, the API returns HTTP 503 with `status: "sleeping"`, the affected `service`, and `Retry-After`. Recognized Workers AI daily-allocation errors and D1 daily-row-limit errors pause requests until **00:00 UTC**, exposed as `reset_at`. Other failures pause for one minute; `retry_at` indicates when a new request may probe availability, not a promised quota reset. There is no background polling or automatic retry of the failed question.

The pause is cached per Worker isolate, without requiring D1 writes. While cached, chat and readiness calls skip all downstream bindings; authenticated liveness stays available. New isolates and already-running requests may still reach Cloudflare, which enforces the account-wide limits. If the Workers request quota itself is exhausted, Cloudflare can reject the request before our handler runs. Monthly quotas may need a monthly reset; storage limits require operator action, not waiting until tomorrow. Stay on Workers Free for provider-enforced free limits: a paid account can continue billing instead of reporting exhaustion. Indexing and development calls consume the same account allocations.
The free-tier profile accepts up to 1500 characters per question, four history turns totalling 2000 characters, a 16 KiB request body, 3000 evidence characters and 200 generated tokens. Oversized input is rejected instead of silently truncated. Evidence is bounded before generation. Invalid model output, unknown citations, absent indexes and provider outages fail closed with HTTP 503.

## Index your documents

Keep your Markdown files in a local directory such as ignored `data/corpus/`. Preview first:

```sh
pnpm corpus:index --corpus data/corpus
pnpm corpus:index --corpus data/corpus --apply
```

Only `.md` and `.markdown` files are read. The operator profile allows up to 100 files and 1000 chunks. It sends passages to Workers AI for embedding and stores them in D1; queries and selected passages are also processed by Cloudflare. There is no public ingestion endpoint. Unchanged corpora are detected before new embeddings are requested. Indexing stages a new generation and waits for the Vectorize mutation before activating it in D1. Run only one indexing job per index at a time.

Edit `prompts/system.md` for the mission and JSON contract and `prompts/SOUL.md` for style, then rebuild/deploy. Prompt edits do not require reindexing. The native TypeScript extractor has a new versioned recipe: run an explicit reindex after migrating from Python. Switching the embedding model or extraction/chunking recipe also requires reindexing; the existing PostgreSQL index is not migrated or mixed with Cloudflare embeddings.

## Development and historical backend

`pnpm dev` runs the Worker handler locally but uses **remote AI, Vectorize and D1 bindings** after setup. It accesses real indexed documents and the same Cloudflare allocations. Configure its local Basic Auth secret as described in the [development guide](docs/deployment.md#local-development). AI and Vectorize are not offline emulators. Use `pnpm test` for offline behavior checks.

The previous Python/FastAPI + PostgreSQL/pgvector + llama.cpp implementation is retained as an inactive archive in `src/small_rag/`, `database/`, the Compose files and `scripts/benchmark_*.py`. It is **not the Cloudflare runtime**. See [legacy deployment](docs/legacy-deployment.md) and [historical Pi measurements](docs/performance.md). These archives are excluded from the pnpm workspace and its checks; old Python commands are not part of the supported setup. No existing database, model file, container or Git history is deleted by this migration.
