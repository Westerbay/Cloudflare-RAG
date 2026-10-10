"""Deterministic, source-linked character windows for extracted blocks."""

import hashlib

from small_rag.domain.models import Chunk, Document, ExtractedBlock


def _chunk_id(document: Document, ordinal: int, heading: str | None, text: str) -> str:
    identity = "\0".join((document.relative_path, document.sha256, str(ordinal), heading or "", text))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _sections(blocks: tuple[ExtractedBlock, ...]) -> list[tuple[str | None, list[ExtractedBlock]]]:
    sections: list[tuple[str | None, list[ExtractedBlock]]] = []
    for block in blocks:
        if not sections or sections[-1][0] != block.heading:
            sections.append((block.heading, []))
        sections[-1][1].append(block)
    return sections


def chunk_document(document: Document, size_chars: int, overlap_chars: int) -> tuple[Chunk, ...]:
    if size_chars < 1 or overlap_chars < 0 or overlap_chars >= size_chars:
        raise ValueError("Chunk size must be positive and overlap smaller than size")
    chunks: list[Chunk] = []
    for heading, blocks in _sections(document.blocks):
        text = "\n\n".join(block.text for block in blocks)
        if not text:
            continue
        spans: list[tuple[int, int, ExtractedBlock]] = []
        offset = 0
        for block in blocks:
            spans.append((offset, offset + len(block.text), block))
            offset += len(block.text) + 2
        start = 0
        while start < len(text):
            end = min(start + size_chars, len(text))
            window = text[start:end]
            if window.strip():
                touched = [block for block_start, block_end, block in spans if block_start < end and block_end > start]
                ordinal = len(chunks)
                chunks.append(
                    Chunk(
                        chunk_id=_chunk_id(document, ordinal, heading, window),
                        document_path=document.relative_path,
                        ordinal=ordinal,
                        heading=heading,
                        line_start=min(block.line_start for block in touched),
                        line_end=max(block.line_end for block in touched),
                        text=window,
                    )
                )
            if end == len(text):
                break
            start = end - overlap_chars
    return tuple(chunks)
