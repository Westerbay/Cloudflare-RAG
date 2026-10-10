"""Measure retrieval, answer latency and raw generation speed inside the API container."""

import argparse
import asyncio
import json
import platform
from time import perf_counter

import httpx

from small_rag.adapters.llama_chat import LlamaCppGenerator
from small_rag.adapters.llama_embeddings import LlamaCppEmbedder
from small_rag.adapters.postgres import PostgresChunkIndex
from small_rag.application.answering import AnswerQuestion
from small_rag.application.indexing import index_recipe
from small_rag.config import AppSettings


async def measure(question: str) -> dict:
    settings = AppSettings()
    embedder = LlamaCppEmbedder(str(settings.embedding_url), settings.embedding_model, settings.provider_timeout_seconds)
    generator = LlamaCppGenerator(str(settings.chat_url), settings.chat_model,
                                  settings.provider_timeout_seconds, settings.max_output_tokens)
    index = PostgresChunkIndex(
        settings.database_url.get_secret_value(), settings.embedding_model,
        index_recipe(settings.embedding_model, settings.chunk_size_chars, settings.chunk_overlap_chars),
    )
    answerer = AnswerQuestion(
        embedder, index, generator, top_k=settings.top_k,
        min_similarity=settings.min_similarity, max_evidence_chars=settings.max_evidence_chars,
        max_message_chars=settings.max_message_chars, max_history_turns=settings.max_history_turns,
    )
    try:
        started = perf_counter()
        query = await embedder.embed(question)
        embedding_ms = (perf_counter() - started) * 1000
        started = perf_counter()
        hits = await index.search(query, settings.top_k)
        vector_search_ms = (perf_counter() - started) * 1000
        started = perf_counter()
        answer = await answerer.ask(question)
        answer_ms = (perf_counter() - started) * 1000
        first_token_ms = None
        started = perf_counter()
        async with httpx.AsyncClient(timeout=settings.provider_timeout_seconds) as client:
            async with client.stream(
                "POST", f"{str(settings.chat_url).rstrip('/')}/completion",
                json={"prompt": "Say hello in one short sentence.", "n_predict": 64,
                      "temperature": 0, "stream": True},
            ) as response:
                response.raise_for_status()
                timings = {}
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    if line[6:] == "[DONE]":
                        break
                    event = json.loads(line[6:])
                    if first_token_ms is None and event.get("content"):
                        first_token_ms = (perf_counter() - started) * 1000
                    if event.get("stop"):
                        timings = event.get("timings") or {}
        sample_ms = (perf_counter() - started) * 1000
        speed = timings.get("predicted_per_second")
        return {
            "machine": platform.platform(), "architecture": platform.machine(),
            "embedding_ms": round(embedding_ms, 1),
            "vector_search_ms": round(vector_search_ms, 1),
            "retrieval_ms": round(embedding_ms + vector_search_ms, 1),
            "answer_ms": round(answer_ms, 1),
            "answer_status": answer.status,
            "retrieved_hits": len(hits),
            "generation_sample_first_token_ms": round(first_token_ms, 1) if first_token_ms is not None else None,
            "generation_sample_total_ms": round(sample_ms, 1),
            "generation_tokens_per_second": round(float(speed), 2) if speed is not None else None,
            "generation_speed_source": "llama.cpp /completion sample, separate from RAG answer",
        }
    finally:
        await embedder.aclose()
        await generator.aclose()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--question", required=True, help="A question supported by the indexed corpus")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(measure(args.question)), ensure_ascii=False))


if __name__ == "__main__":
    main()
