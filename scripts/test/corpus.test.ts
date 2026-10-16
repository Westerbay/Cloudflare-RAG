import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCorpus, extractBlocks } from "../corpus/export.ts";
import { publishCorpus } from "../index-cloudflare.ts";
import type { CloudflareClient } from "../cloudflare-api.ts";
import { SQLiteDatabase } from "../../apps/api/test/sqlite.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "small-rag-corpus-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("CommonMark extraction preserves inline text, code, heading ancestry and source lines", () => {
  assert.deepEqual(extractBlocks("# Guide\n\nFirst **important** fact.\n\n## Details\n\nSecond [linked](https://example.com) fact.\n\n```ts\nconst pi = 5;\n```\n"), [
    { text: "Guide", line_start: 1, line_end: 1, heading: "Guide" },
    { text: "First important fact.", line_start: 3, line_end: 3, heading: "Guide" },
    { text: "Details", line_start: 5, line_end: 5, heading: "Guide > Details" },
    { text: "Second linked fact.", line_start: 7, line_end: 7, heading: "Guide > Details" },
    { text: "const pi = 5;", line_start: 9, line_end: 11, heading: "Guide > Details" },
  ]);
});

test("export is stable, source-linked, ordered and changes identity after a source edit", async () => {
  const { root, cleanup } = await fixture();
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "guide.MD"), "\ufeff# Guide\r\n\r\nA **fact**.\r\n");
    await writeFile(join(root, "ignored.txt"), "Not indexed");
    const first = await exportCorpus(root);
    assert.deepEqual(first, await exportCorpus(root));
    assert.equal(first.chunks[0].document_path, "nested/guide.MD");
    assert.equal(first.chunks[0].text, "Guide\n\nA fact.");
    assert.deepEqual([first.chunks[0].line_start, first.chunks[0].line_end], [1, 3]);
    assert.match(first.chunks[0].chunk_id, /^[a-f0-9]{64}$/);
    assert.match(first.recipe, /markdown-it-15.0.2-commonmark\/utf16-v1/);
    await writeFile(join(root, "nested", "guide.MD"), "# Guide\n\nA changed fact.\n");
    assert.notEqual((await exportCorpus(root)).chunks[0].chunk_id, first.chunks[0].chunk_id);
  } finally { await cleanup(); }
});

test("export rejects symlink files and directories without following targets", async () => {
  const { root, cleanup } = await fixture();
  try {
    const corpus = join(root, "corpus"); await mkdir(corpus);
    const outside = join(root, "private.md"); await writeFile(outside, "private");
    await symlink(outside, join(corpus, "escape.md"));
    await assert.rejects(exportCorpus(corpus), /Symlinks/);
    await rm(join(corpus, "escape.md"));
    await symlink(root, join(corpus, "cycle"));
    await assert.rejects(exportCorpus(corpus), /Symlinks/);
  } finally { await cleanup(); }
});

test("empty, invalid UTF-8, oversized sources and corpus limits fail before any provider access", async () => {
  const { root, cleanup } = await fixture();
  try {
    await assert.rejects(exportCorpus(root), /no indexable/);
    const path = join(root, "input.md");
    await writeFile(path, Buffer.from([255]));
    await assert.rejects(exportCorpus(root), /UTF-8/);
    await writeFile(path, "x".repeat(2_000_001));
    await assert.rejects(exportCorpus(root), /2000000 bytes/);
    await writeFile(path, Array.from({ length: 1001 }, (_, i) => `# Section ${i}\n\nA fact.\n`).join("\n"));
    await assert.rejects(exportCorpus(root), /1000 chunks/);
    await writeFile(path, "A fact.");
    for (let i = 0; i < 100; i++) await writeFile(join(root, `${i}.md`), "A fact.");
    await assert.rejects(exportCorpus(root), /100 documents/);
  } finally { await cleanup(); }
});

test("native export crosses staging and repeated ingestion without Python or live services", async () => {
  const { root, cleanup } = await fixture();
  const db = new SQLiteDatabase();
  let embeddings = 0;
  const client: CloudflareClient = { account: "a".repeat(32), async call(path, options = {}) {
    if (path.endsWith("/query")) {
      assert.equal(typeof options.body, "string");
      const { sql, params } = JSON.parse(String(options.body));
      const statement = db.sqlite.prepare(sql);
      const results = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return [{ success: true, results }];
    }
    if (path.includes("/ai/run/")) { embeddings++; return { data: [[1, ...Array(1023).fill(0)]] }; }
    if (path.endsWith("/upsert")) return { mutationId: "native-test" };
    if (path.endsWith("/info")) return { dimensions: 1024, vectorCount: 0, processedUpToMutation: "native-test" };
    throw new Error("Unexpected API path");
  } };
  const config = { account_id: client.account, d1_databases: [{ database_id: "11111111-1111-4111-8111-111111111111" }],
    vectorize: [{ index_name: "test" }] };
  try {
    await writeFile(join(root, "pi.md"), "# Pi\n\nThe Pi has 8 GB.\n");
    const corpus = await exportCorpus(root);
    const result = await publishCorpus(client, config, corpus);
    assert.equal(result.unchanged, false);
    const stored = db.sqlite.prepare("SELECT content,line_start,line_end FROM chunks").get();
    assert.deepEqual({ ...stored }, { content: "Pi\n\nThe Pi has 8 GB.", line_start: 1, line_end: 3 });
    assert.equal((await publishCorpus(client, config, await exportCorpus(root))).unchanged, true);
    assert.equal(embeddings, 1);
  } finally { db.sqlite.close(); await cleanup(); }
});
