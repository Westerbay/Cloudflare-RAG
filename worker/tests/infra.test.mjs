import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { provision } from "../../infra/setup.mjs";
import { cloudflareClient } from "../../scripts/cloudflare-api.mjs";

const template = JSON.parse(await readFile(new URL("../../infra/wrangler.jsonc", import.meta.url), "utf8"));
test("infrastructure setup reuses existing resources and refuses incompatible vector indexes", async () => {
  const calls = [];
  const client = {
    account: "a".repeat(32),
    async call(path, options = {}) {
      calls.push({ path, ...options });
      if (path.startsWith("/d1/database?")) return [{ name: "small-rag", uuid: "11111111-1111-1111-1111-111111111111" }];
      return { config: { dimensions: 1024, metric: "cosine" } };
    },
  };
  const config = await provision(client, template);
  assert.equal(config.d1_databases[0].database_id, "11111111-1111-1111-1111-111111111111");
  assert.ok(calls.every(call => !call.method));
  client.call = async path => path.startsWith("/d1/database?")
    ? [{ name: "small-rag", uuid: "11111111-1111-1111-1111-111111111111" }]
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
          name: "small-rag", uuid: "11111111-1111-1111-1111-111111111111",
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
