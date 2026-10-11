// Replays real-shaped Telnyx webhooks, signed the way Telnyx signs them,
// through the Worker's HTTP handler.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { handleFetch } from "../src/index";
import { runSender } from "../src/sender";
import { ADMIN, addMembers, setup } from "./helpers";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");

let keys: CryptoKeyPair;
let publicKeyB64: string;
beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicKeyB64 = b64((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
});

async function signed(body: string, timestamp: number, key = keys.privateKey) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(`${timestamp}|${body}`));
  return new Request("https://text-blast.example.workers.dev/telnyx", {
    method: "POST",
    headers: { "content-type": "application/json", "telnyx-signature-ed25519": b64(sig), "telnyx-timestamp": String(timestamp) },
    body,
  });
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  };
}

/** One once-a-minute sender run, then a minute passes and carriers report delivery. */
async function cron(s: ReturnType<typeof world>) {
  const r = await runSender(s.cfg, s.deps);
  s.db.sqlite.exec("UPDATE job_recipients SET delivery = 'delivered' WHERE status = 'sent' AND delivery IS NULL");
  s.clock.advance(60_000);
  return r;
}

function world() {
  const s = setup({ TELNYX_PUBLIC_KEY: "" });
  s.env.TELNYX_PUBLIC_KEY = publicKeyB64;
  s.cfg.publicKey = publicKeyB64;
  return s;
}

describe("webhook replay", () => {
  it("valid admin text → 200, blast saved, sent by the next minute's runs", async () => {
    const s = world();
    const phones = addMembers(s.db, 20);
    const { ctx, settle } = fakeCtx();
    const res = await handleFetch(await signed(fixture("admin-blast.json"), s.clock.now().getTime() / 1000), s.env, ctx, s.deps);
    expect(res.status).toBe(200);
    await settle();
    expect(s.db.rows("SELECT status FROM jobs")).toEqual([{ status: "queued" }]);
    await cron(s);
    expect(s.telnyx.sent).toHaveLength(15);
    expect(s.telnyx.sent[0].text).toBe("Shiur is moved to 8pm tonight.");
    await cron(s);
    await cron(s);
    for (const p of phones) expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 20 of 20.");
  });

  it("the same webhook delivered twice only blasts once", async () => {
    const s = world();
    const phones = addMembers(s.db, 3);
    const body = fixture("admin-blast.json");
    for (let i = 0; i < 3; i++) {
      const { ctx, settle } = fakeCtx();
      expect((await handleFetch(await signed(body, s.clock.now().getTime() / 1000), s.env, ctx, s.deps)).status).toBe(200);
      await settle();
    }
    await cron(s);
    await cron(s);
    for (const p of phones) expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(1);
  });

  it("long MMS from the admin goes out as text-only SMS", async () => {
    const s = world();
    const [p] = addMembers(s.db, 1);
    const { ctx, settle } = fakeCtx();
    await handleFetch(await signed(fixture("admin-long-mms.json"), s.clock.now().getTime() / 1000), s.env, ctx, s.deps);
    await settle();
    await cron(s);
    await cron(s);
    const sent = s.telnyx.to(p);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("SMS");
    expect(sent[0].text.startsWith("Reminder: the trip on Sunday")).toBe(true);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toContain("used 2 texts per person");
  });

  it("member STOP updates the list", async () => {
    const s = world();
    addMembers(s.db, 1);
    const { ctx, settle } = fakeCtx();
    await handleFetch(await signed(fixture("member-stop.json"), s.clock.now().getTime() / 1000), s.env, ctx, s.deps);
    await settle();
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("opted_out");
    expect(s.telnyx.sent).toHaveLength(0);
  });

  it("delivery reports are saved", async () => {
    const s = world();
    addMembers(s.db, 1);
    const { ctx, settle } = fakeCtx();
    await handleFetch(await signed(fixture("admin-blast.json"), s.clock.now().getTime() / 1000), s.env, ctx, s.deps);
    await settle();
    await runSender(s.cfg, s.deps); // sends to …1000 as msg-1
    const c2 = fakeCtx();
    await handleFetch(await signed(fixture("message-finalized.json"), s.clock.now().getTime() / 1000), s.env, c2.ctx, s.deps);
    await c2.settle();
    expect(s.db.rows("SELECT delivery FROM job_recipients")[0].delivery).toBe("delivered");
  });

  it("rejects a bad signature", async () => {
    const s = world();
    addMembers(s.db, 1);
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const { ctx, settle } = fakeCtx();
    const res = await handleFetch(await signed(fixture("admin-blast.json"), s.clock.now().getTime() / 1000, other.privateKey), s.env, ctx, s.deps);
    await settle();
    expect(res.status).toBe(401);
    expect(s.telnyx.sent).toHaveLength(0);
  });

  it("rejects a tampered body", async () => {
    const s = world();
    addMembers(s.db, 1);
    const ts = s.clock.now().getTime() / 1000;
    const req = await signed(fixture("admin-blast.json"), ts);
    const tampered = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: fixture("admin-blast.json").replace("8pm", "9pm"),
    });
    expect((await handleFetch(tampered, s.env, fakeCtx().ctx, s.deps)).status).toBe(401);
  });

  it("rejects old timestamps (replay attacks)", async () => {
    const s = world();
    const old = s.clock.now().getTime() / 1000 - 301;
    expect((await handleFetch(await signed(fixture("admin-blast.json"), old), s.env, fakeCtx().ctx, s.deps)).status).toBe(401);
  });

  it("rejects missing headers and other paths", async () => {
    const s = world();
    const plain = new Request("https://x.workers.dev/telnyx", { method: "POST", body: fixture("admin-blast.json") });
    expect((await handleFetch(plain, s.env, fakeCtx().ctx, s.deps)).status).toBe(401);
    expect((await handleFetch(new Request("https://x.workers.dev/other"), s.env, fakeCtx().ctx, s.deps)).status).toBe(404);
    expect((await handleFetch(new Request("https://x.workers.dev/telnyx"), s.env, fakeCtx().ctx, s.deps)).status).toBe(405);
  });
});
