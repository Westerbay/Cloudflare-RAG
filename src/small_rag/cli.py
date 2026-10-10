"""Explicit migration and indexing commands for the operator."""

import argparse
import asyncio
from pathlib import Path

from small_rag.adapters.llama_embeddings import LlamaCppEmbedder
from small_rag.adapters.markdown import markdown_corpus
from small_rag.adapters.postgres import PostgresChunkIndex, migrate
from small_rag.application.indexing import index_corpus, index_recipe
from small_rag.config import AppSettings


async def _run(command: str) -> None:
    settings = AppSettings()
    database_url = settings.database_url.get_secret_value()
    if command == "migrate":
        await migrate(database_url, Path("database/migrations"))
        print("Migrations applied")
        return
    corpus = markdown_corpus(settings.max_document_bytes)
    embedder = LlamaCppEmbedder(str(settings.embedding_url), settings.embedding_model, settings.provider_timeout_seconds)
    try:
        count = await index_corpus(
            settings.corpus_root,
            corpus,
            embedder,
            PostgresChunkIndex(
                database_url,
                settings.embedding_model,
                index_recipe(corpus.recipe_id, settings.embedding_model,
                             settings.chunk_size_chars, settings.chunk_overlap_chars),
            ),
            embedding_model=settings.embedding_model,
            size_chars=settings.chunk_size_chars,
            overlap_chars=settings.chunk_overlap_chars,
            max_documents=settings.max_documents,
            max_chunks=settings.max_chunks,
        )
    finally:
        await embedder.aclose()
    print(f"Activated index with {count} chunks")


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the local RAG index")
    parser.add_argument("command", choices=("migrate", "index"))
    args = parser.parse_args()
    asyncio.run(_run(args.command))


if __name__ == "__main__":
    main()
