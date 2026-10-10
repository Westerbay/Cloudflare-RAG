# Deploy and operate the stack

This guide starts a **new, local** Docker stack. The domain profile can be exposed through your own DNS and router after validation. No hosted service or Raspberry Pi performance is claimed here.

## Requirements and files

- Raspberry Pi 5 with 8 GB RAM, 64-bit Linux, Docker Engine and Compose plugin; or another Linux machine for a trial run. Keep enough free disk for models, PostgreSQL data and a backup.
- A domain you control for the public profile, with DNS and router/firewall access to TCP 80 and 443. UDP 443 is optional for HTTP/3.
- A small Markdown corpus in `data/corpus/`. Only `.md` is indexed. `models/`, `data/` and `.env*` are ignored by Git.
- Model and corpus files readable by the API/model containers; the API process runs as UID 10001.
- Private values supplied by the operator's environment or secret manager: `RAG_DB_PASSWORD`, `RAG_DATABASE_URL`, and for the domain profile `RAG_DOMAIN`, `RAG_BASIC_AUTH_HASH`. Use an alphanumeric database password or URL-encode special characters in `RAG_DATABASE_URL`. The same password must appear in both database settings.

Docker images are pinned to multi-architecture digests in `infra/compose.yml` and `infra/compose.domain.yml`. The chat default is Qwen3.5 2B Q4_K_M; an explicit 0.8B Q4_0 profile is available if the 2B model is too slow or large. The embedding model is Qwen3-Embedding 0.6B Q8_0. Their exact revisions and SHA-256 digests are pinned in `scripts/download_models.py`. The 2B GGUF is published by Unsloth; verify its license and intended use before distributing weights. Weights are never committed. The download script checks the full file hash and rejects an existing mismatched or partial file. It needs network access only when you run it.

From the repository root:

```sh
mkdir -p models data/corpus
python3 scripts/download_models.py --chat 2b
# Or download the smaller chat profile:
# python3 scripts/download_models.py --chat 0.8b
```

For the smaller model, also set `RAG_CHAT_GGUF_FILE=Qwen3.5-0.8B-Q4_0.gguf` and `RAG_CHAT_MODEL=qwen3.5-0.8b` in the same operator environment before running Compose. The alias must match the API's configured chat model. Switching the chat model does not require reindexing; switching the embedding model or chunk settings does.

## Private configuration

Set a unique database password in your shell or secret manager, then construct the matching URL. The following interactive shell example avoids writing the password to a tracked file or command history:

```sh
export RAG_DB_PASSWORD="$(python3 -c 'import getpass; print(getpass.getpass("Database password: "))')"
export RAG_DATABASE_URL="postgresql://rag:${RAG_DB_PASSWORD}@db:5432/rag"
```

Use a password without URI special characters for this example. For a permanent service, provide these environment variables securely to the Compose process. Do not commit credentials, a real `.env` file, model weights or a database backup.

## Local profile first

```sh
docker compose -f infra/compose.yml -f infra/compose.local.yml config --quiet
docker compose -f infra/compose.yml -f infra/compose.local.yml up -d --build
docker compose -f infra/compose.yml -f infra/compose.local.yml exec -T api python -m small_rag.cli migrate
docker compose -f infra/compose.yml -f infra/compose.local.yml exec -T api python -m small_rag.cli index
curl -fsS http://127.0.0.1:8000/health/ready
curl -sS http://127.0.0.1:8000/v1/chat -H 'Content-Type: application/json' -d '{"message":"What does the corpus say about the Raspberry Pi?","history":[]}'
```

Index only after placing Markdown in `data/corpus/` and waiting for both model servers to load. A temporary 503 from `/health/ready` during model startup is expected. `docker compose ... logs chat embeddings api` shows load or provider errors. `docker compose ... ps` should show only `127.0.0.1:8000` as a host binding; database and model services have no host ports. The local profile is for the host machine, not a public router.

## Domain profile

Point an `A` record for your chosen name to your public IPv4 address. Add an `AAAA` record only if inbound IPv6 works. Forward TCP 80 and 443 from the router to the Pi, and allow them in its firewall. If the ISP uses carrier-grade NAT, ordinary port forwarding will not work; use an authorized tunnel or a public reverse proxy instead. Caddy needs the name reachable to obtain and renew its HTTPS certificate.

Create a password hash interactively with the pinned Caddy image; the command prompts for the plaintext without placing it in the command line:

```sh
docker run --rm -it caddy:2.10.2@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb caddy hash-password
```

Supply the resulting hash through a private environment/secret manager as `RAG_BASIC_AUTH_HASH`, and set `RAG_DOMAIN` to a hostname such as `rag.example.com` (no scheme or path). The Basic Auth username is `rag`; use a unique, strong password. Every route, including health endpoints, is protected by this Caddy rule. Basic Auth is appropriate for a small personal deployment; add rate limits or stronger identity controls before allowing many users. For a domain stack, do not combine `compose.local.yml` with `compose.domain.yml`:

```sh
docker compose -f infra/compose.yml -f infra/compose.domain.yml config --quiet
docker compose -f infra/compose.yml -f infra/compose.domain.yml up -d --build
docker compose -f infra/compose.yml -f infra/compose.domain.yml exec -T api python -m small_rag.cli migrate
docker compose -f infra/compose.yml -f infra/compose.domain.yml exec -T api python -m small_rag.cli index
curl -u rag https://rag.example.com/health/ready
```

Replace the example hostname. `curl -u rag` prompts for the password. Verify `docker compose ... ps`: only Caddy should publish `0.0.0.0:80`, `0.0.0.0:443` and UDP 443. The API, model servers and database remain on the private Compose network. Caddy stores certificates in `caddy_data`; retain this volume across restarts and updates. The service has no application-level users or per-user document permissions: anyone with the Basic Auth credential can query the entire indexed corpus. Do not index private documents unless that access model is acceptable.

## Benchmark on the target machine

Run this **on the Pi** after indexing and after the models are warm. The question must be supported by the corpus:

```sh
python3 scripts/benchmark_stack.py --profile local --question 'What does the corpus say about the Raspberry Pi?'
# Use --profile domain for that Compose profile.
```

The JSON records question embedding time, exact vector search time, total retrieval time, end-to-end answer time/status, retrieved-hit count and a separate llama.cpp `/completion` sample's first-token time, total time and tokens/second. The first-token figure is for that short sample, not the full RAG answer. It also reports host architecture and each container's PID 1 resident memory. This is one sample, not a capacity guarantee; repeat with representative questions and record the Pi's OS, corpus size and model profile. PostgreSQL worker processes and Linux page cache are excluded from the PID 1 RSS figures. Compare both chat profiles only after switching the model and restarting the stack. A benchmark on a laptop does not establish Pi latency or memory use.

## Data safety, updates and recovery

The PostgreSQL volume is `rag_db`; the Caddy domain volumes are `caddy_data` and `caddy_config`. Use `docker compose ... down` without `--volumes` to stop a profile while keeping them. A full index can be rebuilt from the Markdown corpus and pinned embedding model, but a backup speeds recovery. Keep the corpus and model files backed up separately.

For a consistent logical database backup, stop indexing, then run (substitute the active profile's second Compose file):

```sh
docker compose -f infra/compose.yml -f infra/compose.local.yml exec -T db pg_dump -U rag -d rag -Fc > rag-backup.dump
```

Store the dump privately, outside Git, and test restoration against a **new disposable database volume** first. For example, from the repository root, start only a new `small-rag-restore` project's database and stream the dump into that exact target:

```sh
docker compose -p small-rag-restore -f infra/compose.yml up -d db
docker compose -p small-rag-restore -f infra/compose.yml exec -T db pg_restore -U rag -d rag --no-owner --clean --if-exists < rag-backup.dump
docker compose -p small-rag-restore -f infra/compose.yml exec -T db psql -U rag -d rag -c 'SELECT count(*) FROM rag_chunks;'
```

Restoration replaces data; do not run it against an existing deployment without choosing and verifying the exact target. Keep the same PostgreSQL major version for the first restore exercise. Stop the disposable restore project with `docker compose -p small-rag-restore -f infra/compose.yml down` when finished; keep or remove its volume only after deciding whether its data is needed.

Before an update, save a backup and note the current Git commit and image digests. Pull the new code/images, inspect the migration SQL, build, then run the explicit `migrate` command before `index`. Check `/health/ready` and a cited answer. For rollback, redeploy the recorded code/images and restore the matching database backup when a new migration is incompatible; older code is not guaranteed to read a newer schema. Never use `down --volumes` as an update or rollback command. Validate changes on the local profile before exposing the domain profile.
