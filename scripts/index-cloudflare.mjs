/** Explicit operator ingestion. Defaults to a local plan; --apply sends the corpus to Cloudflare. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cloudflareClient } from "./cloudflare-api.mjs";
import { EMBEDDING_MODEL, DIMENSIONS } from "../worker/config.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");

export function validateCorpus(corpus) {
  if (!corpus || typeof corpus.recipe !== "string" || !Array.isArray(corpus.chunks)
      || corpus.chunks.length < 1 || corpus.chunks.length > 1000) throw new Error("Expected 1–1000 exported chunks and an indexing recipe");
  const recipe = JSON.parse(corpus.recipe);
  if (recipe.embedding_model !== EMBEDDING_MODEL) throw new Error("Export recipe has an incompatible embedding model");
  const ids = new Set();
  for (const chunk of corpus.chunks) {
    if (typeof chunk.chunk_id !== "string" || !/^[a-f0-9]{64}$/.test(chunk.chunk_id) || ids.has(chunk.chunk_id)
        || typeof chunk.document_path !== "string" || !chunk.document_path || chunk.document_path.startsWith("/")
        || chunk.document_path.split(/[\\/]/).includes("..")
        || typeof chunk.text !== "string" || !chunk.text.trim() || chunk.text.length > 1200
        || (chunk.heading !== null && typeof chunk.heading !== "string")
        || !Number.isInteger(chunk.line_start) || !Number.isInteger(chunk.line_end)
        || chunk.line_start < 1 || chunk.line_end < chunk.line_start) throw new Error("Invalid or duplicate exported chunk");
    ids.add(chunk.chunk_id);
  }
  return corpus;
}

function vectorFrom(value) {
  const vector = value?.data?.[0];
  if (!Array.isArray(vector) || vector.length !== DIMENSIONS
      || !vector.every(item => typeof item === "number" && Number.isFinite(item))
      || !vector.some(item => item !== 0)) throw new Error("Cloudflare returned an invalid embedding");
  return vector;
}

export async function publishCorpus(client, config, rawCorpus, options = {}) {
  const corpus = validateCorpus(rawCorpus);
  const database = config.d1_databases[0].database_id;
  const vectorIndex = encodeURIComponent(config.vectorize[0].index_name);
  if (config.account_id !== client.account || !/^[a-f0-9-]{36}$/i.test(database)
      || database === "00000000-0000-0000-0000-000000000000") throw new Error("Run infra setup for this account first");
  const query = async (sql, params = []) => {
    const result = await client.call(`/d1/database/${database}/query`, {
      method: "POST", body: JSON.stringify({ sql, params }),
    });
    if (!Array.isArray(result) || result.some(item => item.success === false)) throw new Error("D1 query failed");
    return result[0]?.results ?? [];
  };
  const fingerprint = hash(JSON.stringify(corpus.chunks));
  const active = await query(`SELECT g.id, g.recipe, g.corpus_hash FROM generations g
    JOIN active_generation a ON a.generation_id = g.id WHERE a.singleton = 1`);
  if (active[0]?.corpus_hash === fingerprint && active[0]?.recipe === corpus.recipe) {
    return { generation: active[0].id, chunks: corpus.chunks.length, unchanged: true };
  }
  const info = await client.call(`/vectorize/v2/indexes/${vectorIndex}/info`);
  if (info.dimensions !== DIMENSIONS || !Number.isInteger(info.vectorCount)) throw new Error("Incompatible Vectorize index info");
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
    const parameters = [];
    for (const chunk of batch) {
      const embedding = vectorFrom(await client.call(`/ai/run/${EMBEDDING_MODEL}`, {
        method: "POST", body: JSON.stringify({ text: [chunk.text] }),
      }));
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
    const mutation = await client.call(`/vectorize/v2/indexes/${vectorIndex}/upsert`, { method: "POST", body: form });
    if (typeof mutation?.mutationId !== "string") throw new Error("Vectorize did not acknowledge the upsert");
    lastMutation = mutation.mutationId;
  }
  const pause = options.pause ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let indexed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await client.call(`/vectorize/v2/indexes/${vectorIndex}/info`);
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
    else throw new Error("Usage: npm run corpus:index -- [--corpus DIRECTORY] [--apply]");
  }
  if (apply && exportOnly) throw new Error("--export-only cannot be combined with --apply");
  const exported = spawnSync(process.env.RAG_PYTHON ?? "python3", [
    "-m", "scripts.export_corpus", "--corpus", corpusPath, "--embedding-model", EMBEDDING_MODEL,
  ], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, PYTHONPATH: `${ROOT}src`, PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1" },
  });
  if (exported.error) throw exported.error;
  if (exported.status !== 0) throw new Error("Corpus export failed; verify the Python environment and corpus with npm run corpus:export");
  const corpus = validateCorpus(JSON.parse(exported.stdout));
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
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
