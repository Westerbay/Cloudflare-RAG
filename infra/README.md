# Cloudflare infrastructure

Use **Wrangler** for this single-provider deployment. Pulumi is not required: there is no additional infrastructure state backend, subscription or provider plugin to maintain.

- `wrangler.jsonc`: portable Worker, AI, D1 and Vectorize bindings with non-secret settings.
- `setup.mjs`: repeatable account-scoped D1/Vectorize setup; defaults to a plan, requires `--apply` for remote writes.
- `wrangler.local.json`: ignored generated account and resource IDs, written only after successful setup.
- `wrangler.mjs`: invokes the locked local Wrangler with the correct configuration and blocks unconfigured remote commands.
- `migrations/`: versioned D1 SQL migrations.

From the repository root:

```sh
npm run infra:setup
# After selecting a Free account and supplying operator credentials:
npm run infra:setup -- --apply
npm run db:migrate:remote
```

Ingestion, deployment and secret entry are explicit separate operations. See the [deployment guide](../docs/deployment.md). Setup never upgrades billing, deletes an index, resets a database or writes a secret. Inspect existing `small-rag` resource names before applying to an account; incompatible vector settings fail instead of replacing resources.

The `compose*.yml` files and `Caddyfile` are the **legacy local Python/PostgreSQL/llama.cpp stack**. They are retained to preserve earlier work and benchmarks, and are not used by the Cloudflare deployment. See [legacy-deployment.md](../docs/legacy-deployment.md) for that historical path. Do not use its Docker commands to configure the Worker.
