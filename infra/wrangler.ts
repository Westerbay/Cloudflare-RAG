import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = new URL("./wrangler.local.json", import.meta.url);
const config = existsSync(local) ? local : new URL("./wrangler.jsonc", import.meta.url);
const args = process.argv.slice(2);
if ((args[0] === "dev" || args.includes("--remote") || (args[0] === "deploy" && !args.includes("--dry-run"))) && !existsSync(local)) {
  throw new Error("Run pnpm infra:setup --apply before remote operations; no resources were changed");
}
const result = spawnSync(process.execPath, [
  `${root}node_modules/wrangler/bin/wrangler.js`, ...args, "--config", fileURLToPath(config),
], { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
