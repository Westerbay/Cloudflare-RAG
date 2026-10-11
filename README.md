# Small RAG

A small, explicit retrieval-augmented chatbot intended for a Raspberry Pi 5 with 8 GB of RAM. It uses Markdown, PostgreSQL/pgvector, two llama.cpp servers, FastAPI and optional Caddy HTTPS access. The [architecture guide](docs/architecture.md) explains both RAG phases; the [deployment guide](docs/deployment.md) covers local and domain operation.

## Boundaries

- `src/small_rag/domain/` holds provider-independent data types.
- `src/small_rag/application/` holds ports and use cases.
- `src/small_rag/adapters/` holds Markdown, llama.cpp and PostgreSQL adapters.
- `src/small_rag/api.py` exposes the HTTP boundary.
- `prompts/` holds the editable mission contract and assistant voice.
- `database/migrations/` holds versioned SQL migrations.
- `infra/` holds Docker Compose profiles and Caddy configuration.
- `scripts/` holds explicit model download and target-machine benchmark commands.

The intended flow is Markdown extraction → chunks → embeddings → PostgreSQL/pgvector → retrieval → grounded chat answer with citations. The application never trains a model; an operator supplies local GGUF files outside Git.

## Development setup

Use Python 3.11 or newer:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/python -m pytest
```

Configuration uses environment variables prefixed with `RAG_`. `RAG_DATABASE_URL` is required and must be a PostgreSQL URL with a host and database name. For example, an operator can supply it through their shell or a private deployment secret:

```sh
export RAG_DATABASE_URL='postgresql://rag_user:your-password@localhost:5432/rag'
```

This example is illustrative; do not commit real credentials. The configuration validates input when `AppSettings()` is created. Non-secret defaults and bounds are defined in `src/small_rag/config.py`. The initial `RAG_MIN_SIMILARITY` value is provisional and must be calibrated with example questions before relying on answer quality.

## Local operation

Start a disposable PostgreSQL/pgvector instance as described in [infra/README.md](infra/README.md). Start separate llama.cpp servers for chat and embeddings using local GGUF files, then set `RAG_CHAT_URL` and `RAG_EMBEDDING_URL` to their HTTP addresses. The embedding server must return 1024-dimensional vectors. Apply migrations and build the index explicitly:

```sh
.venv/bin/python -m small_rag.cli migrate
.venv/bin/python -m small_rag.cli index
.venv/bin/uvicorn small_rag.api:create_app --factory --host 127.0.0.1 --port 8000
```

The API process does not migrate or index on startup. `/health/live` checks the process; `/health/ready` checks the active index, its recipe and both model servers. A failed readiness check returns HTTP 503. A request with invalid input returns 422; a missing index or provider outage returns 503. For example:

```sh
curl -sS http://127.0.0.1:8000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"What does the indexed corpus say about the Raspberry Pi?","history":[]}'
```

The response has `status` (`answered`, `insufficient_context` or `out_of_scope`), `answer`, and `citations` with relative Markdown paths and source line ranges. The API has no ingestion route. Keep this local server bound to loopback; the [Caddy domain profile](docs/deployment.md#domain-profile) supplies public TLS and authentication.

Edit `prompts/system.md` for the mission and `prompts/SOUL.md` for tone. The API loads both at startup; `RAG_SYSTEM_PROMPT_PATH` and `RAG_SOUL_PATH` can point to other UTF-8 files. Restart the API after edits. Prompt changes do not require reindexing.
