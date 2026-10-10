CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_generations (
    id uuid PRIMARY KEY,
    recipe text NOT NULL,
    embedding_model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rag_chunks (
    generation_id uuid NOT NULL REFERENCES rag_generations(id) ON DELETE CASCADE,
    chunk_id text NOT NULL,
    document_path text NOT NULL,
    ordinal integer NOT NULL,
    heading text,
    line_start integer NOT NULL CHECK (line_start > 0),
    line_end integer NOT NULL CHECK (line_end >= line_start),
    content text NOT NULL CHECK (length(content) > 0),
    embedding vector(1024) NOT NULL,
    PRIMARY KEY (generation_id, chunk_id),
    UNIQUE (generation_id, document_path, ordinal)
);

CREATE TABLE rag_active_generation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation_id uuid NOT NULL REFERENCES rag_generations(id)
);
