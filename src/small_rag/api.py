"""HTTP boundary for a single-user, corpus-grounded chat service."""

from contextlib import asynccontextmanager
from typing import Literal

import httpx
import psycopg
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from small_rag.adapters.llama_chat import LlamaCppGenerator
from small_rag.adapters.llama_embeddings import LlamaCppEmbedder
from small_rag.adapters.postgres import PostgresChunkIndex
from small_rag.application.answering import AnswerQuestion, InvalidInput
from small_rag.application.indexing import index_recipe
from small_rag.config import AppSettings
from small_rag.domain.models import ChatTurn


class TurnIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=20_000)
    history: list[TurnIn] = Field(default_factory=list, max_length=20)


def create_app() -> FastAPI:
    settings = AppSettings()
    database_url = settings.database_url.get_secret_value()
    index = PostgresChunkIndex(
        database_url, settings.embedding_model,
        index_recipe(settings.embedding_model, settings.chunk_size_chars, settings.chunk_overlap_chars),
    )
    embedder = LlamaCppEmbedder(str(settings.embedding_url), settings.embedding_model, settings.provider_timeout_seconds)
    generator = LlamaCppGenerator(
        str(settings.chat_url), settings.chat_model,
        settings.provider_timeout_seconds, settings.max_output_tokens,
    )
    answerer = AnswerQuestion(
        embedder, index, generator, top_k=settings.top_k,
        min_similarity=settings.min_similarity,
        max_evidence_chars=settings.max_evidence_chars,
        max_message_chars=settings.max_message_chars,
        max_history_turns=settings.max_history_turns,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await embedder.aclose()
        await generator.aclose()

    app = FastAPI(title="Small RAG", lifespan=lifespan)

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready() -> dict[str, str]:
        try:
            if not await index.check_ready():
                raise RuntimeError("Index is absent or incompatible")
            async with httpx.AsyncClient(timeout=min(settings.provider_timeout_seconds, 5)) as client:
                for base_url in (settings.embedding_url, settings.chat_url):
                    response = await client.get(f"{str(base_url).rstrip('/')}/health")
                    response.raise_for_status()
                    health = response.json()
                    if not isinstance(health, dict) or health.get("status") != "ok":
                        raise ValueError("Model is not ready")
        except (psycopg.Error, httpx.HTTPError, RuntimeError, ValueError) as error:
            raise HTTPException(status_code=503, detail="RAG service is not ready") from error
        return {"status": "ok"}

    @app.post("/v1/chat")
    async def chat(payload: ChatIn) -> dict:
        try:
            answer = await answerer.ask(
                payload.message,
                tuple(ChatTurn(turn.role, turn.content) for turn in payload.history),
            )
        except InvalidInput as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=503, detail="RAG provider returned invalid data") from error
        except (psycopg.Error, httpx.HTTPError, RuntimeError) as error:
            raise HTTPException(status_code=503, detail="RAG service is unavailable") from error
        return {
            "status": answer.status,
            "answer": answer.text,
            "citations": [
                {"chunk_id": citation.chunk_id, "path": citation.document_path,
                 "line_start": citation.line_start, "line_end": citation.line_end}
                for citation in answer.citations
            ],
        }

    return app
