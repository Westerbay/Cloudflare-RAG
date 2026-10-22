# Deploy Cloudflare RAG

The target is Cloudflare Workers Free, Workers AI, D1 and Vectorize. The Worker executes the API, Workers AI runs inference, and D1/Vectorize store the index. `workers.dev` supplies an HTTPS address without purchasing a domain. These instructions create remote state only when you run the explicitly marked remote commands.

## Prerequisites

Use Node.js 24.22.1 or newer within 24.x and pnpm 12 for local tests, builds, deployment tooling and offline corpus preparation. With nvm, run `nvm install` and `nvm use` from the repository root; pnpm rejects unsupported Node versions during installation. The deployed API runs on Cloudflare Workers, whose runtime is managed by Cloudflare. Updating local Node.js does not update that runtime or require corpus reindexing. Install the locked workspace dependencies:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Tests use SQLite and fake AI/Vectorize bindings; the build is Wrangler's deployment dry run. None of these steps provisions Cloudflare resources or calls hosted inference. Wrangler is installed locally through `pnpm-lock.yaml`; no global installation, Pulumi account or infrastructure state service is required.

## Operator credentials

Create a Cloudflare account and keep its Workers plan on **Free**. In the dashboard, open **Workers AI → Use REST API** and copy the **Account ID** (a 32-character identifier). It identifies your account; it is not an API token. See [Cloudflare’s account/token guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).

Create a custom token in **My Profile → API Tokens**. Use **Account** as the scope for every permission row:

| Service | Access | Purpose |
| --- | --- | --- |
| D1 | Edit | Create the database, apply migrations and store passages |
| Vectorize | Edit | Create the index and publish vectors |
| Workers AI | Read and Edit (two rows) | Run embedding models during ingestion |
| Workers Scripts | Edit | Deploy the Worker and configure its secret |
| Account Settings | Read | Allow Wrangler to read account information |

Under **Account Resources**, choose **Include → Specific account → your account**, instead of all accounts. Use a scoped API token rather than a Global API Key. Cloudflare’s [Workers AI REST guide](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) requires both AI permissions; consult the [permission reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) if dashboard labels differ. Wrangler login alone does not supply the environment token required by this repository’s setup/index scripts.

Supply public identifiers and secrets in your shell or secret manager. These interactive examples keep the token out of the typed command history. For **zsh**:

```zsh
export CLOUDFLARE_ACCOUNT_ID='YOUR_32_CHARACTER_ACCOUNT_ID'
read -rs 'CLOUDFLARE_API_TOKEN?Cloudflare API token: '
printf '\n'
export CLOUDFLARE_API_TOKEN
```

For **Bash**, use this input command instead of the zsh `read` line:

```bash
read -r -s -p 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN
```

The variables apply to the current terminal session. Never paste the token into a chat, commit it, or put it in Wrangler `vars`. The scripts do not read secret files or print provider error bodies. The deployed Worker uses its AI/D1/Vectorize bindings and does not need this operator API token.

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

## Prepare the corpus locally

`examples/corpus` contains small smoke-test fixtures about the application. It is not a reviewed production knowledge base. Before uploading real documents:

1. Define the subject, intended audience and questions the bot must answer.
2. Select authoritative, current sources that you are allowed to send to Cloudflare; remove secrets and unrelated personal information.
3. Put UTF-8 `.md` or `.markdown` files in ignored `data/corpus/` (or another private local directory). Use meaningful filenames and headings, and record source links and review dates in the documents.
4. Remove contradictory or obsolete claims and collect representative questions, expected source passages, and questions the corpus cannot answer. Keep this evaluation material outside the indexed folder.
5. Preview the extraction locally:

```sh
pnpm corpus:index --corpus data/corpus
pnpm corpus:export --corpus data/corpus
```

Both commands stay local. Export prints the actual passages, paths and line ranges for review. The current profile allows up to 100 files, 2,000,000 bytes per file and 1000 chunks. This is a Markdown pipeline; it does not extract PDFs, browse source URLs or fetch linked pages. Local preparation can happen before any Cloudflare setup. Run `--apply` only after reviewing this output.

## Index and deploy

For an intentional smoke test using only the example fixtures, preview and then publish:

```sh
pnpm corpus:index
pnpm corpus:index --apply
pnpm deploy
node infra/wrangler.ts secret put BASIC_AUTH_PASSWORD
```

Choose a strong Basic Auth password of at least 16 characters when prompted; the username is `rag`. Protected routes return 503 until the secret is configured; all routes are protected in the default private mode. Configure the secret only through Wrangler or the Cloudflare dashboard, not as a committed plain-text variable. All password holders can query the whole corpus. There is no public ingestion route or per-document authorization.

For your reviewed real corpus, replace the two indexing commands above with `pnpm corpus:index --corpus data/corpus` and then `pnpm corpus:index --corpus data/corpus --apply`. The default is `examples/corpus`. The exporter confines paths to the chosen corpus, rejects oversized documents and limits input to 100 documents and 1000 chunks. Preview commands do not send source text anywhere. `--apply` sends passages to Workers AI, D1 and Vectorize; the Cloudflare account is the processing destination.

Ingestion is generation-based: a failure leaves the old active index available. It does not delete old or failed generations. Run only one ingestion job per index at a time. Each generation needs additional stored vector dimensions; the script checks this index's current vector count before staging, and refuses to exceed five million stored dimensions. Other indexes also share the account's allowance and must be considered separately. Do not repeatedly rebuild large corpora without checking retained versions and the dashboard. Cleanup or replacing an index is a separate, explicitly reviewed operation.

Wrangler prints the deployed URL. Replace the placeholder below:

```sh
curl -u rag https://small-rag.YOUR-SUBDOMAIN.workers.dev/health/ready
curl -u rag https://small-rag.YOUR-SUBDOMAIN.workers.dev/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Which services store the passages and embeddings?","history":[]}'
```

The password is prompted. Readiness checks the D1 active generation and embedding model and the Vectorize dimensions, without consuming inference. Cosine configuration is checked at setup. Readiness does not verify hosted-model availability or remaining AI quota: a later chat can still enter sleep if Cloudflare is unavailable, out of capacity or out of free allocation. Readiness returns the same cached sleep response once a binding failure has been observed; liveness stays available.

## Public browser access

The portable template keeps `PUBLIC_CHAT_ENABLED` at `"false"`. After reviewing the entire corpus for public access, an operator can explicitly set these non-secret `vars` in the deployment configuration:

```json
"PUBLIC_CHAT_ENABLED": "true",
"PUBLIC_CHAT_ORIGINS": "https://westerbay.github.io"
```

Only `POST /v1/chat` and its CORS preflight become public. Health routes still require Basic Auth. The browser calls the same chat URL and JSON contract with `credentials: "omit"` and no `Authorization` header. Keep `BASIC_AUTH_PASSWORD` exclusively in Worker secrets; never embed it in frontend files. A missing private secret does not block a configured public chat.

`PUBLIC_CHAT_ORIGINS` is a comma-separated list of exact HTTP(S) origins, without paths, trailing slashes or wildcards. For example, `/Home-Page/` is not part of the GitHub Pages origin. Keep localhost origins in development configuration only. Empty or invalid configuration returns a generic 503 before the RAG pipeline. An unknown supplied origin, including `null`, returns 403; a request without `Origin` remains permitted. Preflights allow POST with Content-Type only and do not call downstream services. Responses to allowed origins include CORS headers for errors and sleeping, expose `Retry-After`, and never allow browser credentials.

The generated `infra/wrangler.local.json` takes precedence over the portable template. Review and update its public settings explicitly before an authorized deployment; changing only the template does not update an existing generated file, and rerunning setup regenerates it from the template. Setting the flag back to `"false"` restores private chat. A browser may then report a CORS/network error instead of exposing the 401 response; do not prompt visitors for the password.

CORS does not authenticate visitors. This option adds no application rate limit, quota counter or antirobot service. Cloudflare quotas and the existing sleeping response remain unchanged. Public clients should use chat responses to observe sleep, without polling private health routes or automatically retrying failed questions.

## Free-tier boundaries

As checked on 2026-10-16, the [Workers AI free allocation](https://developers.cloudflare.com/workers-ai/platform/pricing/) is 10,000 neurons per UTC day, [Vectorize Free](https://developers.cloudflare.com/vectorize/platform/pricing/) allows five million stored dimensions and thirty million queried dimensions per month, and [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/) has its own row and storage allowances. [Workers Free](https://developers.cloudflare.com/workers/platform/limits/) also limits requests and CPU time. These limits are account-wide, can change, and do not imply an uptime or latency guarantee.

Keep the account on Workers Free and do not configure AI Gateway prepaid billing. The scripts only use free-tier-eligible products; they neither verify nor change your current subscription. **There is no application spending cap: an already paid account can bill overages instead of rejecting usage.** Check the account plan before applying. Indexing and other account applications also consume allocations. A provider hard limit stops service when its allocation is exhausted; do not upgrade automatically to recover availability.

The fixed generation model is the currently listed `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Its [model page](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/) lists $0.293/M input tokens and $2.253/M output tokens outside included usage. This model is listed as supporting [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/), which the chatbot requires for structured answers and citations. Plain-text inference succeeding does not prove JSON Schema support. It uses the shared free daily allocation on Workers Free; it consumes more neurons per token than the previous 8B FP8 model. The account must still have access to the model. Changing model IDs is a reviewed code change; no paid-only model or provider fallback is selected dynamically.

The backend has no manual daily question counter. The unused `daily_usage` table remains in the original migration for compatibility; it does not enforce a runtime quota.

A binding failure returns HTTP 503 with `status: "sleeping"`, `service`, `reason`, `retry_at` and `Retry-After`. Workers AI code 3036 and documented D1 daily-row exhaustion messages additionally provide `reset_at` at the next 00:00 UTC. Other failures, including AI capacity errors and Vectorize errors with no reliable reset signal, pause for one minute before a new request may test availability. That probe time is not a promise of recovery. See [Workers AI errors](https://developers.cloudflare.com/workers-ai/platform/errors/) and [D1 errors](https://developers.cloudflare.com/d1/observability/debug-d1/).

Pause state is isolate-local and requires no D1 writes. Cached pauses prevent downstream binding calls for chat and readiness, but new isolates and already-running requests can still reach Cloudflare. The provider enforces the account-wide quota. If Workers itself exhausts its request allowance, Cloudflare rejects requests before the application can format a sleep response. Monthly quotas require their actual period reset; full storage needs capacity freed by an operator. Do not automatically upgrade the plan to recover availability.

There is no background polling, streaming, automatic generation retry or failed-question replay. The next request after the pause expires resumes ordinary processing. Input/output bounds remain; malformed model output is a generic 503, not evidence that a daily quota has run out.

## Local development

After provisioning/indexing, `pnpm dev` executes the handler locally with remote D1, Vectorize and AI bindings. **It queries real data, consumes real AI allocation and shares the account’s Cloudflare allocations.** Do not use it as an isolated production sandbox. For independent development use a separate Cloudflare account/resources and generated configuration, with the same Free-plan checks.

When updating the portable infrastructure template, rerun `pnpm infra:setup --apply` before deployment to refresh the generated configuration. Setup reuses compatible named resources. Review versioned migrations separately; setup does not apply them.

Set the local HTTP password in ignored `infra/.dev.vars`, using `BASIC_AUTH_PASSWORD` and a value of at least 16 characters, before running `pnpm dev`. This is an operator-created secret file; the repository does not create it. Do not copy the operator API token into it. Cloudflare AI and Vectorize require authenticated remote access; there is no offline inference emulator. Use `pnpm test` and `pnpm db:migrate:local` when you need an account-free check.

## Updates and recovery

Keep the Markdown corpus outside Git when private and back it up separately. The D1 and Vectorize data can be rebuilt from it with the configured extractor and embedding model. Retained generations are not a substitute for a database backup. Review Cloudflare D1 backup/export procedures before production changes.

Deploy prompt/code edits with `pnpm build` followed by the explicit `pnpm deploy`. Reindex when the corpus, extractor/chunk recipe, embedding-input recipe or embedding model changes. A prompt-only change does not require reindexing.

For the contextual-retrieval update, the query-mode fix and response-style changes work with existing vectors after deployment. To associate each indexed section with its document and heading, re-export the original Markdown with the updated operator code, inspect `pnpm corpus:index --corpus YOUR_REVIEWED_CORPUS`, and explicitly publish with the same command plus `--apply`. Old exports are rejected before provider calls; do not edit their recipe fields to bypass validation. A recipe change stages a new generation even when passage text is unchanged. Do not index a parent directory containing review notes, private provenance or evaluation cases. Neither a PR nor a successful build updates the deployed Worker or active index.

No live Cloudflare deployment or inference benchmark is implied by passing local tests. Verify authentication, readiness, quota behavior, citations, real-corpus answer quality, account usage and latency after configuring your own account. Performance depends on the selected models, account and corpus.

## Troubleshoot indexing requests

Operator request failures identify the operation (D1 query, Workers AI inference or Vectorize), HTTP status and numeric provider codes when available. Raw provider bodies, paths containing resource identifiers, tokens and document text are not printed. Missing known D1 index tables produce a hint to run `pnpm db:migrate:remote` against the configured database. Do not assume every HTTP 400 means migrations are missing.

A transport failure identifies the operation and recognized network codes (for example, `ENOTFOUND`, `ECONNRESET` or `UND_ERR_CONNECT_TIMEOUT`) without printing raw exception messages. It can occur while connecting or reading the response. The remote write may already have been accepted; no automatic retry is made. Check connectivity and the reported service before retrying. Restarting an incomplete upload creates a new staged generation and repeats embedding calls, consuming additional AI allocation.

To check the D1 schema before resuming an upload, run this read-only inspection from the repository root:

```sh
node infra/wrangler.ts d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('generations', 'chunks', 'active_generation');"
```

All three index tables should be present. If absent, apply the existing migrations to the intended database before retrying ingestion. A failed upload can leave an inactive staged generation; the script does not activate it until indexing completes. Do not delete existing generations or reset the database to investigate an error.
