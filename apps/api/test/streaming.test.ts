import assert from "node:assert/strict";
import test from "node:test";
import { createParser } from "eventsource-parser";
import { handleRequest } from "../src/app.ts";
import { CHAT_MODEL, EMBEDDING_MODEL } from "@small-rag/contracts/config";
import type { Env } from "../src/bindings.ts";
import { SQLiteDatabase } from "./sqlite.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const ORIGIN = "https://portfolio.example";
const encoder = new TextEncoder();
const answer = { status: "answered", answer: "Il utilise D1 et Workers.", citations: ["s1"] };
const expected = { ...answer, citations: [{ chunk_id: "source1", path: "storage.md", line_start: 1, line_end: 3 }] };

function event(fragment: string) { return `data: ${JSON.stringify({ response: fragment })}\n\n`; }
function frames(text = JSON.stringify(answer)) { return event(text) + "data: [DONE]\n\n"; }
function bytesStream(text: string, byteByByte = false) {
  const bytes = encoder.encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (byteByByte) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } });
}

function fixture(makeStream: () => unknown = () => bytesStream(frames())) {
  const db = new SQLiteDatabase();
  db.sqlite.exec(`INSERT INTO generations(id,embedding_model,recipe,chunk_count) VALUES('g','${EMBEDDING_MODEL}','test',1);
    INSERT INTO active_generation VALUES(1,'g');
    INSERT INTO chunks VALUES('v','g','source1','storage.md',NULL,1,3,'Workers runs the API and D1 stores evidence.');`);
  const calls: { model: string; input: Record<string, unknown> }[] = [];
  const env: Env = {
    DB: db, PUBLIC_CHAT_ENABLED: "true", PUBLIC_CHAT_ORIGINS: ORIGIN,
    AI: { async run(model, input) {
      calls.push({ model, input });
      if (model === EMBEDDING_MODEL) return { data: [[1, ...Array(1023).fill(0)]] };
      if (input.stream === true) return makeStream();
      return { response: JSON.stringify({ question: "How does the assistant work?" }) };
    } },
    VECTORS: { async query() { return { matches: [{ id: "v", score: 0.9 }] }; }, async describe() { return { dimensions: 1024 }; } },
  };
  return { db, env, calls };
}

function request(history: { role: "assistant"; content: string }[] = [], signal?: AbortSignal) {
  return new Request("https://example.test/v1/chat", { method: "POST", signal,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Accept: "text/event-stream" },
    body: JSON.stringify({ message: "Comment fonctionne cet assistant ?", history }),
  });
}

async function readEvents(response: Response) {
  const events: { event: string | undefined; data: Record<string, unknown> }[] = [];
  const parser = createParser({ onEvent: ({ event, data }) => events.push({ event, data: JSON.parse(data) }) });
  parser.feed(await response.text());
  return events;
}

test("SSE sends answer text before inference completes, then validates citations without additional AI calls", async () => {
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const { db, env, calls } = fixture(() => new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } }));
  try {
    const response = await handleRequest(request([{ role: "assistant", content: "I am the portfolio assistant." }]), env, "Return compact JSON.", NOW);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal(response.headers.get("Cache-Control"), "no-store, no-transform");
    assert.deepEqual(calls.map(call => call.model), [CHAT_MODEL, EMBEDDING_MODEL, CHAT_MODEL]);
    assert.equal(calls[2].input.stream, true);
    assert.equal("response_format" in calls[2].input, false);
    assert.equal(calls[2].input.max_tokens, 200);
    assert.ok(response.body && upstream);
    const reader = response.body.getReader();
    upstream.enqueue(encoder.encode(event('{"status":"answered","answer":"Il utilise D1')));
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: delta/);
    assert.match(new TextDecoder().decode(first.value), /Il utilise D1/);
    upstream.enqueue(encoder.encode(event(' et Workers.","citations":["s1"]}') + "data: [DONE]\n\n"));
    upstream.close();
    let rest = "";
    while (true) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
    assert.match(rest, /event: result/);
    const terminal = rest.split("event: result\ndata: ")[1]?.trim();
    assert.ok(terminal);
    assert.deepEqual(JSON.parse(terminal), expected);
    assert.equal(calls.length, 3);
  } finally { db.sqlite.close(); }
});

test("SSE and incremental JSON preserve UTF-8, escapes, newlines and split surrogate pairs without leaking JSON", async () => {
  const text = 'Il dit "bonjour".\nCafé / C:\\tmp 🦊';
  const raw = JSON.stringify({ ...answer, answer: text }).replace("🦊", "\\ud83e\\udd8a");
  const wire = [...raw].map(character => event(character)).join("") + "data: [DONE]\n\n";
  const { db, env, calls } = fixture(() => bytesStream(wire, true));
  try {
    const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
    assert.equal(events.filter(item => item.event === "delta").map(item => item.data.delta).join(""), text);
    assert.deepEqual(events.at(-1), { event: "result", data: { ...expected, answer: text } });
    assert.equal(events.filter(item => item.event !== "delta").length, 1);
    assert.equal(calls.length, 2);
  } finally { db.sqlite.close(); }
});

test("native Workers AI compatibility frames do not duplicate text and usage-only frames precede completion", async () => {
  // Shape verified against the configured model's live Workers AI stream.
  const raw = JSON.stringify(answer);
  const wire = `data: ${JSON.stringify({ response: raw, choices: [{ delta: { content: raw }, finish_reason: "stop" }] })}\n\n`
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}\n\n'
    + 'data: {"choices":[],"usage":{"completion_tokens":0}}\n\n'
    + 'data: {"response":"","usage":{"completion_tokens":23}}\n\ndata: [DONE]\n\n';
  const { db, env } = fixture(() => bytesStream(wire));
  try {
    const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
    assert.equal(events.filter(item => item.event === "delta").map(item => item.data.delta).join(""), answer.answer);
    assert.deepEqual(events.at(-1), { event: "result", data: expected });
  } finally { db.sqlite.close(); }
});

test("OpenAI-compatible text survives Cloudflare coercing numeric and boolean response fragments", async () => {
  const wire = event('{"status":"answered","answer":"Llama ')
    + 'data: {"response":3.3,"choices":[{"delta":{"content":"3.3"},"finish_reason":null}]}\n\n'
    + event(" accepts ")
    + 'data: {"response":true,"choices":[{"delta":{"content":"true"},"finish_reason":null}]}\n\n'
    + event(' as text.","citations":["s1"]}') + "data: [DONE]\n\n";
  const { db, env } = fixture(() => bytesStream(wire));
  try {
    const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
    const text = "Llama 3.3 accepts true as text.";
    assert.equal(events.filter(item => item.event === "delta").map(item => item.data.delta).join(""), text);
    assert.deepEqual(events.at(-1), { event: "result", data: { ...expected, answer: text } });
  } finally { db.sqlite.close(); }
});

test("malformed, truncated, uncited and unsupported answers end in a redacted failure without a result or retry", async () => {
  const invalid = [
    frames(JSON.stringify({ ...answer, citations: ["other"] })),
    frames(JSON.stringify({ ...answer, citations: [] })),
    frames(JSON.stringify({ ...answer, status: "out_of_scope" })),
    frames(JSON.stringify({ ...answer, status: "other" })),
    frames('{"status":"answered","answer":"partial'),
    frames('{"status":"answered","answer":"one","answer":"two","citations":["s1"]}'),
    event(JSON.stringify(answer)), // EOF alone is not a terminal provider marker.
    `data: ${JSON.stringify({ response: JSON.stringify(answer), finish_reason: "length" })}\n\ndata: [DONE]\n\n`,
    `data: ${JSON.stringify({ response: JSON.stringify(answer), choices: [{ finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`,
    frames("```json\n" + JSON.stringify(answer) + "\n```"),
    "data: {not valid json}\n\n",
    event('{"answer":"' + "a".repeat(17_000)),
    ": " + "a".repeat(128 * 1024),
    event("").repeat(2049),
  ];
  for (const wire of invalid) {
    const { db, env, calls } = fixture(() => bytesStream(wire));
    try {
      const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
      assert.deepEqual(events.at(-1), { event: "error", data: { code: "response" } });
      assert.equal(events.some(item => item.event === "result"), false);
      assert.equal(events.filter(item => item.event !== "delta").length, 1);
      assert.equal(calls.length, 2);
    } finally { db.sqlite.close(); }
  }
});

test("empty evidence still requires an insufficient-context refusal on the streaming path", async () => {
  for (const reply of [answer, { status: "insufficient_context", answer: "Information absente.", citations: [] }]) {
    const { db, env } = fixture(() => bytesStream(frames(JSON.stringify(reply))));
    env.VECTORS.query = async () => ({ matches: [] });
    try {
      const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
      assert.equal(events.at(-1)?.event, reply.status === "answered" ? "error" : "result");
    } finally { db.sqlite.close(); }
  }
});

test("provider errors after headers sleep with redacted metadata and block later calls", async () => {
  const failures = [
    () => bytesStream('event: error\ndata: {"error":{"code":3036,"message":"sensitive daily quota"}}\n\n'),
    () => new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("sensitive transport failure")); } }),
  ];
  for (const [index, failure] of failures.entries()) {
    const { db, env, calls } = fixture(failure);
    try {
      const events = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
      assert.equal(events.at(-1)?.event, "sleeping");
      assert.equal(events.at(-1)?.data.service, "workers_ai");
      assert.equal(events.at(-1)?.data.reason, index === 0 ? "quota_exhausted" : "service_unavailable");
      assert.equal(events.at(-1)?.data.retry_at, index === 0 ? "2026-10-16T00:00:00.000Z" : "2026-10-15T12:01:00.000Z");
      assert.equal(JSON.stringify(events).includes("sensitive"), false);
      const again = await handleRequest(request(), env, "Return JSON", NOW);
      assert.equal(again.status, 503);
      assert.equal((await again.json()).status, "sleeping");
      assert.equal(calls.length, 2);
    } finally { db.sqlite.close(); }
  }
});

test("cancelling the client or aborting its request cancels inference without putting other visitors to sleep", async () => {
  for (const abortRequest of [false, true]) {
    let cancelled = false;
    let first = true;
    const { db, env, calls } = fixture(() => {
      if (!first) return bytesStream(frames());
      first = false;
      return new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    });
    const abort = new AbortController();
    try {
      const response = await handleRequest(request([], abort.signal), env, "Return JSON", NOW);
      assert.ok(response.body);
      if (abortRequest) { abort.abort(); await response.text(); }
      else await response.body.cancel();
      assert.equal(cancelled, true);
      const next = await readEvents(await handleRequest(request(), env, "Return JSON", NOW));
      assert.equal(next.at(-1)?.event, "result");
      assert.equal(calls.length, 4);
    } finally { db.sqlite.close(); }
  }
});

test("pre-stream input/auth/origin/provider failures retain HTTP JSON semantics", async () => {
  const { db, env, calls } = fixture(() => { throw new Error("AI_ERROR 3036 private provider error"); });
  try {
    const disallowed = request(); disallowed.headers.set("Origin", "https://unknown.example");
    assert.equal((await handleRequest(disallowed, env, "", NOW)).status, 403);
    const invalid = request(); invalid.headers.set("Content-Type", "text/plain");
    assert.equal((await handleRequest(invalid, env, "", NOW)).status, 415);
    const privateEnv = { ...env, PUBLIC_CHAT_ENABLED: undefined, BASIC_AUTH_PASSWORD: "test-auth-long-password" };
    assert.equal((await handleRequest(request(), privateEnv, "", NOW)).status, 401);
    assert.equal(calls.length, 0);
    const response = await handleRequest(request(), env, "", NOW);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.equal((await response.json()).reason, "quota_exhausted");
    assert.equal(calls.length, 2);
  } finally { db.sqlite.close(); }
});
