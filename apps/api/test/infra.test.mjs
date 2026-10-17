import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { provision } from "../../../infra/setup.ts";
import { cloudflareClient } from "../../../scripts/cloudflare-api.ts";

const template = JSON.parse(await readFile(new URL("../../../infra/wrangler.jsonc", import.meta.url), "utf8"));
test("infrastructure setup reuses existing resources and refuses incompatible vector indexes", async () => {
  const calls = [];
  const client = {
    account: "a".repeat(32),
    async call(path, options = {}) {
      calls.push({ path, ...options });
      if (path.startsWith("/d1/database?")) return [{ name: "small-rag", uuid: "11111111-1111-4111-8111-111111111111" }];
      return { config: { dimensions: 1024, metric: "cosine" } };
    },
  };
  const config = await provision(client, template);
  assert.equal(config.d1_databases[0].database_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(calls.every(call => !call.method));
  client.call = async path => path.startsWith("/d1/database?")
    ? [{ name: "small-rag", uuid: "11111111-1111-4111-8111-111111111111" }]
    : { config: { dimensions: 384, metric: "cosine" } };
  await assert.rejects(provision(client, template), /incompatible/);
});

test("infrastructure creation is repeatable without recreating or deleting resources", async () => {
  let database = null, index = null;
  const writes = [];
  const client = {
    account: "a".repeat(32),
    async call(path, options = {}) {
      if (options.method === "POST") {
        writes.push(path);
        if (path === "/d1/database") return database = {
          name: "small-rag", uuid: "11111111-1111-4111-8111-111111111111",
        };
        assert.equal(path, "/vectorize/v2/indexes");
        return index = JSON.parse(options.body);
      }
      if (path.startsWith("/d1/database?")) return database ? [database] : [];
      return index;
    },
  };
  const first = await provision(client, template);
  const second = await provision(client, template);
  assert.deepEqual(first, second);
  assert.deepEqual(writes, ["/d1/database", "/vectorize/v2/indexes"]);
});

test("provider error bodies and credentials do not escape the operator client", async () => {
  const token = "test-token-that-is-not-a-real-credential";
  const client = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: token }, async (_url, options) => {
    assert.equal(options.redirect, "error");
    return Response.json({ success: false, errors: [{ message: `private payload ${token}` }] }, { status: 403 });
  });
  await assert.rejects(client.call("/d1/database"), error => {
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes("private payload"), false);
    return true;
  });
});

test("operator failures identify the service and safe provider codes without leaking payloads", async () => {
  const token = "test-token-that-is-not-a-real-credential";
  let calls = 0;
  const client = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: token }, async () => {
    calls++;
    return Response.json({ success: false, errors: [{ code: 7500,
      message: `no such table: active_generation; private document ${token}` }] }, { status: 400 });
  });
  await assert.rejects(client.call("/d1/database/private-database-id/query"), error => {
    assert.match(error.message, /D1 query/);
    assert.match(error.message, /7500/);
    assert.match(error.message, /pnpm db:migrate:remote/);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes("private document"), false);
    assert.equal(error.message.includes("private-database-id"), false);
    assert.equal(error.status, 400);
    return true;
  });
  assert.equal(calls, 1);
});

test("AI and Vectorize failures retain safe operation context without returning arbitrary messages", async () => {
  for (const [path, operation] of [["/ai/run/private-model", "Workers AI inference"],
    ["/vectorize/v2/indexes/private-index/upsert", "Vectorize upsert"]]) {
    const client = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "fake-token" }, async () =>
      Response.json({ success: false, errors: [{ code: 10000, message: "private source text" }] }, { status: 400 }));
    await assert.rejects(client.call(path), error => {
      assert.ok(error.message.includes(operation));
      assert.ok(error.message.includes("10000"));
      assert.equal(error.message.includes("private source text"), false);
      assert.equal(error.message.includes("private-index"), false);
      assert.equal(error.message.includes("private-model"), false);
      assert.equal(error.message.includes("db:migrate"), false);
      return true;
    });
  }
});


test("transport failures report safe operation and network codes without retrying or leaking causes", async () => {
  for (const [cause, expected] of [
    [Object.assign(new Error("private-host fake-token"), { code: "ENOTFOUND" }), "ENOTFOUND"],
    [new AggregateError([Object.assign(new Error("private address"), { code: "ETIMEDOUT" })]), "ETIMEDOUT"],
    [new DOMException("private URL", "TimeoutError"), "TimeoutError"],
    [Object.assign(new Error("secret"), { code: "fake-token" }), "network error"],
  ]) {
    let calls = 0;
    const failure = new TypeError("fetch failed private source text", { cause });
    const client = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "fake-token" }, async () => {
      calls++;
      throw failure;
    });
    await assert.rejects(client.call("/ai/run/private-model"), error => {
      assert.ok(error.message.includes("Workers AI inference"));
      assert.ok(error.message.includes(expected));
      assert.ok(error.message.includes("no automatic retry"));
      assert.doesNotMatch(error.message, /fake-token|private|HTTP \d/);
      assert.equal(error.cause, failure);
      return true;
    });
    assert.equal(calls, 1);
  }
});


test("a response body disconnect is reported as a transport failure rather than invalid JSON", async () => {
  const client = cloudflareClient({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "fake-token" }, async () =>
    new Response(new ReadableStream({ start(controller) {
      controller.error(new TypeError("terminated", {
        cause: Object.assign(new Error("private peer"), { code: "UND_ERR_SOCKET" }),
      }));
    } })));
  await assert.rejects(client.call("/vectorize/v2/indexes/private-index/upsert"), error => {
    assert.match(error.message, /Vectorize upsert.*UND_ERR_SOCKET/);
    assert.doesNotMatch(error.message, /invalid JSON|private|fake-token/);
    return true;
  });
});
