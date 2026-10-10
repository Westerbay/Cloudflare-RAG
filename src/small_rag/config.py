"""Validated operator configuration. No settings are read on module import."""

from pathlib import Path
from urllib.parse import urlsplit

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RAG_",
        extra="ignore",
        validate_default=True,
        hide_input_in_errors=True,
    )

    database_url: SecretStr
    corpus_root: Path = Path("data/corpus")
    chat_url: AnyHttpUrl = "http://127.0.0.1:8081"
    embedding_url: AnyHttpUrl = "http://127.0.0.1:8082"
    chat_model: str = Field("qwen3.5-2b", min_length=1)
    embedding_model: str = Field("qwen3-embedding-0.6b", min_length=1)
    top_k: int = Field(4, ge=1, le=20)
    min_similarity: float = Field(0.4, ge=-1.0, le=1.0, allow_inf_nan=False)
    chunk_size_chars: int = Field(1200, ge=200, le=8000)
    chunk_overlap_chars: int = Field(120, ge=0, le=1000)
    max_document_bytes: int = Field(2_000_000, ge=1, le=20_000_000)
    max_documents: int = Field(1000, ge=1, le=10_000)
    max_chunks: int = Field(10_000, ge=1, le=100_000)
    max_message_chars: int = Field(4000, ge=1, le=20_000)
    max_history_turns: int = Field(8, ge=0, le=20)
    max_evidence_chars: int = Field(6000, ge=500, le=20_000)
    max_output_tokens: int = Field(384, ge=64, le=1024)
    provider_timeout_seconds: int = Field(120, ge=1, le=600)

    @field_validator("database_url")
    @classmethod
    def validate_database_url(cls, value: SecretStr) -> SecretStr:
        url = urlsplit(value.get_secret_value())
        if url.scheme != "postgresql" or not url.hostname or not url.path.strip("/"):
            raise ValueError("RAG_DATABASE_URL must be postgresql:// with a host and database name")
        return value

    @model_validator(mode="after")
    def validate_chunk_overlap(self) -> "AppSettings":
        if self.chunk_overlap_chars >= self.chunk_size_chars:
            raise ValueError("RAG_CHUNK_OVERLAP_CHARS must be smaller than RAG_CHUNK_SIZE_CHARS")
        return self
