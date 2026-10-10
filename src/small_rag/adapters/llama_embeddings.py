"""Embedding requests to a private llama.cpp server."""

import math

import httpx

from small_rag.domain.models import Embedding


class LlamaCppEmbedder:
    def __init__(self, base_url: str, model: str, timeout_seconds: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.client = httpx.AsyncClient(timeout=timeout_seconds)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def embed(self, text: str) -> Embedding:
        response = await self.client.post(
            f"{self.base_url}/v1/embeddings",
            json={"model": self.model, "input": text},
        )
        response.raise_for_status()
        payload = response.json()
        try:
            values = payload["data"][0]["embedding"]
            embedding = tuple(float(value) for value in values)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ValueError("llama.cpp returned an invalid embedding response") from error
        if len(embedding) != 1024 or not all(math.isfinite(value) for value in embedding):
            raise ValueError("Embedding must have 1024 finite dimensions")
        if not any(value != 0 for value in embedding):
            raise ValueError("Embedding must be nonzero")
        return embedding
