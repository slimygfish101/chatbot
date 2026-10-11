// Tests for the issues found in the independent review.
import { describe, expect, it } from "vitest";
import { handleInbound } from "../src/inbound";
import { runSender } from "../src/sender";
import { countSegments } from "../src/segments";
import { buildImportSql } from "../scripts/import-sql";
import { maskLine, parseMemberList } from "../scripts/members-parse";
import { ADMIN, addMembers, d1Stats, inbound, setup } from "./helpers";

type S = ReturnType<typeof setup>;
const receipts = (s: S, status = "delivered") =>
  s.db.sqlite.prepare("UPDATE job_recipients SET delivery = ? WHERE status = 'sent' AND delivery IS NULL").run(status);
async function drain(s: S, maxRuns = 60) {
  for (let i = 0; i < maxRuns; i++) {
    const r = await runSender(s.cfg, s.deps);
    if (r === "done" || r === "idle") return;
    receipts(s);
    s.clock.advance(60_000);
  }
}
const status = (s: S, phone: string) => s.db.rows("SELECT status FROM members WHERE phone = ?", phone)[0]?.status;
const membersSent = (s: S, phones: string[]) => s.telnyx.sent.filter((m) => phones.includes(m.to)).length;

describe("pacing: at most one batch a minute", () => {
  it("a second run soon after a batch sends nothing; the next minute's run continues", async () => {
    const s = setup();
    const phones = addMembers(s.db, 40);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(await runSender(s.cfg, s.deps)).toBe("sent_batch");
    s.clock.advance(2_000);
    expect(await runSender(s.cfg, s.deps)).toBe("locked");
    s.clock.advance(50_000);
    expect(await runSender(s.cfg, s.deps)).toBe("locked");
    expect(membersSent(s, phones)).toBe(15);
    s.clock.advance(8_000);
    expect(await runSender(s.cfg, s.deps)).toBe("sent_batch");
    expect(membersSent(s, phones)).toBe(30);
  });

  it("the webhook itself never sends a batch (only the minute runs do)", async () => {
    const s = setup();
    addMembers(s.db, 5);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(s.telnyx.sent).toHaveLength(0);
  });
});

describe("daily cap counts texts, not people", () => {
  it("a 2-text message uses 2 of the cap per person", async () => {
    const s = setup({ MAX_TEXTS_PER_DAY: "30" });
    const phones = addMembers(s.db, 20);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "x".repeat(200))); // 2 segments
    for (let i = 0; i < 6; i++) {
      await runSender(s.cfg, s.deps);
      s.clock.advance(60_000);
    }
    expect(membersSent(s, phones)).toBe(15); // 15 people × 2 texts = 30
    expect(s.db.rows("SELECT SUM(count) AS n FROM daily_counts")[0].n).toBeGreaterThanOrEqual(30);
    expect(s.telnyx.to(ADMIN).filter((m) => m.text.startsWith("Daily limit"))).toHaveLength(1);
  });

  it("admin replies count their real number of texts", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#help"));
    expect(s.db.rows("SELECT count FROM daily_counts")[0].count).toBe(countSegments(s.telnyx.sent[0].text).segments);
  });
});

describe("dry run has no lasting side effects", () => {
  it("#add in dry run doesn't mark the member welcomed or use the cap", async () => {
    const s = setup({ DRY_RUN: "true" });
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234 Moshe"));
    expect(s.db.rows("SELECT welcomed_at FROM members")[0].welcomed_at).toBeNull();
    expect(s.db.rows("SELECT * FROM daily_counts")).toHaveLength(0);
  });

  it("a dry-run welcome job doesn't mark anyone welcomed", async () => {
    const s = setup({ DRY_RUN: "true" });
    const rows = [{ name: "A", phone: "+17185551111" }];
    for (const q of buildImportSql(rows, "2026-10-11T00:00:00Z", "Welcome!")) s.db.sqlite.exec(q);
    await drain(s);
    expect(s.db.rows("SELECT welcomed_at FROM members")[0].welcomed_at).toBeNull();
  });
});

describe("STOP is always recorded", () => {
  it("STOP from a removed member: an import or #add can't bring him back; START returns him to 'removed'", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at) VALUES ('+17185551234','Moshe','removed','x','x')`);
    await handleInbound(s.cfg, s.deps, inbound("+17185551234", "STOP"));
    expect(status(s, "+17185551234")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234 Moshe"));
    expect(status(s, "+17185551234")).toBe("opted_out");
    for (const q of buildImportSql([{ name: "Moshe", phone: "+17185551234" }], "t")) s.db.sqlite.exec(q);
    expect(status(s, "+17185551234")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound("+17185551234", "start"));
    expect(status(s, "+17185551234")).toBe("removed");
  });

  it("STOP from a stranger is recorded; his START doesn't put him on the list; then #add works", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "quit"));
    expect(status(s, "+17185559999")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185559999 Avi"));
    expect(s.telnyx.to("+17185559999")).toHaveLength(0);
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "UNSTOP"));
    expect(status(s, "+17185559999")).toBe("removed");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185559999 Avi"));
    expect(status(s, "+17185559999")).toBe("active");
  });

  it("STOP then START from an active member puts him back on the list", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(p, "STOP"));
    await handleInbound(s.cfg, s.deps, inbound(p, "STOP")); // twice: still remembers he was active
    await handleInbound(s.cfg, s.deps, inbound(p, "START"));
    expect(status(s, p)).toBe("active");
  });

  it("an admin who is also on the list can opt out and back in", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at) VALUES ('${ADMIN}','Rabbi','active','x','x')`);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "STOP"));
    expect(status(s, ADMIN)).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "START"));
    expect(status(s, ADMIN)).toBe("active");
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(0);
  });

  it("#add of someone Telnyx blocks for STOP records the opt-out and tells the admin", async () => {
    const s = setup();
    s.telnyx.respond = (to) => (to === "+17185551234" ? { status: 403, body: { errors: [{ code: "40300" }] } } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234 Moshe"));
    expect(status(s, "+17185551234")).toBe("opted_out");
    expect(s.telnyx.to(ADMIN)[0].text).toContain("had texted STOP");
  });
});

describe("HELP can't be used to run up texts", () => {
  it("one reply per number per day", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) await handleInbound(s.cfg, s.deps, inbound("+17185559999", "HELP"));
    expect(s.telnyx.to("+17185559999")).toHaveLength(1);
    s.clock.advance(24 * 3600_000);
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "HELP"));
    expect(s.telnyx.to("+17185559999")).toHaveLength(2);
  });

  it("no HELP reply once the daily cap is used up", async () => {
    const s = setup({ MAX_TEXTS_PER_DAY: "1" });
    await handleInbound(s.cfg, s.deps, inbound("+17185550001", "HELP"));
    await handleInbound(s.cfg, s.deps, inbound("+17185550002", "HELP"));
    expect(s.telnyx.sent.map((m) => m.to)).toEqual(["+17185550001"]);
  });
});

describe("#cancel", () => {
  it("cancels the waiting message when nothing is sending yet", async () => {
    const s = setup();
    const phones = addMembers(s.db, 3);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Wrong message"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe('Cancelled "Wrong message". 0 of 3 had already been sent.');
    await drain(s);
    expect(membersSent(s, phones)).toBe(0);
  });

  it("stops between texts, mid-batch, with no summary afterwards", async () => {
    const s = setup();
    const phones = addMembers(s.db, 10);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "oops"));
    const realFetch = s.telnyx.fetch;
    let n = 0;
    s.deps.fetch = async (url, init) => {
      const res = await realFetch(url, init);
      if (++n === 3) await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
      return res;
    };
    expect(await runSender(s.cfg, s.deps)).toBe("cancelled");
    expect(membersSent(s, phones)).toBe(3);
    expect(s.telnyx.to(ADMIN).map((m) => m.text)).toEqual(['Cancelled "oops". 2 of 10 had already been sent. Up to 8 more were already on their way.']);
    expect(s.db.rows("SELECT status, COUNT(*) AS n FROM job_recipients GROUP BY status ORDER BY status")).toEqual([
      { status: "sent", n: 3 },
      { status: "skipped", n: 7 },
    ]);
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("idle");
  });
});

describe("summary", () => {
  it("counts carrier-reported delivery failures as failed", async () => {
    const s = setup();
    const [a] = addMembers(s.db, 2);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    expect(await runSender(s.cfg, s.deps)).toBe("waiting_receipts");
    s.db.sqlite.prepare("UPDATE job_recipients SET delivery = 'delivery_failed' WHERE phone = ?").run(a);
    receipts(s);
    s.clock.advance(60_000);
    expect(await runSender(s.cfg, s.deps)).toBe("done");
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 1 of 2. 1 failed.");
  });

  it("doesn't wait forever for delivery reports", async () => {
    const s = setup();
    addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      results.push(await runSender(s.cfg, s.deps));
      s.clock.advance(60_000);
    }
    expect(results).toEqual(["waiting_receipts", "waiting_receipts", "done", "idle"]);
  });

  it("is retried if Telnyx fails to send it, then given up", async () => {
    const s = setup();
    addMembers(s.db, 1);
    s.telnyx.respond = (to) => (to === ADMIN ? { status: 500, body: {} } : null);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await runSender(s.cfg, s.deps));
      receipts(s);
      s.clock.advance(60_000);
    }
    expect(results).toEqual(["waiting_receipts", "summary_retry", "summary_retry", "done", "idle", "idle"]);
  });

  it("notes special characters even when the message fits in one text", async () => {
    const s = setup();
    addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Mazel tov 🎉"));
    await drain(s);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Sent to 1 of 1. Special characters: used 1 text per person.");
  });

  it("admin replies are plain one-text SMS", async () => {
    const s = setup();
    addMembers(s.db, 3);
    for (const t of ["#add 7185551234 Moshe Levi", "#remove 7185551234", "#count", "#help", "#oops", "#cancel"]) {
      await handleInbound(s.cfg, s.deps, inbound(ADMIN, t));
    }
    for (const m of s.telnyx.to(ADMIN)) expect({ text: m.text, ...countSegments(m.text) }).toEqual({ text: m.text, encoding: "GSM-7", segments: 1 });
  });
});

describe("errors before a blast is saved", () => {
  it("tell the admin to resend, and the resend isn't treated as a duplicate", async () => {
    const s = setup();
    addMembers(s.db, 2);
    const real = s.deps.store.createBlastJob.bind(s.deps.store);
    s.deps.store.createBlastJob = async () => {
      throw new Error("D1_ERROR: Network connection lost");
    };
    const msg = inbound(ADMIN, "hi");
    expect(await handleInbound(s.cfg, s.deps, msg)).toBe("failed");
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Not sent because of a system error. Please send it again.");
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(0);
    s.deps.store.createBlastJob = real;
    expect(await handleInbound(s.cfg, s.deps, msg)).toBe("blast_created");
  });

  it("errors after the blast is saved don't ask for a resend (that would double-send)", async () => {
    const s = setup();
    addMembers(s.db, 2);
    s.deps.store.jobsAhead = async () => {
      throw new Error("boom");
    };
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"))).toBe("blast_created");
    expect(s.telnyx.to(ADMIN)).toHaveLength(0);
    expect(s.db.rows("SELECT status FROM jobs")).toEqual([{ status: "queued" }]);
  });
});

describe("import SQL", () => {
  it("adds, renames, re-activates removed, keeps opted-out, survives quotes", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at) VALUES
      ('+17185550001','Old','removed','x','x'), ('+17185550002','Out','opted_out','x','x'), ('+17185550003','Keep','active','x','x')`);
    const rows = [
      { name: "Re'added", phone: "+17185550001" },
      { name: "Out", phone: "+17185550002" },
      { name: "", phone: "+17185550003" },
      { name: "O'Brien \"Sam\"", phone: "+17185550004" },
    ];
    for (const q of buildImportSql(rows, "2026-10-11T00:00:00Z")) s.db.sqlite.exec(q);
    expect(s.db.rows("SELECT phone, name, status FROM members ORDER BY phone")).toEqual([
      { phone: "+17185550001", name: "Re'added", status: "active" },
      { phone: "+17185550002", name: "Out", status: "opted_out" },
      { phone: "+17185550003", name: "Keep", status: "active" },
      { phone: "+17185550004", name: "O'Brien \"Sam\"", status: "active" },
    ]);
  });

  it("welcome: only active, not yet welcomed; marked welcomed batch by batch; re-import mid-send doesn't double", async () => {
    const s = setup();
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `B${i}`, phone: `+1718555${String(2000 + i)}` }));
    for (const q of buildImportSql(rows, "t", "Welcome!")) s.db.sqlite.exec(q);
    await runSender(s.cfg, s.deps); // first 15
    expect(s.db.rows("SELECT COUNT(*) AS n FROM members WHERE welcomed_at IS NOT NULL")[0].n).toBe(15);
    for (const q of buildImportSql(rows, "t2", "Welcome!")) s.db.sqlite.exec(q); // owner re-runs the import
    expect(s.db.rows("SELECT id, status FROM jobs ORDER BY id")).toEqual([
      { id: 1, status: "sending" },
      { id: 2, status: "done" }, // nobody new to welcome
    ]);
    s.clock.advance(60_000);
    await drain(s);
    for (const r of rows) expect(s.telnyx.to(r.phone)).toHaveLength(1);
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Welcome texts: sent to 20 of 20.");
  });
});

describe("member list parser edge cases", () => {
  it("a grade or room number before the phone doesn't eat it", () => {
    const r = parseMemberList("Moshe Cohen grade 11 718-555-3456\nYossi room 101 (347) 555-2222");
    expect(r.rows.map((x) => x.phone)).toEqual(["+17185553456", "+13475552222"]);
    expect(r.flags.map((f) => f.problem)).toEqual([
      'name has numbers in it ("Moshe Cohen grade 11"); check it',
      'name has numbers in it ("Yossi room 101"); check it',
    ]);
  });

  it("numbers with an extension are skipped as not-a-cell", () => {
    const r = parseMemberList("Office 212-555-7000 ext 12");
    expect(r.rows).toEqual([]);
    expect(r.flags[0].problem).toContain("extension");
  });

  it("finds both numbers when a line has two", () => {
    const r = parseMemberList("Avi 718-555-1111 home 718-555-2222");
    expect(r.rows.map((x) => [x.name, x.phone])).toEqual([["Avi home", "+17185551111"]]);
    expect(r.flags.map((f) => f.problem)).toContain("more than one number on this line; used the first");
  });

  it("previews never show a full number", () => {
    expect(maskLine("Moshe (718) 555-1234 and +1 347 555 9876 x")).toBe("Moshe …1234 and …9876 x");
    expect(maskLine("bad 555-12345678")).not.toMatch(/\d{5}/);
  });
});

describe("Cloudflare free plan: at most 50 subrequests per run", () => {
  // Counts every D1 statement (each statement in a batch separately, the strict
  // reading) plus every Telnyx call, in the busiest runs there are.
  async function measure(s: S, fn: () => Promise<unknown>) {
    const before = { d1: d1Stats.statements, fetch: s.telnyx.calls };
    await fn();
    return d1Stats.statements - before.d1 + (s.telnyx.calls - before.fetch);
  }

  it("a full batch that also finishes the job and sends the summary", async () => {
    const s = setup({ DRY_RUN: "false" });
    addMembers(s.db, 15);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    s.db.sqlite.exec("UPDATE jobs SET finish_waits = 2"); // force finishing in the same run
    const used = await measure(s, () => runSender(s.cfg, s.deps));
    expect(s.telnyx.to(ADMIN)).toHaveLength(1);
    expect(used).toBeLessThanOrEqual(50);
  });

  it("a welcome-job batch", async () => {
    const s = setup();
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `B${i}`, phone: `+1718555${String(3000 + i)}` }));
    for (const q of buildImportSql(rows, "t", "Welcome!")) s.db.sqlite.exec(q);
    const used = await measure(s, () => runSender(s.cfg, s.deps));
    expect(used).toBeLessThanOrEqual(50);
  });

  it("the webhook invocation for a blast and for #add", async () => {
    const s = setup();
    addMembers(s.db, 100);
    expect(await measure(s, () => handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi")))).toBeLessThanOrEqual(50);
    expect(await measure(s, () => handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185551234 Moshe")))).toBeLessThanOrEqual(50);
  });
});
