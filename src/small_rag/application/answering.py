"""Retrieve evidence, enforce mission limits, and validate source citations."""

import json
import math
from collections.abc import Sequence

from small_rag.application.ports import ChunkSearcher, Embedder, Generator
from small_rag.domain.models import Answer, AnswerStatus, ChatTurn, Citation, SearchHit


class InvalidInput(ValueError):
    """Caller-supplied chat input violates a configured bound."""


class AnswerQuestion:
    def __init__(
        self,
        embedder: Embedder,
        index: ChunkSearcher,
        generator: Generator,
        *,
        top_k: int,
        min_similarity: float,
        max_evidence_chars: int,
        max_message_chars: int,
        max_history_turns: int,
        system_prompt: str,
    ) -> None:
        self.embedder = embedder
        self.index = index
        self.generator = generator
        self.top_k = top_k
        self.min_similarity = min_similarity
        self.max_evidence_chars = max_evidence_chars
        self.max_message_chars = max_message_chars
        self.max_history_turns = max_history_turns
        if not system_prompt.strip():
            raise ValueError("System prompt must not be empty")
        self.system_prompt = system_prompt

    async def _generate(
        self, question: str, history: Sequence[ChatTurn], evidence: list[dict],
        required_status: AnswerStatus | None = None,
    ) -> dict:
        payload = {
            "question": question,
            "history": [{"role": turn.role, "content": turn.content} for turn in history],
            "evidence": evidence,
        }
        if required_status is not None:
            payload["required_status"] = required_status.value
        raw = await self.generator.generate(self.system_prompt, json.dumps(payload, ensure_ascii=False))
        try:
            result = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("Chat model returned invalid JSON") from error
        if not isinstance(result, dict):
            raise ValueError("Chat model returned an invalid answer object")
        return result

    @staticmethod
    def _validated_refusal(result: dict, status: AnswerStatus) -> Answer:
        text = result.get("answer")
        if (result.get("status") != status or result.get("citations") != []
                or not isinstance(text, str) or not text.strip()):
            raise ValueError("Chat model returned an invalid refusal")
        return Answer(status, text.strip(), ())

    async def _refuse(self, question: str, history: Sequence[ChatTurn], status: AnswerStatus) -> Answer:
        result = await self._generate(question, history, [], required_status=status)
        return self._validated_refusal(result, status)

    async def ask(self, question: str, history: Sequence[ChatTurn] = ()) -> Answer:
        if not question.strip() or len(question) > self.max_message_chars:
            raise InvalidInput("Question must be nonempty and within the configured limit")
        if len(history) > self.max_history_turns:
            raise InvalidInput("Chat history exceeds the configured turn limit")
        if any(turn.role not in {"user", "assistant"} or not turn.content or
               len(turn.content) > self.max_message_chars for turn in history):
            raise InvalidInput("Chat history has an invalid role or message length")

        query = await self.embedder.embed(question)
        hits = await self.index.search(query, self.top_k)
        eligible = [hit for hit in hits if math.isfinite(hit.score) and hit.score >= self.min_similarity]
        if not eligible:
            return await self._refuse(question, history, AnswerStatus.INSUFFICIENT_CONTEXT)

        selected: list[tuple[SearchHit, str]] = []
        remaining = self.max_evidence_chars
        for hit in eligible:
            if remaining <= 0:
                break
            content = hit.chunk.text[:remaining]
            if not content:
                continue
            selected.append((hit, content))
            remaining -= len(content)
        if not selected:
            return await self._refuse(question, history, AnswerStatus.INSUFFICIENT_CONTEXT)

        # Request-local aliases avoid asking the model to generate long hash IDs.
        chosen = {f"s{position}": hit.chunk for position, (hit, _) in enumerate(selected, start=1)}
        evidence = [
            {"id": source_id, "path": chunk.document_path,
             "lines": [chunk.line_start, chunk.line_end],
             "heading": chunk.heading, "text": content}
            for (source_id, chunk), (_, content) in zip(chosen.items(), selected)
        ]
        result = await self._generate(question, history, evidence)
        status = result.get("status")
        if status == AnswerStatus.OUT_OF_SCOPE:
            return self._validated_refusal(result, AnswerStatus.OUT_OF_SCOPE)
        if status == AnswerStatus.INSUFFICIENT_CONTEXT:
            return self._validated_refusal(result, AnswerStatus.INSUFFICIENT_CONTEXT)
        if status != AnswerStatus.ANSWERED:
            raise ValueError("Chat model returned an unknown answer status")

        answer_text = result.get("answer")
        citation_ids = result.get("citations")
        if not isinstance(answer_text, str) or not answer_text.strip():
            return await self._refuse(question, history, AnswerStatus.INSUFFICIENT_CONTEXT)
        if not isinstance(citation_ids, list) or not citation_ids:
            return await self._refuse(question, history, AnswerStatus.INSUFFICIENT_CONTEXT)
        if any(not isinstance(item, str) or item not in chosen for item in citation_ids):
            return await self._refuse(question, history, AnswerStatus.INSUFFICIENT_CONTEXT)
        citations = tuple(
            Citation(chunk_id=chosen[source_id].chunk_id, document_path=chosen[source_id].document_path,
                     line_start=chosen[source_id].line_start, line_end=chosen[source_id].line_end)
            for source_id in dict.fromkeys(citation_ids)
        )
        return Answer(AnswerStatus.ANSWERED, answer_text.strip(), citations)
