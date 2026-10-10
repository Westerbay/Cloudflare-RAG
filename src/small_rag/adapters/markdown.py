"""Markdown text extraction with source lines and a confined input path."""

import hashlib
from importlib.metadata import version
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.token import Token

from small_rag.domain.models import Document, ExtractedBlock
from small_rag.adapters.file_corpus import FileCorpus


def _plain_text(token: Token) -> str:
    if not token.children:
        return token.content.strip()
    parts: list[str] = []
    for child in token.children:
        if child.type in {"text", "code_inline"}:
            parts.append(child.content)
        elif child.type in {"softbreak", "hardbreak"}:
            parts.append("\n")
        elif child.type == "image":
            parts.append(child.content)
    return "".join(parts).strip()


class MarkdownTextExtractor:
    def __init__(self, max_document_bytes: int) -> None:
        if max_document_bytes < 1:
            raise ValueError("max_document_bytes must be positive")
        self.max_document_bytes = max_document_bytes
        self.parser = MarkdownIt("commonmark")

    @property
    def recipe_id(self) -> str:
        return f"markdown-it-py-{version('markdown-it-py')}"

    def extract(self, path: Path, corpus_root: Path) -> Document:
        root = corpus_root.resolve(strict=True)
        source = path.resolve(strict=True)
        if not source.is_relative_to(root) or source == root:
            raise ValueError("Markdown source must be inside the corpus root")
        if source.suffix.lower() not in {".md", ".markdown"}:
            raise ValueError("Only Markdown files can be extracted")
        if not source.is_file():
            raise ValueError("Markdown source must be a regular file")

        with source.open("rb") as stream:
            raw = stream.read(self.max_document_bytes + 1)
        if len(raw) > self.max_document_bytes:
            raise ValueError(f"Markdown source exceeds {self.max_document_bytes} bytes")
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise ValueError("Markdown source must be UTF-8") from error

        headings: list[str] = []
        blocks: list[ExtractedBlock] = []
        tokens = self.parser.parse(content)
        for index, token in enumerate(tokens):
            if token.type == "heading_open":
                level = int(token.tag[1:])
                heading_text = _plain_text(tokens[index + 1])
                headings = headings[: level - 1]
                headings.append(heading_text)
            if token.type not in {"inline", "fence", "code_block"} or token.map is None:
                continue
            plain = _plain_text(token)
            if not plain:
                continue
            blocks.append(
                ExtractedBlock(
                    text=plain,
                    line_start=token.map[0] + 1,
                    line_end=token.map[1],
                    heading=" > ".join(headings) or None,
                )
            )
        return Document(
            relative_path=source.relative_to(root).as_posix(),
            sha256=hashlib.sha256(raw).hexdigest(),
            blocks=tuple(blocks),
        )


def markdown_corpus(max_document_bytes: int) -> FileCorpus:
    extractor = MarkdownTextExtractor(max_document_bytes)
    return FileCorpus({".md": extractor, ".markdown": extractor})
