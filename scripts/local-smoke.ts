// End-to-end check in Cloudflare's real runtime, on this computer, with DRY_RUN on.
// Starts `wrangler dev` with a throwaway database, replays signed Telnyx webhooks
// from test/fixtures, runs the once-a-minute sender, and checks the results.
//
//   npm run smoke
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";

const PORT = 8799;
const persist = mkdtempSync(join(tmpdir(), "textblast-smoke-"));
const varsFile = join(persist, ".dev.vars");
const ADMIN = "+12125550001";
const OURS = "+12125550000";

const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "✔" : "✖"} ${what}`);
  if (!ok) failures++;
};

function d1(sqlText: string): any[] {
  const r = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "text-blast-db", "--local", "--persist-to", persist, "--json", "--command", sqlText],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf("[")))[0]?.results ?? [];
}

async function main() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  writeFileSync(
    varsFile,
    [
      "TELNYX_API_KEY=KEYsmoketest",
      `TELNYX_PUBLIC_KEY=${pub}`,
      `TELNYX_NUMBER=${OURS}`,
      `ADMIN_NUMBERS=${ADMIN}`,
      "DRY_RUN=true",
      // One batch covers all 20 test members (batches are a minute apart).
      "SEND_BATCH_SIZE=30",
      "GROUP_NAME=Smoke Test",
      "ADMIN_NAME=Tester",
    ].join("\n"),
  );

  spawnSync("npx", ["--no-install", "wrangler", "d1", "migrations", "apply", "text-blast-db", "--local", "--persist-to", persist], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, CI: "true" },
  });
  const values = Array.from({ length: 20 }, (_, i) => `('+1347555${1000 + i}','Boy ${i}','active','x','x')`).join(",");
  d1(`INSERT INTO members (phone,name,status,added_at,updated_at) VALUES ${values}`);

  // A dev server left over from an interrupted run would answer instead of ours.
  try {
    await fetch(`http://127.0.0.1:${PORT}`);
    console.error(`Port ${PORT} is already in use (a leftover \`wrangler dev\`?). Stop it and run again.`);
    process.exit(1);
  } catch {}

  const logs: string[] = [];
  const dev = spawn(
    "npx",
    ["--no-install", "wrangler", "dev", "--port", String(PORT), "--persist-to", persist, "--env-file", varsFile, "--test-scheduled", "--show-interactive-dev-session=false"],
    // Own process group, so the runtime it starts is stopped with it.
    { cwd: ROOT, env: { ...process.env, CI: "true" }, detached: true },
  );
  const stopDev = () => {
    try {
      process.kill(-dev.pid!, "SIGTERM");
    } catch {}
  };
  // Also stop it if this script is interrupted (Ctrl+C, a timeout).
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      stopDev();
      rmSync(persist, { recursive: true, force: true });
      process.exit(130);
    });
  }
  dev.stdout.on("data", (d) => logs.push(String(d)));
  dev.stderr.on("data", (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${PORT}`;
  // The local dev server occasionally drops a connection while the D1 command
  // line tool touches the same database files. Retrying is safe: webhooks are
  // deduplicated and only a refused connection (no response at all) is retried.
  const fetchRetry = async (url: string, init?: RequestInit) => {
    for (let i = 0; ; i++) {
      try {
        return await fetch(url, init);
      } catch (e) {
        if (i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(base)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    check((await (await fetch(base)).text()).includes("running"), "Worker starts");

    const post = async (body: string, key = keys.privateKey, ts = Math.floor(Date.now() / 1000)) => {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${ts}|${body}`));
      return fetchRetry(`${base}/telnyx`, {
        method: "POST",
        headers: { "telnyx-signature-ed25519": b64(sig), "telnyx-timestamp": String(ts), "content-type": "application/json" },
        body,
      });
    };
    const fixture = (n: string) => readFileSync(join(ROOT, "test", "fixtures", n), "utf8");

    const blast = fixture("admin-blast.json");
    check((await post(blast)).status === 200, "Signed admin text accepted");
    check((await post(blast)).status === 200, "Repeat delivery accepted (and ignored)");
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    check((await post(blast, other.privateKey)).status === 401, "Wrong signature rejected");
    check((await post(blast, keys.privateKey, Math.floor(Date.now() / 1000) - 600)).status === 401, "Old timestamp rejected");
    await new Promise((r) => setTimeout(r, 2000));
    check(d1("SELECT status FROM jobs")[0]?.status === "queued", "Blast saved and waiting for the minute run");

    for (let i = 0; i < 3; i++) {
      await fetchRetry(`${base}/__scheduled?cron=*+*+*+*+*`);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const jobs = d1("SELECT id, status FROM jobs");
    check(jobs.length === 1, `Exactly one blast created (got ${jobs.length})`);
    const counts = d1("SELECT status, COUNT(*) AS n FROM job_recipients GROUP BY status");
    check(JSON.stringify(counts) === JSON.stringify([{ status: "sent", n: 20 }]), `All 20 marked sent in dry run (${JSON.stringify(counts)})`);
    check(jobs[0]?.status === "done", "Blast finished");

    await post(fixture("member-stop.json"));
    await new Promise((r) => setTimeout(r, 1500));
    check(d1("SELECT status FROM members WHERE phone='+13475551000'")[0]?.status === "opted_out", "STOP from a member opts him out");
    const locks = d1("SELECT until FROM locks WHERE name = 'sender'");
    check(locks.length === 1 && locks[0].until > Date.now(), "Next batch held back about a minute (pacing lock)");

    const out = logs.join("");
    check(out.includes('"event":"dry_run_send"'), "Dry-run sends are logged");
    check(!/\+1\d{10}/.test(out.replace(/https?:\/\/\S+/g, "")), "No full phone numbers in the logs");
    check(out.includes('"event":"job_done"'), "Summary logged");
  } catch (e) {
    const err = e as Error & { cause?: unknown };
    check(false, `Unexpected error: ${err?.message} ${String(err?.cause ?? "")}\n${err?.stack?.split("\n").slice(1, 4).join("\n")}`);
  } finally {
    stopDev();
    await new Promise((r) => setTimeout(r, 1000));
    if (failures) console.log("\n--- wrangler dev output ---\n" + logs.join("").slice(-4000));
    rmSync(persist, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
