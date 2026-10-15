# TypeScript development

Small RAG follows the pnpm workspace and boundary-schema conventions of [WebApp Template](https://github.com/Westerbay/WebApp-Template), adapted to a single Cloudflare API. Node.js 24 and pnpm 12 are the only language/toolchain requirements.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm infra:setup
pnpm corpus:index
pnpm corpus:export
```

`check` runs strict type checking, all active tests and Wrangler's deployment dry run. `infra:setup` and `corpus:index` are plans without `--apply`. `corpus:export` writes JSON to standard output without provider access. Local development with `pnpm dev` needs configured remote AI/D1/Vectorize bindings; see [deployment](deployment.md). Secrets and remote operations remain explicit.

- `apps/api/src`: Worker entrypoint, HTTP/auth, retrieval and Cloudflare adapters.
- `packages/contracts/src`: shared Zod schemas, inferred input types and profile settings.
- `packages/core/src`: pure source-window rules, independent of Node and providers.
- `packages/database`: D1 binding types and versioned SQL.
- `scripts/corpus`: Node-only Markdown extraction and filesystem controls.
- `scripts/index-cloudflare.ts`: typed operator ingestion.
- `infra`: Wrangler settings, typed setup and launcher.

Shared packages never import applications. Keep Node-only imports outside the Worker dependency graph. Validate unknown provider/input values at their owning boundary; never cast away a schema mismatch. Avoid importing the full web template's server or UI infrastructure without an actual consumer.

The previous Python tools, tests, Compose deployment, PostgreSQL SQL and `legacy/package-lock.json` are inactive historical material. They are not required or run by any pnpm command, and their former setup remains documented only in the legacy guides. No local model, data file or secret is removed. The TypeScript parser recipe requires a new explicit corpus indexing run.
