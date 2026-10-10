"""The indexing use case accepts a registered format without knowing its extension."""

import asyncio
import json
from pathlib import Path

from small_rag.adapters.file_corpus import FileCorpus
from small_rag.application.indexing import index_corpus
from small_rag.domain.models import Document, ExtractedBlock, IndexedChunk


def test_index_corpus_uses_reader_contract_for_new_format(tmp_path: Path) -> None:
    (tmp_path / "fact.txt").write_text("A documented fact", encoding="utf-8")

    class PlainTextExtractor:
        recipe_id = "plain-text-v1"

        def extract(self, path: Path, root: Path) -> Document:
            return Document(path.relative_to(root).as_posix(), "test-digest", (
                ExtractedBlock(path.read_text(), 1, 1, None),
            ))

    class StubEmbedder:
        async def embed(self, text: str) -> tuple[float, ...]:
            assert text == "A documented fact"
            return (1.0,) + (0.0,) * 1023

    class RecordingWriter:
        def __init__(self) -> None:
            self.chunks: list[IndexedChunk] = []
            self.recipe = ""

        async def publish(self, chunks: list[IndexedChunk], recipe: str) -> None:
            self.chunks = list(chunks)
            self.recipe = recipe

    writer = RecordingWriter()
    count = asyncio.run(index_corpus(
        tmp_path, FileCorpus({".txt": PlainTextExtractor()}), StubEmbedder(), writer,
        embedding_model="test-model", size_chars=100, overlap_chars=10,
        max_documents=1, max_chunks=2,
    ))

    assert count == 1
    assert writer.chunks[0].chunk.document_path == "fact.txt"
    assert "plain-text-v1" in json.loads(writer.recipe)["corpus"]
