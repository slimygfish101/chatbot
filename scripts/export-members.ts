// Saves the full member list to setup/members-export.csv.
//   npm run export            (add --local for the local test database)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { d1Rows, ROOT, wrangler } from "./lib";

const where = process.argv.includes("--local") ? "--local" : "--remote";
const r = wrangler(
  ["d1", "execute", "text-blast-db", where, "--json", "--command", "SELECT name, phone, status, added_at, welcomed_at FROM members ORDER BY status, name"],
  { quiet: true },
);
const results: any[] = d1Rows(r);
const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = ["name,phone,status,added_at,welcomed_at", ...results.map((m) => [m.name, m.phone, m.status, m.added_at, m.welcomed_at].map(esc).join(","))];
const out = join(ROOT, "setup", "members-export.csv");
writeFileSync(out, csv.join("\n") + "\n");
const counts = results.reduce<Record<string, number>>((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {});
console.log(`Saved ${results.length} members to setup/members-export.csv  ${JSON.stringify(counts)}`);
