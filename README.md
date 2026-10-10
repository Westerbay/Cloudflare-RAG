# Small RAG

A small, explicit retrieval-augmented chatbot intended for a Raspberry Pi 5 with 8 GB of RAM. The project is being delivered in stages. The current stage defines the domain contracts and validated configuration; indexing, chat, API and deployment will follow in separate pull requests.

## Boundaries

- `src/small_rag/domain/` holds provider-independent data types.
- `src/small_rag/application/` holds ports and, in later stages, use cases.
- `src/small_rag/adapters/` will hold Markdown, llama.cpp and PostgreSQL adapters.
- `database/migrations/` will hold versioned SQL migrations.
- `infra/` will hold Docker Compose and Caddy configuration.

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
