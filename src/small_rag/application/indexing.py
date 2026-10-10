"""Operator-triggered corpus indexing, separate from public question answering."""

import json
from pathlib import Path

from small_rag.application.chunking import chunk_document
from small_rag.application.ports import ChunkWriter, CorpusReader, Embedder
from small_rag.domain.models import IndexedChunk


def index_recipe(corpus_recipe: str, embedding_model: str, size_chars: int, overlap_chars: int) -> str:
    return json.dumps(
        {"corpus": corpus_recipe, "embedding_model": embedding_model,
         "size_chars": size_chars, "overlap_chars": overlap_chars},
        sort_keys=True,
    )


async def index_corpus(
    corpus_root: Path,
    corpus: CorpusReader,
    embedder: Embedder,
    index: ChunkWriter,
    *,
    embedding_model: str,
    size_chars: int,
    overlap_chars: int,
    max_documents: int,
    max_chunks: int,
) -> int:
    chunks = []
    for document in corpus.iter_documents(corpus_root, max_documents):
        chunks.extend(chunk_document(document, size_chars, overlap_chars))
        if len(chunks) > max_chunks:
            raise ValueError(f"Corpus exceeds {max_chunks} chunks")
    indexed = [IndexedChunk(chunk, await embedder.embed(chunk.text)) for chunk in chunks]
    recipe = index_recipe(corpus.recipe_id, embedding_model, size_chars, overlap_chars)
    await index.publish(indexed, recipe)
    return len(indexed)
