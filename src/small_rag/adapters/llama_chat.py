"""Chat completion requests to a private llama.cpp server."""

import httpx

from small_rag.domain.models import AnswerStatus


# Constrain both response branches; the use case still validates citation membership.
ANSWER_SCHEMA = {
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "status": {"enum": [AnswerStatus.ANSWERED.value]},
                "answer": {"type": "string", "minLength": 1},
                "citations": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            },
            "required": ["status", "answer", "citations"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "status": {"enum": [AnswerStatus.INSUFFICIENT_CONTEXT.value, AnswerStatus.OUT_OF_SCOPE.value]},
                "answer": {"type": "string", "minLength": 1},
                "citations": {"type": "array", "items": {"type": "string"}, "maxItems": 0},
            },
            "required": ["status", "answer", "citations"],
            "additionalProperties": False,
        },
    ],
}


class LlamaCppGenerator:
    def __init__(self, base_url: str, model: str, timeout_seconds: int, max_output_tokens: int) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.max_output_tokens = max_output_tokens
        self.client = httpx.AsyncClient(timeout=timeout_seconds)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def generate(self, system_prompt: str, user_prompt: str) -> str:
        response = await self.client.post(
            f"{self.base_url}/v1/chat/completions",
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.1,
                "max_tokens": self.max_output_tokens,
                "stream": False,
                "chat_template_kwargs": {"enable_thinking": False},
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {"name": "rag_answer", "strict": True, "schema": ANSWER_SCHEMA},
                },
            },
        )
        response.raise_for_status()
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ValueError("llama.cpp returned an invalid chat response") from error
        if not isinstance(content, str) or not content:
            raise ValueError("llama.cpp returned an empty chat response")
        return content
