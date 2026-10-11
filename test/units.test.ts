import { describe, expect, it } from "vitest";
import { parseCommand, isCommand, HELP_TEXT } from "../src/commands";
import { classifyKeyword } from "../src/keywords";
import { mask, parseAdminNumbers, toE164 } from "../src/phone";
import { countSegments } from "../src/segments";
import { backoffMs, batchLimit, dayKey } from "../src/sender";
import { loadConfig, welcomeText } from "../src/config";
import { makeDb, makeEnv } from "./helpers";

describe("phone formatting", () => {
  it.each([
    ["2125551234", "+12125551234"],
    ["(212) 555-1234", "+12125551234"],
    ["212.555.1234", "+12125551234"],
    ["1-212-555-1234", "+12125551234"],
    ["+1 212 555 1234", "+12125551234"],
    [" 212 555 1234 ", "+12125551234"],
  ])("%s -> %s", (input, out) => expect(toE164(input)).toBe(out));

  it.each(["", "555-1234", "22125551234", "0125551234", "2121551234", "+442071234567", "abc"])("rejects %s", (input) =>
    expect(toE164(input)).toBeNull(),
  );

  it("masks numbers for logs", () => {
    expect(mask("+12125551234")).toBe("…1234");
    expect(mask(undefined)).toBe("?");
  });

  it("parses ADMIN_NUMBERS", () => {
    expect(parseAdminNumbers("2125551234, +1 (347) 555-0000 ,junk")).toEqual(["+12125551234", "+13475550000"]);
  });
});

describe("keywords", () => {
  it.each(["STOP", "stop", "Stop.", " StopAll ", "UNSUBSCRIBE", "cancel", "End", "quit!"])("%s is opt-out", (t) =>
    expect(classifyKeyword(t)).toBe("opt_out"),
  );
  it.each(["START", "unstop"])("%s is opt-in", (t) => expect(classifyKeyword(t)).toBe("opt_in"));
  it.each(["HELP", "info", "Help?"])("%s is help", (t) => expect(classifyKeyword(t)).toBe("help"));
  it.each(["please stop texting me", "stopp", "thanks", "", "helpful"])("%s is not a keyword", (t) =>
    expect(classifyKeyword(t)).toBeNull(),
  );
});

describe("admin command parsing", () => {
  it("recognizes commands", () => {
    expect(isCommand("#count")).toBe(true);
    expect(isCommand("  #count")).toBe(true);
    expect(isCommand("Bus at 7 #late")).toBe(false);
  });
  it("#add with name", () =>
    expect(parseCommand("#add 2125551234 Moshe")).toEqual({ kind: "add", phone: "+12125551234", name: "Moshe" }));
  it("#add with formatted number and two-word name", () =>
    expect(parseCommand("#ADD (212) 555-1234  Moshe   Levi")).toEqual({ kind: "add", phone: "+12125551234", name: "Moshe Levi" }));
  it("#add without a name", () => expect(parseCommand("#add 2125551234")).toEqual({ kind: "add", phone: "+12125551234", name: "" }));
  it("# add with a space after #", () => expect(parseCommand("# add 2125551234 Avi").kind).toBe("add"));
  it("#add with bad number is an error", () => expect(parseCommand("#add 555 Moshe").kind).toBe("error"));
  it("#add with no number is an error", () => expect(parseCommand("#add Moshe").kind).toBe("error"));
  it("#remove", () => expect(parseCommand("#remove 212-555-1234")).toEqual({ kind: "remove", phone: "+12125551234" }));
  it("#remove bad", () => expect(parseCommand("#remove").kind).toBe("error"));
  it.each(["count", "cancel", "help"])("#%s", (c) => expect(parseCommand(`#${c}`).kind).toBe(c));
  it("is case-insensitive", () => expect(parseCommand("#COUNT").kind).toBe("count"));
  it("unknown command is an error that names it", () => {
    const c = parseCommand("#hello everyone");
    expect(c.kind).toBe("error");
    expect(c.kind === "error" && c.message).toContain("#hello");
  });
  it("help text fits in one SMS", () => {
    expect(HELP_TEXT.length).toBeLessThanOrEqual(160);
    expect(countSegments(HELP_TEXT)).toEqual({ encoding: "GSM-7", segments: 1 });
  });
});

describe("segments", () => {
  it("plain short text is 1", () => expect(countSegments("Bus leaves at 7:30.")).toEqual({ encoding: "GSM-7", segments: 1 }));
  it("160 plain chars is 1, 161 is 2", () => {
    expect(countSegments("a".repeat(160)).segments).toBe(1);
    expect(countSegments("a".repeat(161)).segments).toBe(2);
    expect(countSegments("a".repeat(306)).segments).toBe(2);
    expect(countSegments("a".repeat(307)).segments).toBe(3);
  });
  it("extended chars count double", () => expect(countSegments("{".repeat(81)).segments).toBe(2));
  it("emoji switches to UCS-2", () => expect(countSegments("Mazel tov 🎉")).toEqual({ encoding: "UCS-2", segments: 1 }));
  it("Hebrew over 70 is 2+", () => expect(countSegments("ש".repeat(71))).toEqual({ encoding: "UCS-2", segments: 2 }));
  it("smart quotes are not GSM", () => expect(countSegments("It’s on").encoding).toBe("UCS-2"));
});

describe("batching and caps", () => {
  it("sends a full batch when under the cap", () => expect(batchLimit(15, 1, 1000)).toBe(15));
  it("long messages send fewer people per minute", () => expect(batchLimit(15, 2, 1000)).toBe(7));
  it("very long messages still send at least 1", () => expect(batchLimit(15, 20, 1000)).toBe(1));
  it("stops at the cap", () => {
    expect(batchLimit(15, 1, 4)).toBe(4);
    expect(batchLimit(15, 1, 0)).toBe(0);
    expect(batchLimit(15, 1, -3)).toBe(0);
  });
  it("backs off 30s, 60s, 120s", () => expect([1, 2, 3].map(backoffMs)).toEqual([30_000, 60_000, 120_000]));
  it("day rolls over at local midnight", () => {
    expect(dayKey(new Date("2026-10-12T03:59:00Z"), "America/New_York")).toBe("2026-10-11");
    expect(dayKey(new Date("2026-10-12T04:00:00Z"), "America/New_York")).toBe("2026-10-12");
  });
});

describe("config", () => {
  it("DRY_RUN defaults to on unless explicitly false", () => {
    const db = makeDb();
    expect(loadConfig(makeEnv(db, { DRY_RUN: undefined })).dryRun).toBe(true);
    expect(loadConfig(makeEnv(db, { DRY_RUN: "maybe" })).dryRun).toBe(true);
    expect(loadConfig(makeEnv(db, { DRY_RUN: "false" })).dryRun).toBe(false);
  });
  it("welcome text matches the spec and fits one SMS", () => {
    const cfg = loadConfig(makeEnv(makeDb()));
    expect(welcomeText(cfg)).toBe(
      "Yeshiva Boys: You're on the announcement list from Rabbi Cohen. About 20-30 texts a month. Reply HELP for help, STOP to opt out.",
    );
    expect(countSegments(welcomeText(cfg)).segments).toBe(1);
  });
});
