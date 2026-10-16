import { z } from "zod";
import { corpusSchema, recipeSchema } from "@small-rag/contracts/corpus";
import { embeddingResponseSchema } from "@small-rag/contracts/ai";
import type { CloudflareClient } from "./cloudflare-api.ts";
import { cloudflareConfigSchema } from "../infra/config.ts";
import { exportCorpus } from "./corpus/export.ts";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cloudflareClient } from "./cloudflare-api.ts";
import { EMBEDDING_MODEL, DIMENSIONS } from "@small-rag/contracts/config";
const querySchema = z.array(z.object({ success: z.boolean().optional(), results: z.array(z.record(z.string(), z.unknown())).optional() }));
const indexInfoSchema = z.object({ dimensions: z.number(), vectorCount: z.number().int().nonnegative(), processedUpToMutation: z.string().optional() });
const mutationSchema = z.object({ mutationId: z.string() });
interface PublishOptions { pause?: (milliseconds: number) => Promise<void> }
/** Explicit operator ingestion. Defaults to a local plan; --apply sends the corpus to Cloudflare. */

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function validateCorpus(raw: unknown) {
  const corpus = corpusSchema.parse(raw);
  const recipe = recipeSchema.parse(JSON.parse(corpus.recipe));
  if (recipe.embedding_model !== EMBEDDING_MODEL) throw new Error("Export recipe has an incompatible embedding model");
  return corpus;
}

export async function publishCorpus(client: CloudflareClient, rawConfig: unknown, rawCorpus: unknown, options: PublishOptions = {}) {
  const config = cloudflareConfigSchema.parse(rawConfig);
  const corpus = validateCorpus(rawCorpus);
  const database = config.d1_databases[0].database_id;
  const vectorIndex = encodeURIComponent(config.vectorize[0].index_name);
  if (config.account_id !== client.account || !/^[a-f0-9-]{36}$/i.test(database)
      || database === "00000000-0000-0000-0000-000000000000") throw new Error("Run infra setup for this account first");
  const query = async (sql: string, params: (string | number | null)[] = []) => {
    const result = querySchema.parse(await client.call(`/d1/database/${database}/query`, {
      method: "POST", body: JSON.stringify({ sql, params }),
    }));
    if (result.some(item => item.success === false)) throw new Error("D1 query failed");
    return result[0]?.results ?? [];
  };
  const fingerprint = hash(JSON.stringify(corpus.chunks));
  const active = await query(`SELECT g.id, g.recipe, g.corpus_hash FROM generations g
    JOIN active_generation a ON a.generation_id = g.id WHERE a.singleton = 1`);
  if (active[0]?.corpus_hash === fingerprint && active[0]?.recipe === corpus.recipe) {
    return { generation: active[0].id, chunks: corpus.chunks.length, unchanged: true };
  }
  const info = indexInfoSchema.parse(await client.call(`/vectorize/v2/indexes/${vectorIndex}/info`));
  if (info.dimensions !== DIMENSIONS) throw new Error("Incompatible Vectorize index info");
  if ((info.vectorCount + corpus.chunks.length) * DIMENSIONS > 5_000_000) {
    throw new Error("Staging another generation would exceed the free stored-dimensions allowance; retain the active index and review old generations manually");
  }
  const generation = randomUUID();
  await query(`INSERT INTO generations(id,embedding_model,recipe,corpus_hash,chunk_count) VALUES(?,?,?,?,?)`,
    [generation, EMBEDDING_MODEL, corpus.recipe, fingerprint, corpus.chunks.length]);
  let lastMutation;
  for (let offset = 0; offset < corpus.chunks.length; offset += 10) {
    const batch = corpus.chunks.slice(offset, offset + 10);
    const vectors = [];
    const parameters: (string | number | null)[] = [];
    for (const chunk of batch) {
      const embedding = embeddingResponseSchema.parse(await client.call(`/ai/run/${EMBEDDING_MODEL}`, {
        method: "POST", body: JSON.stringify({ text: [chunk.text] }),
      })).data[0];
      const vectorId = hash(`${generation}\0${chunk.chunk_id}`);
      vectors.push({ id: vectorId, namespace: generation, values: embedding });
      parameters.push(vectorId, generation, chunk.chunk_id, chunk.document_path, chunk.heading,
        chunk.line_start, chunk.line_end, chunk.text);
    }
    await query(`INSERT INTO chunks(vector_id,generation_id,chunk_id,document_path,heading,line_start,line_end,content)
      VALUES ${batch.map(() => "(?,?,?,?,?,?,?,?)").join(",")}`, parameters);
    const form = new FormData();
    form.set("body", new Blob([vectors.map(vector => JSON.stringify(vector)).join("\n") + "\n"],
      { type: "application/x-ndjson" }), "vectors.ndjson");
    const mutation = mutationSchema.parse(await client.call(`/vectorize/v2/indexes/${vectorIndex}/upsert`, { method: "POST", body: form }));
    lastMutation = mutation.mutationId;
  }
  const pause = options.pause ?? ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let indexed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = indexInfoSchema.parse(await client.call(`/vectorize/v2/indexes/${vectorIndex}/info`));
    if (status.processedUpToMutation === lastMutation) { indexed = true; break; }
    await pause(2000);
  }
  if (!indexed) throw new Error("Vectorize indexing was not confirmed; previous active generation is unchanged");
  const rows = await query(`INSERT INTO active_generation(singleton,generation_id)
    SELECT 1, ? WHERE (SELECT COUNT(*) FROM chunks WHERE generation_id = ?) = ?
    ON CONFLICT(singleton) DO UPDATE SET generation_id = excluded.generation_id RETURNING generation_id`,
  [generation, generation, corpus.chunks.length]);
  if (rows[0]?.generation_id !== generation) throw new Error("D1 generation activation was not confirmed");
  return { generation, chunks: corpus.chunks.length, unchanged: false };
}

async function main() {
  const args = process.argv.slice(2);
  let corpusPath = "examples/corpus", apply = false, exportOnly = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--export-only") exportOnly = true;
    else if (args[index] === "--corpus" && args[index + 1]) corpusPath = args[++index];
    else throw new Error("Usage: pnpm corpus:index [--corpus DIRECTORY] [--apply]");
  }
  if (apply && exportOnly) throw new Error("--export-only cannot be combined with --apply");
  const corpus = validateCorpus(await exportCorpus(corpusPath));
  if (exportOnly) { console.log(JSON.stringify(corpus, null, 2)); return; }
  if (!apply) {
    console.log(`Plan: embed and publish ${corpus.chunks.length} chunks from ${corpusPath}. No remote calls were made.`);
    console.log("Use --apply to send this corpus to Workers AI, D1 and Vectorize. Indexing consumes the account's AI quota separately from chat.");
    return;
  }
  const config = JSON.parse(await readFile(new URL("../infra/wrangler.local.json", import.meta.url), "utf8"));
  const result = await publishCorpus(cloudflareClient(), config, corpus);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Corpus indexing failed"); process.exitCode = 1; });
}
