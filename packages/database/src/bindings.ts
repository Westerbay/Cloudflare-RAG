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
