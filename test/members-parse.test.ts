import { describe, expect, it } from "vitest";
import { parseMemberList, toCsv } from "../scripts/members-parse";

describe("member list cleanup", () => {
  it("handles CSV with a header", () => {
    const r = parseMemberList("name,phone\nMoshe Cohen,2125551234\n\"Levi, Avi\",(718) 555-2222\n");
    expect(r.rows.map(({ name, phone }) => ({ name, phone }))).toEqual([
      { name: "Moshe Cohen", phone: "+12125551234" },
      { name: "Levi Avi", phone: "+17185552222" },
    ]);
    expect(r.flags).toEqual([]);
  });

  it("handles pasted text in mixed formats, number first or last", () => {
    const r = parseMemberList(
      ["Moshe - 212.555.1234", "718-555-2222 Yossi K", "Dovid\t+1 (347) 555 3333", "Shmuli: 1-646-555-4444", "  "].join("\n"),
    );
    expect(r.rows.map((x) => [x.name, x.phone])).toEqual([
      ["Moshe", "+12125551234"],
      ["Yossi K", "+17185552222"],
      ["Dovid", "+13475553333"],
      ["Shmuli", "+16465554444"],
    ]);
  });

  it("flags bad, toll-free, fake, duplicate and nameless entries", () => {
    const r = parseMemberList(
      [
        "name,phone",
        "Short 555-1234",
        "Tollfree 800-555-2000",
        "Fake 212-555-0123",
        "UK +44 20 7123 4567",
        "Moshe 2125551234",
        "Moshe again 212 555 1234",
        "7185559999",
        "Two numbers 2125551111 7185552020",
      ].join("\n"),
    );
    expect(r.rows.map((x) => x.phone)).toEqual(["+12125551234", "+17185559999", "+12125551111"]);
    const problems = r.flags.map((f) => `${f.line}: ${f.problem}`);
    expect(problems).toEqual([
      "2: doesn't look like a US phone number",
      "3: toll-free number, not a cell phone; skipped",
      "4: 555-01xx is a fake (example) number; skipped",
      "5: doesn't look like a US phone number",
      "7: same number as line 6; skipped",
      "8: no name; added without one",
      "9: more than one number on this line; used the first",
    ]);
  });

  it("writes a clean CSV", () => {
    expect(toCsv([{ name: 'A "B", C', phone: "+12125551234" }])).toBe('name,phone\n"A ""B"", C",+12125551234\n');
  });
});
