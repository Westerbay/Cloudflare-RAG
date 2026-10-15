# Deploy Small RAG to Cloudflare

The target is Cloudflare Workers Free, Workers AI, D1 and Vectorize. There is no VM, GPU rental, Container subscription or PostgreSQL server. `workers.dev` supplies an HTTPS address without purchasing a domain. These instructions create remote state only when you run the explicitly marked remote commands.

## Prerequisites

Use Node.js 24 and pnpm 12 for the API, tooling and offline corpus preparation. Install the locked workspace dependencies:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Tests use SQLite and fake AI/Vectorize bindings; the build is Wrangler's deployment dry run. None of these steps provisions Cloudflare resources or calls hosted inference. Wrangler is installed locally through `pnpm-lock.yaml`; no global installation, Pulumi account or infrastructure state service is required.

## Operator credentials

Create a Cloudflare account and keep its Workers plan on **Free**. Obtain the account ID and an API token scoped to that account with **D1 Edit**, **Vectorize Write** and **Workers AI Read** permissions for resource setup and ingestion. Wrangler deployment and Worker-secret management additionally need **Workers Scripts Edit** (and the account read permissions required by Wrangler); alternatively authenticate Wrangler separately with its interactive `login` command. Use a scoped API token rather than a Global API Key. Permission names and availability should be checked in the current Cloudflare dashboard.

Supply public identifiers and secrets in your shell or secret manager. This interactive example keeps the token out of the typed command history:

```sh
export CLOUDFLARE_ACCOUNT_ID='YOUR_32_CHARACTER_ACCOUNT_ID'
printf 'Cloudflare API token: '
read -r -s CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN
```

Never paste the token into a chat, commit it, or put it in Wrangler `vars`. The scripts do not read secret files or print provider error bodies. The deployed Worker uses its AI/D1/Vectorize bindings and does not need this operator API token.

## Infrastructure setup

Inspect the local plan:

```sh
pnpm infra:setup
```

Then explicitly apply it to the selected account:

```sh
pnpm infra:setup --apply
pnpm db:migrate:remote
```

The setup script reuses a D1 database named `small-rag`, or creates it when absent. It similarly reuses or creates the `small-rag` Vectorize index with **1024 dimensions and cosine distance**. An incompatible existing vector index is an error; it is not replaced or deleted. Use a dedicated account/resource naming convention and inspect existing names before the first apply. On a partial failure, rerun setup to reuse resources already created.

Generated account and database identifiers go into ignored `infra/wrangler.local.json`. Keep a private operational copy if desired; it contains identifiers, not API tokens or the HTTP password. `infra/wrangler.jsonc` remains the portable source template. `infra/wrangler.ts` chooses the generated file for subsequent commands and refuses remote operations while IDs are unconfigured. Setup does not apply migrations, deploy, create secrets, subscribe to a plan or enable billing.

D1 schema changes live in `packages/database/migrations/`. `pnpm db:migrate:local` uses only the local Wrangler database; `pnpm db:migrate:remote` changes the configured Cloudflare D1 database. Do not point that configuration at a shared or production database without reviewing the exact target and migration.

## Index and deploy

Preview the example corpus and then publish it:

```sh
pnpm corpus:index
pnpm corpus:index --apply
pnpm deploy
node infra/wrangler.ts secret put BASIC_AUTH_PASSWORD
```

Choose a strong Basic Auth password of at least 16 characters when prompted; the username is `rag`. Until the secret is configured, every route returns 503. Configure the secret only through Wrangler or the Cloudflare dashboard, not as a committed plain-text variable. All password holders can query the whole corpus. There is no public ingestion route or per-document authorization.

For your own Markdown files, use `--corpus data/corpus` with the indexing command. The default is `examples/corpus`. The exporter confines paths to the chosen corpus, rejects oversized documents and limits input to 100 documents and 1000 chunks. Preview commands do not send source text anywhere. `--apply` sends passages to Workers AI, D1 and Vectorize; the Cloudflare account is the processing destination.

Ingestion is generation-based: a failure leaves the old active index available. It does not delete old or failed generations. Run only one ingestion job per index at a time. Each generation needs additional stored vector dimensions; the script checks this index's current vector count before staging, and refuses to exceed five million stored dimensions. Other indexes also share the account's allowance and must be considered separately. Do not repeatedly rebuild large corpora without checking retained versions and the dashboard. Cleanup or replacing an index is a separate, explicitly reviewed operation.

Wrangler prints the deployed URL. Replace the placeholder below:

```sh
curl -u rag https://small-rag.YOUR-SUBDOMAIN.workers.dev/health/ready
curl -u rag https://small-rag.YOUR-SUBDOMAIN.workers.dev/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What does the corpus say about the Raspberry Pi?","history":[]}'
```

The password is prompted. Readiness checks the D1 active generation and embedding model and the Vectorize dimensions, without consuming inference. Cosine configuration is checked at setup. Readiness does not verify hosted-model availability or remaining AI quota: a later chat can still enter sleep if Cloudflare is unavailable, out of capacity or out of free allocation. Readiness returns the same cached sleep response once a binding failure has been observed; liveness stays available.

## Free-tier boundaries

As checked on 2026-10-15, the [Workers AI free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/) is 10,000 neurons per UTC day, [Vectorize Free](https://developers.cloudflare.com/vectorize/platform/pricing/) includes five million stored and thirty million queried dimensions per month, and [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) has its own row and storage allowances. [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) also limits requests and CPU time. These limits are account-wide, can change, and do not imply an uptime or latency guarantee.

Keep the account on Workers Free and do not configure AI Gateway prepaid billing. The scripts only use free-tier-eligible products; they neither verify nor change your current subscription. **There is no application spending cap: an already paid account can bill overages instead of rejecting usage.** Check the account plan before applying. Indexing and other account applications also consume allocations. A provider hard limit stops service when its allocation is exhausted; do not upgrade automatically to recover availability.

The fixed generation model is the currently listed `@cf/meta/llama-3.1-8b-instruct-fp8`, not the older `-fp8-fast` identifier used in an earlier cost illustration. Its [model page](https://developers.cloudflare.com/workers-ai/models/llama-3.1-8b-instruct-fp8/) lists $0.152/M input tokens and $0.287/M output tokens outside included usage. The earlier cheaper-model estimate must not be treated as this deployment's tariff. The account must still have access to the model. Changing model IDs is a reviewed code change; no paid-only model or provider fallback is selected dynamically.

The backend has no manual daily question counter. `DAILY_QUESTION_LIMIT` is obsolete and unused; remove it from any previously generated configuration on your next setup. The historical `daily_usage` table is left untouched to preserve applied migrations and existing data.

A binding failure returns HTTP 503 with `status: "sleeping"`, `service`, `reason`, `retry_at` and `Retry-After`. Workers AI code 3036 and documented D1 daily-row exhaustion messages additionally provide `reset_at` at the next 00:00 UTC. Other failures, including AI capacity errors and Vectorize errors with no reliable reset signal, pause for one minute before a new request may test availability. That probe time is not a promise of recovery. See [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/) and [D1 errors](https://developers.cloudflare.com/d1/observability/debug-d1/).

Pause state is isolate-local and requires no D1 writes. Cached pauses prevent downstream binding calls for chat and readiness, but new isolates and already-running requests can still reach Cloudflare. The provider enforces the account-wide quota. If Workers itself exhausts its request allowance, Cloudflare rejects requests before the application can format a sleep response. Monthly quotas require their actual period reset; full storage needs capacity freed by an operator. Do not automatically upgrade the plan to recover availability.

There is no background polling, streaming, automatic generation retry or failed-question replay. The next request after the pause expires resumes ordinary processing. Input/output bounds remain; malformed model output is a generic 503, not evidence that a daily quota has run out.

## Local development

After provisioning/indexing, `pnpm dev` executes the handler locally with remote D1, Vectorize and AI bindings. **It queries real data, consumes real AI allocation and shares the account’s Cloudflare allocations.** Do not use it as an isolated production sandbox. For independent development use a separate Cloudflare account/resources and generated configuration, with the same Free-plan checks.

If upgrading an existing checkout, rerun `pnpm infra:setup --apply` before deployment to refresh the non-secret generated entrypoint and migration paths; this only reuses the existing named resources. The migration filenames and SQL behavior are preserved, so moving their source directory does not create a new migration. Reindex explicitly with the native TypeScript extraction recipe before relying on the new corpus output.

Set the local HTTP password in ignored `infra/.dev.vars`, using `BASIC_AUTH_PASSWORD` and a value of at least 16 characters, before running `pnpm dev`. This is an operator-created secret file; the repository does not create it. Do not copy the operator API token into it. Cloudflare AI and Vectorize require authenticated remote access; there is no offline inference emulator. Use `pnpm test` and `pnpm db:migrate:local` when you need an account-free check.

## Updates and recovery

Keep the Markdown corpus outside Git when private and back it up separately. The D1 and Vectorize data can be rebuilt from it with the configured extractor and embedding model. Retained generations are not a substitute for a database backup. Review Cloudflare D1 backup/export procedures before production changes.

Deploy prompt/code edits with `pnpm build` followed by the explicit `pnpm deploy`. Reindex only when the corpus, extractor/chunk recipe or embedding model changes. A prompt-only change does not require reindexing. The old PostgreSQL corpus/index remains separate; none of these commands connects to or migrates it.

No live Cloudflare deployment or inference benchmark is implied by passing local tests. Verify authentication, readiness, quota behavior, citations, real-corpus answer quality, account usage and latency after configuring your own account. The prior Raspberry Pi and Docker guides are archived in [legacy-deployment.md](legacy-deployment.md); the [performance report](performance.md) records historical local-inference measurements.
