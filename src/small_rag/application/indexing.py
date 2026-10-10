"""Operator-triggered corpus indexing, separate from public question answering."""

import json
from importlib.metadata import version
from pathlib import Path

from small_rag.application.chunking import chunk_document
from small_rag.application.ports import ChunkIndex, Embedder, TextExtractor
from small_rag.domain.models import IndexedChunk


def index_recipe(embedding_model: str, size_chars: int, overlap_chars: int) -> str:
    return json.dumps(
        {"extractor": f"markdown-it-py-{version('markdown-it-py')}", "embedding_model": embedding_model,
         "size_chars": size_chars, "overlap_chars": overlap_chars},
        sort_keys=True,
    )


async def index_corpus(
    corpus_root: Path,
    extractor: TextExtractor,
    embedder: Embedder,
    index: ChunkIndex,
    *,
    embedding_model: str,
    size_chars: int,
    overlap_chars: int,
    max_documents: int,
    max_chunks: int,
) -> int:
    root = corpus_root.resolve(strict=True)
    paths = []
    for path in root.rglob("*"):
        if path.suffix.lower() in {".md", ".markdown"}:
            paths.append(path)
            if len(paths) > max_documents:
                raise ValueError(f"Corpus exceeds {max_documents} Markdown files")
    paths.sort()
    chunks = []
    for path in paths:
        chunks.extend(chunk_document(extractor.extract(path, root), size_chars, overlap_chars))
        if len(chunks) > max_chunks:
            raise ValueError(f"Corpus exceeds {max_chunks} chunks")
    indexed = [IndexedChunk(chunk, await embedder.embed(chunk.text)) for chunk in chunks]
    recipe = index_recipe(embedding_model, size_chars, overlap_chars)
    await index.publish(indexed, recipe)
    return len(indexed)
