CREATE TABLE generations (
    id TEXT PRIMARY KEY,
    embedding_model TEXT NOT NULL,
    recipe TEXT NOT NULL,
    corpus_hash TEXT NOT NULL DEFAULT '',
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE chunks (
    vector_id TEXT PRIMARY KEY,
    generation_id TEXT NOT NULL REFERENCES generations(id),
    chunk_id TEXT NOT NULL,
    document_path TEXT NOT NULL,
    heading TEXT,
    line_start INTEGER NOT NULL CHECK (line_start > 0),
    line_end INTEGER NOT NULL CHECK (line_end >= line_start),
    content TEXT NOT NULL,
    UNIQUE (generation_id, chunk_id)
);
CREATE INDEX chunks_by_generation ON chunks(generation_id);

CREATE TABLE active_generation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation_id TEXT NOT NULL REFERENCES generations(id)
);

-- Retained for compatibility with already-applied migrations. The Worker no longer
-- reads or writes this historical application counter; Cloudflare enforces quotas.
CREATE TABLE daily_usage (
    day TEXT PRIMARY KEY,
    questions INTEGER NOT NULL CHECK (questions BETWEEN 1 AND 500)
);
