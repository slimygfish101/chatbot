import { describe, expect, it } from "vitest";
import { handleInbound } from "../src/inbound";
import { runSender } from "../src/sender";
import { ADMIN, addMembers, inbound, setup } from "./helpers";

/** Carriers report every sent text as delivered. */
function receipts(s: ReturnType<typeof setup>, status = "delivered") {
  s.db.sqlite.prepare("UPDATE job_recipients SET delivery = ? WHERE status = 'sent' AND delivery IS NULL").run(status);
}

/**
 * Runs the once-a-minute sender until the current blast finishes (or max runs).
 * Delivery reports arrive between runs unless `withReceipts` is false.
 */
async function drain(s: ReturnType<typeof setup>, maxRuns = 50, withReceipts = true) {
  let runs = 0;
  for (; runs < maxRuns; runs++) {
    const r = await runSender(s.cfg, s.deps);
    if (r === "done" || r === "idle") break;
    if (withReceipts) receipts(s);
    s.clock.advance(60_000);
  }
  return runs + 1;
}

describe("blast from admin", () => {
  it("sends to all 100 active members in 15-per-minute batches, then summarizes", async () => {
    const s = setup();
    const phones = addMembers(s.db, 100);
    addMembers(s.db, 0);
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Bus leaves at 7:30 tomorrow."))).toBe("blast_created");

    const runs = await drain(s);
    expect(runs).toBe(8); // ceil(100 / 15) batches, then the summary once delivery reports are in
    for (const p of phones) expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.telnyx.sent.every((m) => m.type === "SMS" && m.from === "+12125550000")).toBe(true);
    expect(s.telnyx.to(phones[0])[0].text).toBe("Bus leaves at 7:30 tomorrow.");
    expect(s.telnyx.to(ADMIN).map((m) => m.text)).toEqual(["Sent to 100 of 100."]);
  });

  it("never sends more than the batch size per run", async () => {
    const s = setup();
    addMembers(s.db, 40);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await runSender(s.cfg, s.deps);
    expect(s.telnyx.sent).toHaveLength(15);
  });

  it("only sends to active members", async () => {
    const s = setup();
    const active = addMembers(s.db, 3);
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at,welcomed_at) VALUES ('+13475559998','Out','opted_out','x','x',NULL), ('+13475559999','Gone','removed','x','x',NULL)`);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.telnyx.sent.filter((m) => m.to !== ADMIN).map((m) => m.to).sort()).toEqual(active);
  });

  it("skips someone who opts out after the blast was queued", async () => {
    const s = setup();
    const phones = addMembers(s.db, 20);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await runSender(s.cfg, s.deps); // first 15 (sorted by phone)
    await handleInbound(s.cfg, s.deps, inbound(phones[19], "STOP"));
    s.clock.advance(60_000);
    await drain(s);
    expect(s.telnyx.to(phones[19])).toHaveLength(0);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 19 of 20. 1 skipped (opted out or removed).");
  });

  it("reports texts-per-person for long or non-GSM messages", async () => {
    const s = setup();
    addMembers(s.db, 2);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Mazel tov! 🎉 " + "x".repeat(70)));
    await drain(s);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 2 of 2. Special characters: used 2 texts per person.");
  });

  it("uses only the text of an MMS and never forwards media", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    const msg = inbound(ADMIN, "Long announcement text", { type: "MMS", media: [{ url: "https://x/y.jpg", content_type: "image/jpeg" }] });
    await handleInbound(s.cfg, s.deps, msg);
    await drain(s);
    expect(s.telnyx.to(p)).toEqual([{ from: "+12125550000", to: p, text: "Long announcement text", type: "SMS" }]);
    expect(JSON.stringify(s.telnyx.sent)).not.toContain("media");
  });

  it("rejects a picture with no text", async () => {
    const s = setup();
    addMembers(s.db, 1);
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "", { type: "MMS", media: [{ url: "u" }] }))).toBe("admin_rejected");
    expect(s.telnyx.to(ADMIN)[0].text).toContain("pictures aren't forwarded");
  });

  it("says so when the list is empty", async () => {
    const s = setup();
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"))).toBe("blast_empty");
    expect(s.telnyx.to(ADMIN)[0].text).toContain("no active members");
  });

  it("never broadcasts a lone keyword from the admin", async () => {
    const s = setup();
    addMembers(s.db, 3);
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "HELP"))).toBe("admin_rejected");
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "stop"))).toBe("admin_rejected");
    await drain(s);
    expect(s.telnyx.sent.filter((m) => m.to !== ADMIN)).toHaveLength(0);
    expect(s.telnyx.to(ADMIN)).toHaveLength(1); // reply to HELP only; no reply after STOP
  });
});

describe("dedupe", () => {
  it("a repeated webhook never causes a second blast", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    const msg = inbound(ADMIN, "hi");
    expect(await handleInbound(s.cfg, s.deps, msg)).toBe("blast_created");
    expect(await handleInbound(s.cfg, s.deps, msg)).toBe("duplicate");
    expect(await handleInbound(s.cfg, s.deps, { ...msg })).toBe("duplicate");
    await drain(s);
    expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(1);
  });

  it("ignores messages sent to a different number", async () => {
    const s = setup();
    addMembers(s.db, 1);
    const msg = inbound(ADMIN, "hi", { to: [{ phone_number: "+13125550000" }] });
    expect(await handleInbound(s.cfg, s.deps, msg)).toBe("ignored_wrong_number");
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(0);
  });
});

describe("queueing and cancel", () => {
  it("only one blast sends at a time; the second is queued and follows", async () => {
    const s = setup();
    const phones = addMembers(s.db, 20);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "first"));
    await runSender(s.cfg, s.deps);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "second"));
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toContain("Queued");
    s.clock.advance(60_000);
    await drain(s); // finishes first
    s.clock.advance(60_000);
    await drain(s); // then second
    for (const p of phones) expect(s.telnyx.to(p).map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("#cancel stops the current blast", async () => {
    const s = setup();
    const phones = addMembers(s.db, 40);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "oops"));
    await runSender(s.cfg, s.deps);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe('Cancelled "oops". 15 of 40 had already been sent.');
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("idle");
    expect(s.telnyx.sent.filter((m) => phones.includes(m.to))).toHaveLength(15);
  });

  it("#cancel with nothing sending", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Nothing is sending right now.");
  });

  it("two sender runs at the same moment don't double-send", async () => {
    const s = setup();
    const phones = addMembers(s.db, 30);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    const results = await Promise.all([runSender(s.cfg, s.deps), runSender(s.cfg, s.deps)]);
    expect(results).toContain("locked");
    s.clock.advance(60_000);
    await drain(s);
    for (const p of phones) expect(s.telnyx.to(p)).toHaveLength(1);
  });

  it("PAUSED saves the blast but sends nothing", async () => {
    const s = setup({ PAUSED: "true" });
    addMembers(s.db, 5);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(await runSender(s.cfg, s.deps)).toBe("paused");
    expect(s.telnyx.sent.filter((m) => m.to !== ADMIN)).toHaveLength(0);
    expect(s.telnyx.to(ADMIN)[0].text).toContain("paused");
  });
});

describe("retries and failures", () => {
  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    let failures = 0;
    s.telnyx.respond = (to) => (to === p && failures++ < 2 ? { status: failures === 1 ? 429 : 503, body: {} } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(await runSender(s.cfg, s.deps)).toBe("sent_batch"); // 429, retry in 30s
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("sent_batch"); // 503, retry in 60s
    s.clock.advance(30_000);
    expect(await runSender(s.cfg, s.deps)).toBe("locked"); // batches stay at least 55s apart
    s.clock.advance(26_000);
    expect(await runSender(s.cfg, s.deps)).toBe("waiting"); // 56s after the 503: backoff (60s) not over
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("waiting_receipts"); // sent; waiting for the carrier's report
    receipts(s);
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("done");
    expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.db.rows("SELECT status, attempts FROM job_recipients")).toEqual([{ status: "sent", attempts: 3 }]);
  });

  it("gives up after 4 tries and reports the failure", async () => {
    const s = setup();
    addMembers(s.db, 2);
    s.telnyx.respond = (to) => (to === "+13475551000" ? { status: 500, body: {} } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 1 of 2. 1 failed.");
    expect(s.db.rows("SELECT attempts FROM job_recipients WHERE phone='+13475551000'")[0].attempts).toBe(4);
  });

  it("does not retry other 4xx errors", async () => {
    const s = setup();
    addMembers(s.db, 1);
    s.telnyx.respond = (to) => (to !== ADMIN ? { status: 422, body: { errors: [{ code: "40310", title: "Invalid to" }] } } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(await runSender(s.cfg, s.deps)).toBe("done");
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 0 of 1. 1 failed.");
  });

  it("a Telnyx STOP block (40300) marks the member opted out", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    s.telnyx.respond = (to) => (to === p ? { status: 403, body: { errors: [{ code: "40300", title: "Blocked due to STOP" }] } } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("opted_out");
  });

  it("after a crash mid-batch, the text in flight isn't resent and the untried ones still go out", async () => {
    const s = setup();
    const phones = addMembers(s.db, 5);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    // A run claims all 5, texts the first 2, then dies while texting the 3rd.
    let saves = 0;
    const realSave = s.deps.store.saveResult.bind(s.deps.store);
    s.deps.store.saveResult = async (...a) => {
      if (++saves === 3) throw new Error("Worker killed");
      return realSave(...a);
    };
    await expect(runSender(s.cfg, s.deps)).rejects.toThrow("Worker killed");
    s.deps.store.saveResult = realSave;
    expect(s.telnyx.sent.map((m) => m.to)).toEqual(phones.slice(0, 3));

    s.clock.advance(11 * 60_000); // past the stale-claim time
    await drain(s);
    for (const p of phones.slice(0, 2)) expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.telnyx.to(phones[2])).toHaveLength(1); // sent once (before the crash), never again
    for (const p of phones.slice(3)) expect(s.telnyx.to(p)).toHaveLength(1);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 4 of 5. 1 failed.");
  });
});

describe("daily cap", () => {
  it("pauses at MAX_TEXTS_PER_DAY, tells the admin once, and resumes the next day", async () => {
    const s = setup({ MAX_TEXTS_PER_DAY: "20" });
    const phones = addMembers(s.db, 30);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    for (let i = 0; i < 5; i++) {
      await runSender(s.cfg, s.deps);
      s.clock.advance(60_000);
    }
    const sentToMembers = () => s.telnyx.sent.filter((m) => phones.includes(m.to)).length;
    expect(sentToMembers()).toBe(20);
    const notices = s.telnyx.to(ADMIN).filter((m) => m.text.startsWith("Daily limit"));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain("Sent 20 of 30");

    s.clock.advance(24 * 3600_000); // next day
    await drain(s);
    expect(sentToMembers()).toBe(30);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 30 of 30.");
  });
});

describe("dry run", () => {
  it("logs instead of calling Telnyx at all", async () => {
    const s = setup({ DRY_RUN: "true" });
    addMembers(s.db, 20);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.telnyx.calls).toBe(0);
    expect(s.db.rows("SELECT COUNT(*) AS n FROM job_recipients WHERE status='sent'")[0].n).toBe(20);
  });
});

describe("admin commands", () => {
  it("#add adds, welcomes, and confirms", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 718 555 1234 Moshe"));
    expect(s.telnyx.to("+17185551234")[0].text).toContain("You're on the announcement list from Rabbi Cohen");
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Added Moshe (ending 1234). Welcome text sent. 1 active.");
    expect(s.db.rows("SELECT name, status, welcomed_at IS NOT NULL AS w FROM members")).toEqual([{ name: "Moshe", status: "active", w: 1 }]);
  });

  it("#add re-activates a removed member", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at,welcomed_at) VALUES ('+17185551234','Moshe','removed','x','x',NULL)`);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234"));
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("active");
    expect(s.telnyx.to(ADMIN)[0].text).toContain("Added Moshe");
  });

  it("#add will not override someone's own STOP", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at,welcomed_at) VALUES ('+17185551234','Moshe','opted_out','x','x',NULL)`);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234 Moshe"));
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("opted_out");
    expect(s.telnyx.to("+17185551234")).toHaveLength(0);
    expect(s.telnyx.to(ADMIN)[0].text).toContain("texted STOP");
  });

  it("#add on someone already active doesn't re-send the welcome", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at,welcomed_at) VALUES ('+17185551234','Moshe','active','x','x','x')`);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234"));
    expect(s.telnyx.to("+17185551234")).toHaveLength(0);
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Already on the list: Moshe (ending 1234).");
  });

  it("#remove, #count, #help, unknown", async () => {
    const s = setup();
    addMembers(s.db, 3);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#remove 347-555-1000"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#count"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#help"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#blast hi all"));
    expect(s.telnyx.to(ADMIN).map((m) => m.text)).toEqual([
      "Removed Boy 0 (ending 1000). 2 active.",
      "2 active members. 0 opted out.",
      expect.stringContaining("#add 2125551234 Name"),
      'Unknown command "#blast". Not sent. Text #help for the list.',
    ]);
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(0);
  });

  it("commands from non-admins are ignored (not run, not broadcast)", async () => {
    const s = setup();
    addMembers(s.db, 2);
    expect(await handleInbound(s.cfg, s.deps, inbound("+13475551000", "#add 7185551234 Hacker"))).toBe("ignored_member_text");
    expect(await handleInbound(s.cfg, s.deps, inbound("+13475551000", "hello everyone"))).toBe("ignored_member_text");
    expect(s.telnyx.sent).toHaveLength(0);
    expect(s.db.rows("SELECT COUNT(*) AS n FROM members")[0].n).toBe(2);
  });
});

describe("member keywords", () => {
  it("STOP opts out without a second reply; START comes back", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(p, "stop"));
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound(p, "START"));
    expect(s.db.rows("SELECT status FROM members")[0].status).toBe("active");
    expect(s.telnyx.sent).toHaveLength(0); // Telnyx sends those confirmations itself
  });

  it("START from a stranger or a removed member doesn't add them", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at,welcomed_at) VALUES ('+17185551234','Moshe','removed','x','x',NULL)`);
    await handleInbound(s.cfg, s.deps, inbound("+17185551234", "START"));
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "UNSTOP"));
    expect(s.db.rows("SELECT phone, status FROM members")).toEqual([{ phone: "+17185551234", status: "removed" }]);
  });

  it("HELP gets one reply", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "help"));
    expect(s.telnyx.to("+17185559999").map((m) => m.text)).toEqual(["Yeshiva Boys announcements from Rabbi Cohen. Reply STOP to opt out."]);
  });

  it("HELP gets no reply from us if Telnyx already answers it", async () => {
    const s = setup({ TELNYX_REPLIES_TO_HELP: "true" });
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "INFO"));
    const s2 = setup();
    await handleInbound(s2.cfg, s2.deps, inbound("+17185559999", "INFO", { autoresponse_type: "help" }));
    expect(s.telnyx.sent).toHaveLength(0);
    expect(s2.telnyx.sent).toHaveLength(0);
  });

  it("other replies are ignored", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    expect(await handleInbound(s.cfg, s.deps, inbound(p, "ok thanks"))).toBe("ignored_member_text");
    expect(s.telnyx.sent).toHaveLength(0);
  });
});
