# Cloudflare infrastructure

Use **Wrangler** for this single-provider deployment. Pulumi is not required: there is no additional infrastructure state backend, subscription or provider plugin to maintain.

- `wrangler.jsonc`: portable Worker, AI, D1 and Vectorize bindings with non-secret settings.
- `setup.ts`: repeatable account-scoped D1/Vectorize setup; defaults to a plan, requires `--apply` for remote writes.
- `wrangler.local.json`: ignored generated account and resource IDs, written only after successful setup.
- `wrangler.ts`: invokes the locked local Wrangler with the correct configuration and blocks unconfigured remote commands.
- `../packages/database/migrations/`: versioned D1 SQL migrations.

From the repository root:

```sh
pnpm infra:setup
# After selecting a Free account and supplying operator credentials:
pnpm infra:setup --apply
pnpm db:migrate:remote
```

Ingestion, deployment and secret entry are explicit separate operations. See the [deployment guide](../docs/deployment.md). Setup never upgrades billing, deletes an index, resets a database or writes a secret. Inspect existing `small-rag` resource names before applying to an account; incompatible vector settings fail instead of replacing resources.

The API is a native Cloudflare Worker with AI, D1 and Vectorize bindings. Corpus preparation and infrastructure commands run from the local Node.js workspace.
