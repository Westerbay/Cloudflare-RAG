# Disposable local PostgreSQL

This Compose file exposes PostgreSQL only on the loopback address for development. It is separate from the later domain deployment profile, where PostgreSQL will have no host port.

From the repository root, set a private password in your shell and start the service:

```sh
export RAG_DEV_DB_PASSWORD='choose-a-unique-local-password'
docker compose -p small-rag-dev -f infra/compose.db-dev.yml up -d
export RAG_DATABASE_URL="postgresql://rag:${RAG_DEV_DB_PASSWORD}@127.0.0.1:15432/rag"
.venv/bin/python -m small_rag.cli migrate
```

With a llama.cpp embedding server running at `RAG_EMBEDDING_URL` and Markdown files under `RAG_CORPUS_ROOT`, build a complete generation explicitly:

```sh
export RAG_CORPUS_ROOT=examples/corpus
export RAG_EMBEDDING_URL=http://127.0.0.1:8082
.venv/bin/python -m small_rag.cli index
```

The model server must be started with embedding mode and return 1024-dimensional nonzero vectors. Indexing is never triggered by an API request. Inspect the schema and active generation with:

```sh
docker compose -p small-rag-dev -f infra/compose.db-dev.yml exec db psql -U rag -d rag -c '\dx vector'
docker compose -p small-rag-dev -f infra/compose.db-dev.yml exec db psql -U rag -d rag -c 'SELECT g.id, g.embedding_model, g.recipe, count(c.chunk_id) AS chunks FROM rag_active_generation a JOIN rag_generations g ON g.id = a.generation_id LEFT JOIN rag_chunks c ON c.generation_id = g.id GROUP BY g.id;'
```

`docker compose -p small-rag-dev -f infra/compose.db-dev.yml down` stops this local service while retaining its named volume. Back up any wanted data before deliberately removing the volume.
