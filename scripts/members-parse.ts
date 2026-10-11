// Turns a member list in almost any format (CSV, TSV, pasted text, "Name - number")
// into clean rows, and flags anything that needs a human look.
import { toE164 } from "../src/phone";

export interface CleanRow {
  name: string;
  phone: string;
  line: number;
}
export interface Flag {
  line: number;
  text: string;
  problem: string;
}
export interface ParseResult {
  rows: CleanRow[];
  flags: Flag[];
}

// A US phone number written any common way.
const PHONE_RE = /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}(?!\d)/g;
const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

export function parseMemberList(input: string): ParseResult {
  const rows: CleanRow[] = [];
  const flags: Flag[] = [];
  const seen = new Map<string, number>();

  input
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      const text = raw.trim();
      if (!text) return;
      const matches = [...text.matchAll(PHONE_RE)].filter((m) => !isPartOfLongerNumber(text, m));
      const digitCount = (text.match(/\d/g) ?? []).length;

      if (matches.length === 0) {
        // Header rows ("name,phone") and notes without numbers are skipped quietly.
        if (digitCount >= 7) flags.push({ line, text, problem: "doesn't look like a US phone number" });
        else if (!/^\W*(name|phone|cell|number|mobile)/i.test(text) && i > 0) flags.push({ line, text, problem: "no phone number on this line" });
        return;
      }

      const phone = toE164(matches[0][0]);
      if (!phone) {
        flags.push({ line, text, problem: "doesn't look like a US phone number" });
        return;
      }
      if (matches.length > 1) flags.push({ line, text, problem: "more than one number on this line; used the first" });

      const area = phone.slice(2, 5);
      const exchange = phone.slice(5, 8);
      const sub = phone.slice(8);
      if (TOLL_FREE.has(area)) {
        flags.push({ line, text, problem: "toll-free number, not a cell phone; skipped" });
        return;
      }
      if (area === "900" || area === "976") {
        flags.push({ line, text, problem: "premium-rate number; skipped" });
        return;
      }
      if (exchange === "555" && sub.startsWith("01")) {
        flags.push({ line, text, problem: "555-01xx is a fake (example) number; skipped" });
        return;
      }

      const name = cleanName(text.replace(matches[0][0], " "));
      if (seen.has(phone)) {
        flags.push({ line, text, problem: `same number as line ${seen.get(phone)}; skipped` });
        return;
      }
      seen.set(phone, line);
      if (!name) flags.push({ line, text, problem: "no name; added without one" });
      rows.push({ name, phone, line });
    });

  return { rows, flags };
}

function isPartOfLongerNumber(text: string, m: RegExpMatchArray): boolean {
  const before = text[(m.index ?? 0) - 1];
  return before !== undefined && /\d/.test(before);
}

function cleanName(s: string): string {
  return s
    .replace(/["']/g, "")
    .replace(/[,;\t|]+/g, " ")
    .replace(/\s[-–:]\s|^\s*[-–:]+|[-–:]+\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function toCsv(rows: { name: string; phone: string }[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["name,phone", ...rows.map((r) => `${esc(r.name)},${r.phone}`)].join("\n") + "\n";
}
