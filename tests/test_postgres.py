"""Exercise generation activation only against an explicit disposable local database."""

import asyncio
import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from small_rag.adapters.postgres import _REBUILD_LOCK, PostgresChunkIndex, migrate
from small_rag.domain.models import Chunk, IndexedChunk


DATABASE_URL = os.getenv("RAG_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="No disposable test database configured")


def _item(chunk_id: str, value: float) -> IndexedChunk:
    return IndexedChunk(
        chunk=Chunk(chunk_id=chunk_id, document_path="test.md", ordinal=0,
                    heading="Test", line_start=1, line_end=1, text="Test passage"),
        embedding=(value,) + (0.0,) * 1023,
    )


def test_migration_and_generation_switch_are_atomic() -> None:
    assert DATABASE_URL is not None
    assert DATABASE_URL.startswith("postgresql://rag:rag-test-only@127.0.0.1:15432/rag")

    async def exercise() -> None:
        await migrate(DATABASE_URL, Path("database/migrations"))
        index = PostgresChunkIndex(DATABASE_URL, "test-embedding-model", "recipe-b")
        first_id = str(uuid4())
        await index.publish([_item(first_id, 1.0)], "recipe-a")

        async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
            before = await (await conn.execute(
                "SELECT generation_id FROM rag_active_generation WHERE singleton = true"
            )).fetchone()
            dimension = await (await conn.execute(
                "SELECT vector_dims(embedding) FROM rag_chunks WHERE chunk_id = %s", (first_id,)
            )).fetchone()
        assert before is not None
        assert dimension == (1024,)

        duplicate = _item(str(uuid4()), 1.0)
        with pytest.raises(psycopg.errors.UniqueViolation):
            await index.publish([duplicate, duplicate], "broken-recipe")
        with pytest.raises(ValueError, match="1024"):
            await index.publish([IndexedChunk(duplicate.chunk, (1.0,))], "invalid-vector")

        async with await psycopg.AsyncConnection.connect(DATABASE_URL, autocommit=True) as other:
            await other.execute("SELECT pg_advisory_lock(%s)", (_REBUILD_LOCK,))
            try:
                with pytest.raises(RuntimeError, match="already running"):
                    await index.publish([_item(str(uuid4()), 1.0)], "concurrent-recipe")
            finally:
                await other.execute("SELECT pg_advisory_unlock(%s)", (_REBUILD_LOCK,))

        async with await psycopg.AsyncConnection.connect(DATABASE_URL) as conn:
            after = await (await conn.execute(
                "SELECT generation_id FROM rag_active_generation WHERE singleton = true"
            )).fetchone()
        assert after == before

        second_id = str(uuid4())
        await index.publish([_item(second_id, 2.0)], "recipe-b")
        hits = await index.search((1.0,) + (0.0,) * 1023, 2)
        assert [hit.chunk.chunk_id for hit in hits] == [second_id]
        with pytest.raises(RuntimeError, match="rebuild"):
            await PostgresChunkIndex(DATABASE_URL, "test-embedding-model", "recipe-c").search(
                (1.0,) + (0.0,) * 1023, 2
            )

    asyncio.run(exercise())
