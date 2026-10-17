import assert from "node:assert/strict";
import test from "node:test";
import { publishCorpus, validateCorpus } from "../../../scripts/index-cloudflare.ts";
import { EMBEDDING_MODEL } from "@small-rag/contracts/config";
import { SQLiteDatabase } from "./sqlite.ts";

const corpus = {
  recipe: JSON.stringify({ embedding_model: EMBEDDING_MODEL, corpus: "test", size_chars: 1200, overlap_chars: 120 }),
  chunks: [{ chunk_id: "a".repeat(64), document_path: "guide.md", heading: null,
    line_start: 1, line_end: 3, text: "Cloudflare runs the model." }],
};
const config = { account_id: "a".repeat(32),
  d1_databases: [{ database_id: "11111111-1111-4111-8111-111111111111" }], vectorize: [{ index_name: "small-rag" }] };

function fixture() {
  const db = new SQLiteDatabase();
  db.sqlite.prepare("INSERT INTO generations(id,embedding_model,recipe,chunk_count) VALUES(?,?,?,?)")
    .run("previous", EMBEDDING_MODEL, "old", 1);
  db.sqlite.exec("INSERT INTO active_generation VALUES(1,'previous')");
  const state = { processed: true, embeddings: 0, fail: false, vectorCount: 1, vectors: [] };
  const client = {
    account: config.account_id,
    async call(path, options = {}) {
      if (path.endsWith("/query")) {
        const body = JSON.parse(options.body), statement = db.sqlite.prepare(body.sql);
        const results = statement.columns().length ? statement.all(...body.params) : (statement.run(...body.params), []);
        return [{ success: true, results }];
      }
      if (path.includes("/ai/run/")) {
        state.embeddings++;
        if (state.fail) throw new Error("Simulated provider failure");
        return { data: [[1, ...Array(1023).fill(0)]] };
      }
      if (path.endsWith("/upsert")) {
        const request = new Request("https://api.cloudflare.com" + path, options);
        assert.match(request.headers.get("Content-Type"), /^multipart\/form-data; boundary=/);
        const form = await request.formData();
        const body = form.get("vectors");
        assert.ok(body instanceof File, "Vectorize expects the NDJSON file in the vectors field");
        assert.equal(body.type, "application/x-ndjson");
        state.vectors = (await body.text()).trim().split("\n").map(line => JSON.parse(line));
        return { mutationId: "latest" };
      }
      if (path.endsWith("/info")) return { dimensions: 1024, vectorCount: state.vectorCount,
        processedUpToMutation: state.processed ? "latest" : "not-processed" };
      throw new Error("Unexpected test API path");
    },
  };
  return { db, state, client };
}

test("index activation waits for Vectorize and preserves canonical hashes behind generation-specific vector IDs", async () => {
  const { db, state, client } = fixture();
  try {
    const result = await publishCorpus(client, config, corpus, { pause: async () => {} });
    assert.equal(result.unchanged, false);
    assert.equal(db.sqlite.prepare("SELECT generation_id FROM active_generation").get().generation_id, result.generation);
    const stored = db.sqlite.prepare("SELECT * FROM chunks").get();
    assert.equal(stored.chunk_id, corpus.chunks[0].chunk_id);
    assert.equal(stored.vector_id.length, 64);
    assert.notEqual(stored.vector_id, stored.chunk_id);
    assert.equal(state.vectors[0].namespace, result.generation);
    assert.equal(state.vectors[0].id, stored.vector_id);
    const repeated = await publishCorpus(client, config, corpus);
    assert.equal(repeated.unchanged, true);
    assert.equal(state.embeddings, 1);
  } finally { db.sqlite.close(); }
});

test("a pending vector mutation or failed embedding never replaces the previous active generation", async () => {
  for (const mode of ["pending", "provider-failure"]) {
    const { db, state, client } = fixture();
    if (mode === "pending") state.processed = false;
    else state.fail = true;
    try {
      await assert.rejects(publishCorpus(client, config, corpus, { pause: async () => {} }));
      assert.equal(db.sqlite.prepare("SELECT generation_id FROM active_generation").get().generation_id, "previous");
    } finally { db.sqlite.close(); }
  }
});

test("staging cannot exceed the free vector storage allowance", async () => {
  const { db, state, client } = fixture(); state.vectorCount = 4882;
  try {
    await assert.rejects(publishCorpus(client, config, corpus), /free stored-dimensions/);
    assert.equal(state.embeddings, 0);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM generations").get().n, 1);
  } finally { db.sqlite.close(); }
});

test("unsafe source paths and duplicate chunks fail validation before any external calls", () => {
  assert.throws(() => validateCorpus({ ...corpus, chunks: [{ ...corpus.chunks[0], document_path: "../private.md" }] }));
  assert.throws(() => validateCorpus({ ...corpus, chunks: [corpus.chunks[0], corpus.chunks[0]] }));
});
