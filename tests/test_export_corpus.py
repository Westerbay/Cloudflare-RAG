"""Reject unsafe free-profile corpus sizes before any hosted operation."""

from pathlib import Path

import pytest

from scripts.export_corpus import export_corpus


def test_cloudflare_export_refuses_more_than_one_thousand_chunks(tmp_path: Path) -> None:
    sections = [f"# Section {index}\n\nA distinct source passage.\n" for index in range(1001)]
    (tmp_path / "many-sections.md").write_text("\n".join(sections), encoding="utf-8")

    with pytest.raises(ValueError, match="1000 chunks"):
        export_corpus(tmp_path, "test-embedding-model")


def test_cloudflare_export_cannot_publish_an_empty_generation(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="no indexable"):
        export_corpus(tmp_path, "test-embedding-model")
