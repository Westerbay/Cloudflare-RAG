"""Only the operations required across external boundaries."""

from pathlib import Path
from typing import Protocol, Sequence

from small_rag.domain.models import Document, Embedding, IndexedChunk, SearchHit


class TextExtractor(Protocol):
    def extract(self, path: Path, corpus_root: Path) -> Document: ...


class Embedder(Protocol):
    async def embed(self, text: str) -> Embedding: ...


class Generator(Protocol):
    async def generate(self, prompt: str) -> str: ...


class ChunkIndex(Protocol):
    async def publish(self, chunks: Sequence[IndexedChunk], recipe: str) -> None: ...

    async def search(self, query: Embedding, limit: int) -> Sequence[SearchHit]: ...
