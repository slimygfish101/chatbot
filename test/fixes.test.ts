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
  it("STOP from a removed member: #add or an import can't text him; START alone returns him to 'removed'", async () => {
    const s = setup();
    s.db.sqlite.exec(`INSERT INTO members (phone,name,status,added_at,updated_at) VALUES ('+17185551234','Moshe','removed','x','x')`);
    await handleInbound(s.cfg, s.deps, inbound("+17185551234", "STOP"));
    expect(status(s, "+17185551234")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound("+17185551234", "start"));
    expect(status(s, "+17185551234")).toBe("removed");
  });

  it("#add of someone who texted STOP: not texted now, joins the list when he texts START", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "quit"));
    expect(status(s, "+17185559999")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185559999 Avi"));
    expect(s.telnyx.to("+17185559999")).toHaveLength(0);
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Not added yet: Avi (ending 9999) texted STOP. He'll be added when he texts START to this number.");
    expect(status(s, "+17185559999")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "UNSTOP"));
    expect(s.db.rows("SELECT name, status FROM members WHERE phone = '+17185559999'")).toEqual([{ name: "Avi", status: "active" }]);
  });

  it("an imported list does the same for someone who texted STOP", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "STOP"));
    for (const q of buildImportSql([{ name: "Avi", phone: "+17185559999" }], "t")) s.db.sqlite.exec(q);
    expect(status(s, "+17185559999")).toBe("opted_out");
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "START"));
    expect(status(s, "+17185559999")).toBe("active");
  });

  it("a stranger's STOP then START doesn't put him on the list, and #add works after", async () => {
    const s = setup();
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "STOP"));
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "START"));
    expect(status(s, "+17185559999")).toBe("removed");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185559999 Avi"));
    expect(status(s, "+17185559999")).toBe("active");
  });

  it("#remove of someone who texted STOP: his later START doesn't put him back", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(p, "STOP"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#remove " + p));
    await handleInbound(s.cfg, s.deps, inbound(p, "START"));
    expect(status(s, p)).toBe("removed");
  });

  it("#count doesn't count strangers or admins whose STOP was recorded", async () => {
    const s = setup();
    const [p] = addMembers(s.db, 3);
    await handleInbound(s.cfg, s.deps, inbound(p, "STOP"));
    await handleInbound(s.cfg, s.deps, inbound("+17185550011", "STOP"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "cancel"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "START"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#count"));
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("2 active members. 1 opted out.");
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
  it("tell the admin to resend", async () => {
    const s = setup();
    addMembers(s.db, 2);
    const real = s.deps.store.createBlastJob.bind(s.deps.store);
    s.deps.store.createBlastJob = async () => {
      throw new Error("D1_ERROR: Network connection lost");
    };
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"))).toBe("failed");
    expect(s.telnyx.to(ADMIN)[0].text).toBe("Not sent because of a system error. Please send it again.");
    expect(s.db.rows("SELECT * FROM jobs")).toHaveLength(0);
    s.deps.store.createBlastJob = real;
    // A resend from the phone is a new message (new id).
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"))).toBe("blast_created");
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

describe("second review round", () => {
  it("#cancel right after a blast finished (waiting for delivery reports) cancels the queued one, not the finished one", async () => {
    const s = setup();
    const phones = addMembers(s.db, 5);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Blast A"));
    expect(await runSender(s.cfg, s.deps)).toBe("waiting_receipts");
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "WRONG blast B"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe('Cancelled "WRONG blast B". 0 of 5 had already been sent.');
    receipts(s);
    s.clock.advance(60_000);
    await drain(s);
    for (const p of phones) expect(s.telnyx.to(p).map((m) => m.text)).toEqual(["Blast A"]);
    expect(s.telnyx.to(ADMIN).map((m) => m.text)).toContain("Sent to 5 of 5.");
  });

  it("a Telnyx timeout is never retried (it may have been sent)", async () => {
    const s = setup();
    const [a, b] = addMembers(s.db, 2);
    const real = s.telnyx.fetch;
    s.deps.fetch = async (url, init) => {
      const res = await real(url, init); // Telnyx got it...
      if (JSON.parse(String(init?.body)).to === a) throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); // ...but answered too late
      return res;
    };
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.telnyx.to(a)).toHaveLength(1);
    expect(s.telnyx.to(b)).toHaveLength(1);
    expect(s.db.rows("SELECT status, error FROM job_recipients WHERE phone = ?", a)).toEqual([
      { status: "failed", error: "timeout: may have been sent" },
    ]);
  });

  it("a network error before reaching Telnyx is retried", async () => {
    const s = setup();
    const [a] = addMembers(s.db, 1);
    let first = true;
    const real = s.telnyx.fetch;
    s.deps.fetch = async (url, init) => {
      if (first && JSON.parse(String(init?.body)).to === a) {
        first = false;
        throw new TypeError("fetch failed");
      }
      return real(url, init);
    };
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    await drain(s);
    expect(s.telnyx.to(a)).toHaveLength(1);
    expect(s.db.rows("SELECT status FROM job_recipients")).toEqual([{ status: "sent" }]);
  });

  it("if the database saved the blast but reported an error, the admin isn't told to resend", async () => {
    const s = setup();
    const phones = addMembers(s.db, 2);
    const real = s.deps.store.createBlastJob.bind(s.deps.store);
    s.deps.store.createBlastJob = async (...a) => {
      await real(...a);
      throw new Error("D1_ERROR: Network connection lost");
    };
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"))).toBe("blast_created");
    expect(s.telnyx.to(ADMIN)).toHaveLength(0);
    await drain(s);
    for (const p of phones) expect(s.telnyx.to(p)).toHaveLength(1);
  });

  it("an error during a command gets a neutral reply, never 'send it again'", async () => {
    const s = setup();
    addMembers(s.db, 2);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "A"));
    s.deps.store.jobCounts = async () => {
      throw new Error("boom");
    };
    expect(await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"))).toBe("failed");
    expect(s.telnyx.to(ADMIN).at(-1)!.text).toBe("Something went wrong. That command may or may not have worked.");
  });

  it("after a crash, a recovered recipient who was #removed meanwhile is skipped", async () => {
    const s = setup();
    const phones = addMembers(s.db, 4);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    let saves = 0;
    const realSave = s.deps.store.saveResult.bind(s.deps.store);
    s.deps.store.saveResult = async (...a) => {
      if (++saves === 2) throw new Error("Worker killed");
      return realSave(...a);
    };
    await expect(runSender(s.cfg, s.deps)).rejects.toThrow();
    s.deps.store.saveResult = realSave;
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#remove " + phones[3]));
    s.clock.advance(11 * 60_000);
    await drain(s);
    expect(s.telnyx.to(phones[3])).toHaveLength(0);
    expect(s.telnyx.to(phones[2])).toHaveLength(1);
  });

  it("a welcome job skips someone the admin welcomed with #add meanwhile", async () => {
    const s = setup();
    const rows = Array.from({ length: 20 }, (_, i) => ({ name: `B${i}`, phone: `+1718555${String(4000 + i)}` }));
    for (const q of buildImportSql(rows, "t", "Welcome!")) s.db.sqlite.exec(q);
    await runSender(s.cfg, s.deps); // 15 welcomed
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#remove 7185554019"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#add 7185554019 B19"));
    s.clock.advance(60_000);
    await drain(s);
    expect(s.telnyx.to("+17185554019")).toHaveLength(1);
  });

  it("pacing follows the cron's scheduled minute, so a late start doesn't skip the next minute", async () => {
    const s = setup();
    const phones = addMembers(s.db, 30);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "hi"));
    const minute = s.clock.now().getTime();
    s.clock.advance(7_000); // this run starts 7s late
    expect(await runSender(s.cfg, s.deps, minute)).toBe("sent_batch");
    s.clock.t = minute + 60_300; // next run on time
    expect(await runSender(s.cfg, s.deps, minute + 60_000)).not.toBe("locked");
    expect(membersSent(s, phones)).toBe(30);
  });

  it("a failed HELP reply can be retried the same day", async () => {
    const s = setup();
    let fail = true;
    s.telnyx.respond = () => (fail ? { status: 503, body: {} } : null);
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "HELP"));
    fail = false;
    await handleInbound(s.cfg, s.deps, inbound("+17185559999", "HELP"));
    expect(s.telnyx.to("+17185559999")).toHaveLength(1);
  });

  it("#cancel reply stays one plain text even for Hebrew or emoji blasts", async () => {
    const s = setup();
    addMembers(s.db, 1);
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "Practice cancelled today🏀 see you Sunday"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "שיעור מבוטל היום"));
    await handleInbound(s.cfg, s.deps, inbound(ADMIN, "#cancel"));
    const replies = s.telnyx.to(ADMIN).map((m) => m.text);
    expect(replies).toEqual([
      'Cancelled "Practice cancelled today...". 0 of 1 had already been sent.',
      'Cancelled "your message". 0 of 1 had already been sent.',
    ]);
    for (const r of replies) expect(countSegments(r)).toEqual({ encoding: "GSM-7", segments: 1 });
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

  it("names ending in x, and grade columns, aren't mistaken for extensions", () => {
    const r = parseMemberList("Alex\t2125551234\t9\nMax Cox 212-555-1235 12\n2125551236 Felix 10\nAlex 11 718-555-1237");
    expect(r.rows.map((x) => x.phone)).toEqual(["+12125551234", "+12125551235", "+12125551236", "+17185551237"]);
    expect(r.flags.every((f) => !f.problem.includes("extension"))).toBe(true);
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
    expect(maskLine("Alex\t2125551234\t9")).toBe("Alex\t…1234\t9");
    expect(maskLine("Moshe 212–555–1234 and 212/555/9876")).toBe("Moshe …1234 and …9876");
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
