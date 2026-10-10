"""Markdown ingestion must preserve stable, confined source evidence."""

from pathlib import Path

import pytest

from small_rag.adapters.markdown import MarkdownTextExtractor
from small_rag.application.chunking import chunk_document


def test_extract_and_chunk_preserve_heading_path_lines_and_identity(tmp_path: Path) -> None:
    source = tmp_path / "guide.md"
    source.write_text(
        "# Guide\n\nFirst **important** fact.\n\n## Details\n\nSecond [linked](https://example.com) fact.\n",
        encoding="utf-8",
    )
    extractor = MarkdownTextExtractor(max_document_bytes=1000)

    first = extractor.extract(source, tmp_path)
    second = extractor.extract(source, tmp_path)
    chunks = chunk_document(first, size_chars=80, overlap_chars=10)

    assert first == second
    assert [(block.text, block.line_start, block.line_end, block.heading) for block in first.blocks] == [
        ("Guide", 1, 1, "Guide"),
        ("First important fact.", 3, 3, "Guide"),
        ("Details", 5, 5, "Guide > Details"),
        ("Second linked fact.", 7, 7, "Guide > Details"),
    ]
    assert [(chunk.document_path, chunk.line_start, chunk.line_end) for chunk in chunks] == [
        ("guide.md", 1, 3),
        ("guide.md", 5, 7),
    ]
    assert chunks == chunk_document(second, size_chars=80, overlap_chars=10)


def test_long_section_stays_bounded_and_overlaps(tmp_path: Path) -> None:
    source = tmp_path / "long.md"
    source.write_text("# Long\n\n" + "alpha beta gamma " * 20, encoding="utf-8")
    document = MarkdownTextExtractor(max_document_bytes=1000).extract(source, tmp_path)

    chunks = chunk_document(document, size_chars=60, overlap_chars=10)

    assert len(chunks) > 1
    assert all(0 < len(chunk.text) <= 60 for chunk in chunks)
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))
    assert chunks[0].text[-10:] == chunks[1].text[:10]


def test_empty_document_produces_no_chunks(tmp_path: Path) -> None:
    source = tmp_path / "empty.md"
    source.write_text("", encoding="utf-8")

    document = MarkdownTextExtractor(max_document_bytes=10).extract(source, tmp_path)

    assert document.blocks == ()
    assert chunk_document(document, size_chars=20, overlap_chars=2) == ()


def test_rejects_outside_root_and_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "corpus"
    root.mkdir()
    outside = tmp_path / "private.md"
    outside.write_text("Private", encoding="utf-8")
    (root / "link.md").symlink_to(outside)
    extractor = MarkdownTextExtractor(max_document_bytes=100)

    for path in (outside, root / "link.md"):
        with pytest.raises(ValueError, match="inside the corpus root"):
            extractor.extract(path, root)


def test_rejects_oversized_non_markdown_and_invalid_utf8(tmp_path: Path) -> None:
    large = tmp_path / "large.md"
    large.write_text("too large", encoding="utf-8")
    wrong_suffix = tmp_path / "plain.txt"
    wrong_suffix.write_text("text", encoding="utf-8")
    invalid = tmp_path / "invalid.md"
    invalid.write_bytes(b"\xff")
    extractor = MarkdownTextExtractor(max_document_bytes=4)

    with pytest.raises(ValueError, match="exceeds"):
        extractor.extract(large, tmp_path)
    with pytest.raises(ValueError, match="Only Markdown"):
        extractor.extract(wrong_suffix, tmp_path)
    with pytest.raises(ValueError, match="UTF-8"):
        extractor.extract(invalid, tmp_path)
