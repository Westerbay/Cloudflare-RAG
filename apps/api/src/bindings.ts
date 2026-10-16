import type { Database } from "@small-rag/database/bindings";

export interface AIBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface VectorBinding {
  query(vector: number[], options: { topK: number; namespace: string; returnMetadata: "none" }):
    Promise<{ matches: { id: string; score: number }[] }>;
  describe(): Promise<{ dimensions: number }>;
}

export interface Env {
  DB: Database;
  AI: AIBinding;
  VECTORS: VectorBinding;
  BASIC_AUTH_PASSWORD?: string;
  MIN_SIMILARITY?: string;
}
