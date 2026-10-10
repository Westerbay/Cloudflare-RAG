"""Versioned PostgreSQL schema and complete pgvector index generations."""

import math
from pathlib import Path
from typing import Sequence
from uuid import uuid4

import psycopg

from small_rag.domain.models import Chunk, Embedding, IndexedChunk, SearchHit


_REBUILD_LOCK = 61257001


def _vector_literal(embedding: Embedding) -> str:
    if len(embedding) != 1024 or not all(math.isfinite(value) for value in embedding):
        raise ValueError("Embedding must have 1024 finite dimensions")
    if not any(value != 0 for value in embedding):
        raise ValueError("Embedding must be nonzero")
    return "[" + ",".join(str(value) for value in embedding) + "]"


async def migrate(database_url: str, migrations_dir: Path) -> None:
    files = sorted(migrations_dir.glob("[0-9][0-9][0-9]_*.sql"))
    if not files:
        raise ValueError("No SQL migrations found")
    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (_REBUILD_LOCK,))
            await conn.execute("CREATE TABLE IF NOT EXISTS rag_schema_migrations (version text PRIMARY KEY)")
            rows = await (await conn.execute("SELECT version FROM rag_schema_migrations")).fetchall()
            applied = {row[0] for row in rows}
            for migration in files:
                if migration.name in applied:
                    continue
                await conn.execute(migration.read_text(encoding="utf-8"))
                await conn.execute("INSERT INTO rag_schema_migrations (version) VALUES (%s)", (migration.name,))


class PostgresChunkIndex:
    def __init__(self, database_url: str, embedding_model: str, expected_recipe: str) -> None:
        self.database_url = database_url
        self.embedding_model = embedding_model
        self.expected_recipe = expected_recipe

    async def check_ready(self) -> bool:
        async with await psycopg.AsyncConnection.connect(self.database_url) as conn:
            row = await (await conn.execute(
                """SELECT g.embedding_model, g.recipe FROM rag_generations g
                   JOIN rag_active_generation a ON a.generation_id = g.id"""
            )).fetchone()
        return row == (self.embedding_model, self.expected_recipe)

    async def publish(self, chunks: Sequence[IndexedChunk], recipe: str) -> None:
        if not chunks:
            raise ValueError("Refusing to activate an empty index")
        vectors = [(_vector_literal(item.embedding), item.chunk) for item in chunks]
        generation_id = uuid4()
        async with await psycopg.AsyncConnection.connect(self.database_url, autocommit=True) as conn:
            locked = await (await conn.execute("SELECT pg_try_advisory_lock(%s)", (_REBUILD_LOCK,))).fetchone()
            if not locked or not locked[0]:
                raise RuntimeError("Another index rebuild is already running")
            try:
                async with conn.transaction():
                    await conn.execute(
                        "INSERT INTO rag_generations (id, recipe, embedding_model) VALUES (%s, %s, %s)",
                        (generation_id, recipe, self.embedding_model),
                    )
                    for vector, chunk in vectors:
                        await conn.execute(
                            """INSERT INTO rag_chunks
                               (generation_id, chunk_id, document_path, ordinal, heading, line_start, line_end, content, embedding)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)""",
                            (generation_id, chunk.chunk_id, chunk.document_path, chunk.ordinal,
                             chunk.heading, chunk.line_start, chunk.line_end, chunk.text, vector),
                        )
                async with conn.transaction():
                    await conn.execute(
                        """INSERT INTO rag_active_generation (singleton, generation_id) VALUES (true, %s)
                           ON CONFLICT (singleton) DO UPDATE SET generation_id = EXCLUDED.generation_id""",
                        (generation_id,),
                    )
            finally:
                await conn.execute("SELECT pg_advisory_unlock(%s)", (_REBUILD_LOCK,))

    async def search(self, query: Embedding, limit: int) -> tuple[SearchHit, ...]:
        if limit < 1:
            raise ValueError("Search limit must be positive")
        vector = _vector_literal(query)
        async with await psycopg.AsyncConnection.connect(self.database_url) as conn:
            active = await (await conn.execute(
                """SELECT g.id, g.embedding_model, g.recipe FROM rag_generations g
                   JOIN rag_active_generation a ON a.generation_id = g.id"""
            )).fetchone()
            if active is None:
                raise RuntimeError("No active index; run the indexing command")
            if active[1:] != (self.embedding_model, self.expected_recipe):
                raise RuntimeError("Index recipe differs from current configuration; rebuild the index")
            rows = await (await conn.execute(
                """SELECT c.chunk_id, c.document_path, c.ordinal, c.heading, c.line_start,
                          c.line_end, c.content, 1 - (c.embedding <=> %s::vector) AS score
                   FROM rag_chunks c
                   WHERE c.generation_id = %s
                   ORDER BY c.embedding <=> %s::vector, c.document_path, c.ordinal
                   LIMIT %s""",
                (vector, active[0], vector, limit),
            )).fetchall()
        return tuple(
            SearchHit(
                chunk=Chunk(chunk_id=row[0], document_path=row[1], ordinal=row[2],
                            heading=row[3], line_start=row[4], line_end=row[5], text=row[6]),
                score=float(row[7]),
            )
            for row in rows
        )
