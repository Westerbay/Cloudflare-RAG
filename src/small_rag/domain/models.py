"""Data shared by indexing, retrieval and answering."""

from dataclasses import dataclass
from enum import StrEnum
from typing import TypeAlias


Embedding: TypeAlias = tuple[float, ...]


@dataclass(frozen=True)
class ExtractedBlock:
    text: str
    line_start: int
    line_end: int
    heading: str | None


@dataclass(frozen=True)
class Document:
    relative_path: str
    sha256: str
    blocks: tuple[ExtractedBlock, ...]

    @property
    def text(self) -> str:
        return "\n\n".join(block.text for block in self.blocks)


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    document_path: str
    ordinal: int
    heading: str | None
    line_start: int
    line_end: int
    text: str


@dataclass(frozen=True)
class IndexedChunk:
    chunk: Chunk
    embedding: Embedding


@dataclass(frozen=True)
class SearchHit:
    chunk: Chunk
    score: float


@dataclass(frozen=True)
class Citation:
    chunk_id: str
    document_path: str
    line_start: int
    line_end: int


class AnswerStatus(StrEnum):
    ANSWERED = "answered"
    INSUFFICIENT_CONTEXT = "insufficient_context"
    OUT_OF_SCOPE = "out_of_scope"


@dataclass(frozen=True)
class ChatTurn:
    role: str
    content: str


@dataclass(frozen=True)
class Answer:
    status: AnswerStatus
    text: str
    citations: tuple[Citation, ...]
