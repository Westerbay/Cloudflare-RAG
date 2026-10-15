import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Database, Statement } from "../contracts.ts";

export class SQLiteDatabase implements Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(readFileSync(new URL("../../infra/migrations/0001_rag.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string): Statement {
    const query = this.sqlite.prepare(sql);
    let parameters: (string | number | null)[] = [];
    const statement: Statement = {
      bind(...values: unknown[]) {
        parameters = values.map(value => {
          if (typeof value === "string" || typeof value === "number" || value === null) return value;
          throw new Error("Unsupported SQL parameter");
        });
        return statement;
      },
      async first() { return query.get(...parameters) ?? null; },
      async all() { return { results: query.all(...parameters) }; },
      async run() { return query.run(...parameters); },
    };
    return statement;
  }
}
