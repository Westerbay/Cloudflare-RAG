"""Config failures should be explicit before any provider call."""

import pytest
from pydantic import ValidationError

from small_rag.config import AppSettings


def test_database_url_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAG_DATABASE_URL", raising=False)

    with pytest.raises(ValidationError, match="database_url"):
        AppSettings()


@pytest.mark.parametrize("database_url", ["sqlite:///rag.db", "postgresql:///rag"])
def test_database_url_rejects_unsupported_or_incomplete_values(database_url: str) -> None:
    with pytest.raises(ValidationError, match="RAG_DATABASE_URL"):
        AppSettings(database_url=database_url)


def test_retrieval_and_chunk_bounds_are_validated() -> None:
    with pytest.raises(ValidationError, match="top_k"):
        AppSettings(database_url="postgresql://localhost/rag", top_k=0)

    with pytest.raises(ValidationError, match="RAG_CHUNK_OVERLAP_CHARS"):
        AppSettings(
            database_url="postgresql://localhost/rag",
            chunk_size_chars=500,
            chunk_overlap_chars=500,
        )


def test_database_password_is_hidden_in_settings_representation() -> None:
    settings = AppSettings(database_url="postgresql://rag:private-password@localhost/rag")

    assert "private-password" not in repr(settings)


def test_invalid_database_url_does_not_echo_password() -> None:
    with pytest.raises(ValidationError) as error:
        AppSettings(database_url="sqlite://rag:private-password@localhost/rag")

    assert "private-password" not in str(error.value)
