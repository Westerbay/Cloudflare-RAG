# TypeScript development

Cloudflare RAG follows the pnpm workspace and boundary-schema conventions of [WebApp Template](https://github.com/Westerbay/WebApp-Template), adapted to a single Cloudflare API. Node.js 24.22.1 or newer within 24.x and pnpm 12 are the language/toolchain requirements. This minimum includes the [October 2026 Node.js security fixes](https://nodejs.org/en/blog/release/v24.22.1/), and pnpm enforces it during installation. With nvm, run `nvm install` and `nvm use` from the repository root before the commands below; `.nvmrc` selects the patched version.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm infra:setup
pnpm corpus:index
pnpm corpus:export
```

`check` runs strict type checking, all active tests and Wrangler's deployment dry run. `infra:setup` and `corpus:index` are plans without `--apply`. `corpus:export` writes JSON to standard output without provider access. Local development with `pnpm dev` needs configured remote AI/D1/Vectorize bindings; see [deployment](deployment.md). Secrets and remote operations remain explicit.

Public/private access and CORS tests call the Worker handler directly with SQLite in memory and simulated bindings. They need no real password or Cloudflare account. Use `pnpm test` for this validation, not `pnpm dev`. Public mode remains opt-in; its configuration and private health routes are described in [public browser access](deployment.md#public-browser-access).

- `apps/api/src`: Worker entrypoint, HTTP/auth, retrieval and Cloudflare adapters.
- `packages/contracts/src`: shared Zod schemas, inferred input types and profile settings.
- `packages/core/src`: pure source-window rules, independent of Node and providers.
- `packages/database`: D1 binding types and versioned SQL.
- `scripts/corpus`: Node-only Markdown extraction and filesystem controls.
- `scripts/index-cloudflare.ts`: typed operator ingestion.
- `infra`: Wrangler settings, typed setup and launcher.

Shared packages never import applications. Keep Node-only imports outside the Worker dependency graph. Validate unknown provider/input values at their owning boundary; never cast away a schema mismatch. Avoid importing the full web template's server or UI infrastructure without an actual consumer.

When changing the extraction/chunking recipe, embedding-input representation or embedding model, re-export and explicitly reindex the corpus before relying on the new output. Keep real documents and credentials in ignored local paths; use the example corpus only for smoke tests. Query-mode and prompt-only edits require deployment but not reindexing.
