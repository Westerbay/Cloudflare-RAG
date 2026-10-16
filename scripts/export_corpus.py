"""Export source-linked chunks locally; this command never calls a provider or database."""

import argparse
from dataclasses import asdict
import json
from pathlib import Path

from small_rag.adapters.markdown import markdown_corpus
from small_rag.application.chunking import chunk_document
from small_rag.application.indexing import index_recipe


def export_corpus(root: Path, embedding_model: str) -> dict:
    reader = markdown_corpus(2_000_000)
    chunks = []
    for document in reader.iter_documents(root, 100):
        chunks.extend(chunk_document(document, 1200, 120))
        if len(chunks) > 1000:
            raise ValueError("The free-tier corpus profile allows at most 1000 chunks")
    if not chunks:
        raise ValueError("Corpus has no indexable Markdown chunks")
    return {
        "recipe": index_recipe(reader.recipe_id, embedding_model, 1200, 120),
        "chunks": [asdict(chunk) for chunk in chunks],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a Markdown corpus without external calls")
    parser.add_argument("--corpus", type=Path, default=Path("examples/corpus"))
    parser.add_argument("--embedding-model", required=True)
    args = parser.parse_args()
    print(json.dumps(export_corpus(args.corpus, args.embedding_model), ensure_ascii=False))


if __name__ == "__main__":
    main()
