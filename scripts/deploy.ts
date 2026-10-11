// Creates the database (first time), applies migrations, deploys the Worker,
// uploads secrets, and points the Telnyx webhook at it.
//
//   npm run deploy             deploy, keep DRY_RUN as it is in wrangler.toml
//   npm run deploy -- --dry    deploy with DRY_RUN on
//   npm run deploy -- --live   deploy with DRY_RUN off (real texts!)
//
// Reads secrets from the environment only: TELNYX_API_KEY, TELNYX_PUBLIC_KEY,
// and CLOUDFLARE_API_TOKEN (or a prior `wrangler login`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { die, loadAnswers, loadState, ROOT, saveState, setTomlValue, tomlVar, wrangler } from "./lib";
import { parseAdminNumbers } from "../src/phone";

const DB_NAME = "text-blast-db";
const args = process.argv.slice(2);

async function main() {
  const answers = loadAnswers();
  const state = loadState();

  console.log("1/6 Checking Cloudflare login…");
  const who = wrangler(["whoami"], { allowFail: true, quiet: true });
  if (!who.ok || /not authenticated|You are not logged in/i.test(who.out)) {
    die("Not logged in to Cloudflare. Set CLOUDFLARE_API_TOKEN in this environment (or run `npx wrangler login` on your own computer).");
  }

  console.log("2/6 Writing settings into wrangler.toml…");
  if (answers.groupName) setTomlValue("GROUP_NAME", answers.groupName);
  if (answers.adminName) setTomlValue("ADMIN_NAME", answers.adminName);
  if (args.includes("--live")) setTomlValue("DRY_RUN", "false");
  if (args.includes("--dry")) setTomlValue("DRY_RUN", "true");
  if (tomlVar("GROUP_NAME")?.startsWith("REPLACE") || tomlVar("ADMIN_NAME")?.startsWith("REPLACE")) {
    die("Group name / admin name not set yet (setup/answers.json).");
  }

  console.log("3/6 Database…");
  const tomlPath = join(ROOT, "wrangler.toml");
  if (readFileSync(tomlPath, "utf8").includes("REPLACE_WITH_ID")) {
    let id: string | undefined;
    const created = wrangler(["d1", "create", DB_NAME], { allowFail: true, quiet: true });
    id = created.out.match(/database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/)?.[1];
    if (!id) {
      const list = wrangler(["d1", "list", "--json"], { quiet: true });
      const parsed = JSON.parse(list.stdout.slice(list.stdout.indexOf("[")));
      id = parsed.find((d: any) => d.name === DB_NAME)?.uuid;
    }
    if (!id) die(`Couldn't create or find the ${DB_NAME} database.\n${created.out}`);
    setTomlValue("database_id", id);
    console.log(`   Database ready (${id}).`);
  }
  wrangler(["d1", "migrations", "apply", DB_NAME, "--remote"]);

  console.log("4/6 Deploying the Worker…");
  let dep = wrangler(["deploy"], { allowFail: true });
  if (!dep.ok && /subdomain/i.test(dep.out)) {
    // Brand-new Cloudflare accounts have no workers.dev subdomain yet. Register one by API.
    await registerWorkersSubdomain();
    dep = wrangler(["deploy"], { allowFail: true });
  }
  if (!dep.ok) die(`Deploy failed:\n${dep.out}`);
  const url = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (url) saveState({ workerUrl: url });

  console.log("5/6 Uploading secrets…");
  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  const put = (k: string, v: string | undefined) => (v ? (secrets[k] = v) : missing.push(k));
  put("TELNYX_API_KEY", process.env.TELNYX_API_KEY);
  put("TELNYX_PUBLIC_KEY", process.env.TELNYX_PUBLIC_KEY ?? answers.telnyxPublicKey);
  put("TELNYX_NUMBER", state.phoneNumber);
  const admins = parseAdminNumbers((answers.adminNumbers ?? []).join(","));
  put("ADMIN_NUMBERS", admins.length ? admins.join(",") : undefined);
  if (Object.keys(secrets).length) wrangler(["secret", "bulk"], { input: JSON.stringify(secrets), quiet: true });
  console.log(`   Set: ${Object.keys(secrets).join(", ") || "none"}${missing.length ? `. Still missing: ${missing.join(", ")}` : ""}`);

  console.log("6/6 Connecting Telnyx…");
  const webhookUrl = (url ?? loadState().workerUrl) + "/telnyx";
  saveState({ webhookUrl });
  if (process.env.TELNYX_API_KEY && loadState().messagingProfileId) {
    spawnSync("npx", ["tsx", "scripts/telnyx.ts", "webhook", webhookUrl], { cwd: ROOT, stdio: "inherit" });
  } else {
    console.log("   Telnyx messaging profile not created yet; the webhook will be set when it is.");
  }

  if (url) {
    try {
      const r = await fetch(url);
      console.log(`   Health check: ${r.status} ${(await r.text()).trim()}`);
    } catch (e) {
      console.log(`   Health check failed (may just need a minute): ${(e as Error).message}`);
    }
  }
  console.log(`\nDone. DRY_RUN is ${tomlVar("DRY_RUN")}. Webhook URL: ${webhookUrl}`);
}

async function registerWorkersSubdomain(): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) die("This Cloudflare account needs a workers.dev subdomain, and CLOUDFLARE_API_TOKEN isn't set to create one.");
  const cf = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await r.json()) as any;
  };
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? (await cf("GET", "/accounts")).result?.[0]?.id;
  if (!accountId) die("Couldn't find the Cloudflare account id.");
  for (let i = 0; i < 5; i++) {
    const name = `textblast-${Math.random().toString(36).slice(2, 7)}`;
    const r = await cf("PUT", `/accounts/${accountId}/workers/subdomain`, { subdomain: name });
    if (r.success) {
      console.log(`   Registered ${name}.workers.dev`);
      return;
    }
    console.log(`   ${name} not available: ${JSON.stringify(r.errors)}`);
  }
  die("Couldn't register a workers.dev subdomain.");
}

main().catch((e) => die(String(e?.stack ?? e)));
