import assert from "node:assert/strict";
import test from "node:test";
import { chunkBlocks } from "../src/chunking.ts";

test("windows keep section boundaries, source lines and deterministic overlap", () => {
  const blocks = [
    { text: "First section.", heading: "Guide", line_start: 1, line_end: 3 },
    { text: "Second section has a longer passage.", heading: "Guide > Details", line_start: 5, line_end: 7 },
  ];
  const windows = chunkBlocks(blocks, 20, 5);
  assert.deepEqual(windows.map(chunk => [chunk.ordinal, chunk.heading, chunk.line_start, chunk.line_end]),
    [[0, "Guide", 1, 3], [1, "Guide > Details", 5, 7], [2, "Guide > Details", 5, 7], [3, "Guide > Details", 5, 7]]);
  assert.equal(windows[1].text.slice(-5), windows[2].text.slice(0, 5));
  assert.deepEqual(chunkBlocks(blocks, 20, 5), windows);
});

test("unicode windows remain bounded without splitting surrogate pairs or looping", () => {
  const chunks = chunkBlocks([{ text: "😀".repeat(20), heading: null, line_start: 1, line_end: 1 }], 5, 4);
  assert.ok(chunks.length > 1 && chunks.length < 40);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 5);
    assert.equal(chunk.text, new TextDecoder().decode(new TextEncoder().encode(chunk.text)));
  }
  assert.deepEqual(chunkBlocks([], 20, 2), []);
  assert.throws(() => chunkBlocks([], 20, 20));
});
