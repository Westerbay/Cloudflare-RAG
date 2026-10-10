"""Only the operations required across external boundaries."""

from pathlib import Path
from typing import Protocol, Sequence

from small_rag.domain.models import Document, Embedding, IndexedChunk, SearchHit


class TextExtractor(Protocol):
    @property
    def recipe_id(self) -> str: ...

    def extract(self, path: Path, corpus_root: Path) -> Document: ...


class Embedder(Protocol):
    async def embed(self, text: str) -> Embedding: ...


class Generator(Protocol):
    async def generate(self, system_prompt: str, user_prompt: str) -> str: ...


class ChunkWriter(Protocol):
    async def publish(self, chunks: Sequence[IndexedChunk], recipe: str) -> None: ...


class ChunkSearcher(Protocol):
    async def search(self, query: Embedding, limit: int) -> Sequence[SearchHit]: ...
