/** The binding operations this application needs; adapters remain structurally typed. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first(): Promise<Record<string, unknown> | null>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  run(): Promise<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
}

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

export interface Turn { role: "user" | "assistant"; content: string }
export interface ChatInput { message: string; history: Turn[] }
export interface Evidence {
  id: string;
  chunk_id: string;
  path: string;
  lines: [number, number];
  heading: string | null;
  text: string;
}
