"""Read files through extractors registered at the application boundary."""

import json
from pathlib import Path
from typing import Iterator, Mapping

from small_rag.application.ports import TextExtractor
from small_rag.domain.models import Document


class FileCorpus:
    def __init__(self, extractors: Mapping[str, TextExtractor]) -> None:
        if not extractors:
            raise ValueError("At least one text extractor is required")
        self.extractors = {suffix.lower(): extractor for suffix, extractor in extractors.items()}

    @property
    def recipe_id(self) -> str:
        return json.dumps(
            {suffix: extractor.recipe_id for suffix, extractor in self.extractors.items()},
            sort_keys=True,
        )

    def iter_documents(self, root: Path, max_documents: int) -> Iterator[Document]:
        if max_documents < 1:
            raise ValueError("max_documents must be positive")
        root = root.resolve(strict=True)
        count = 0
        for path in sorted(root.rglob("*")):
            extractor = self.extractors.get(path.suffix.lower())
            if extractor is None:
                continue
            source = path.resolve(strict=True)
            if not source.is_relative_to(root):
                raise ValueError("Source is outside corpus root")
            if not source.is_file():
                raise ValueError("Source must be a regular file")
            count += 1
            if count > max_documents:
                raise ValueError(f"Corpus exceeds {max_documents} documents")
            yield extractor.extract(source, root)
