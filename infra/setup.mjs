import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { cloudflareClient } from "../scripts/cloudflare-api.mjs";
import { DIMENSIONS } from "../worker/config.ts";

export async function provision(client, template) {
  const desired = template.d1_databases[0];
  let database;
  for (let page = 1; page <= 100; page++) {
    const entries = await client.call(`/d1/database?per_page=100&page=${page}`);
    if (!Array.isArray(entries)) throw new Error("Invalid D1 database listing");
    const found = entries.filter(item => item.name === desired.database_name);
    if (found.length > 1) throw new Error("More than one D1 database matches the configured name");
    if (found.length) { database = found[0]; break; }
    if (entries.length < 100) break;
    if (page === 100) throw new Error("D1 listing exceeded the safe pagination limit");
  }
  if (!database) database = await client.call("/d1/database", {
    method: "POST", body: JSON.stringify({ name: desired.database_name }),
  });
  if (typeof database.uuid !== "string" || !/^[a-f0-9-]{36}$/i.test(database.uuid)) {
    throw new Error("Cloudflare did not return a valid D1 database ID");
  }
  const vectorName = template.vectorize[0].index_name;
  const path = `/vectorize/v2/indexes/${encodeURIComponent(vectorName)}`;
  const index = await client.call(path, { allowNotFound: true });
  if (index) {
    if (index.config?.dimensions !== DIMENSIONS || index.config?.metric !== "cosine") {
      throw new Error("Existing Vectorize index has incompatible dimensions or metric; it was not replaced");
    }
  } else {
    await client.call("/vectorize/v2/indexes", {
      method: "POST", body: JSON.stringify({ name: vectorName, config: { dimensions: DIMENSIONS, metric: "cosine" } }),
    });
  }
  return { ...template, account_id: client.account,
    d1_databases: [{ ...desired, database_id: database.uuid }] };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply")) throw new Error("Usage: npm run infra:setup -- [--apply]");
  const template = JSON.parse(await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
  if (!args.includes("--apply")) {
    console.log(`Plan: reuse or create D1 'small-rag' and Vectorize 'small-rag' (${DIMENSIONS} dimensions, cosine).`);
    console.log("Write non-secret IDs to ignored infra/wrangler.local.json. No subscriptions, secrets, migrations or deployments are changed.");
    console.log("Use --apply to execute against CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN.");
    return;
  }
  const config = await provision(cloudflareClient(), template);
  await writeFile(new URL("./wrangler.local.json", import.meta.url), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log("Infrastructure bindings saved to infra/wrangler.local.json. Billing plan was not changed.");
  console.log("Next: npm run db:migrate:remote; npm run corpus:index -- --apply; npm run deploy.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
