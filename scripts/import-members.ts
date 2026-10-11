// Import a member list.
//
//   npm run import -- list.txt                 preview only: cleans the list, shows problems
//   npm run import -- list.txt --apply         save to the live database
//   npm run import -- list.txt --apply --welcome   also queue the welcome text to new members
//   add --local to use the local test database instead
//
// Nobody already opted out (STOP) is re-activated by an import.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { welcomeText, type Config } from "../src/config";
import { countSegments } from "../src/segments";
import { die, ROOT, sql, tomlVar, wrangler } from "./lib";
import { parseMemberList, toCsv } from "./members-parse";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) die("Usage: npm run import -- <file> [--apply] [--welcome] [--local]");

const { rows, flags } = parseMemberList(readFileSync(file, "utf8"));
const cleanPath = join(ROOT, "setup", "members.clean.csv");
writeFileSync(cleanPath, toCsv(rows));

console.log(`\n${rows.length} members ready. Clean list saved to setup/members.clean.csv`);
if (flags.length) {
  console.log(`\n${flags.length} line(s) need a look:`);
  for (const f of flags) console.log(`  line ${f.line}: ${f.problem}\n      ${f.text.replace(/\d(?=\d{4})/g, "•")}`);
}

if (!args.includes("--apply")) {
  console.log("\nPreview only. Nothing saved. Add --apply to save.");
  process.exit(0);
}

const now = new Date().toISOString();
const statements: string[] = rows.map(
  (r) =>
    `INSERT INTO members (phone, name, status, added_at, updated_at) VALUES (${sql(r.phone)}, ${sql(r.name)}, 'active', ${sql(now)}, ${sql(now)})
     ON CONFLICT(phone) DO UPDATE SET
       name = CASE WHEN excluded.name = '' THEN members.name ELSE excluded.name END,
       status = CASE WHEN members.status = 'removed' THEN 'active' ELSE members.status END,
       updated_at = excluded.updated_at;`,
);

if (args.includes("--welcome") && rows.length) {
  const cfg = { groupName: tomlVar("GROUP_NAME"), adminName: tomlVar("ADMIN_NAME") } as Config;
  if (!cfg.groupName || cfg.groupName.startsWith("REPLACE")) die("Set GROUP_NAME/ADMIN_NAME first (npm run deploy does it).");
  const body = welcomeText(cfg);
  const seg = countSegments(body);
  const phones = rows.map((r) => sql(r.phone)).join(",");
  statements.push(
    `INSERT INTO jobs (kind, admin_phone, body, status, segments, encoding, created_at) VALUES ('welcome', NULL, ${sql(body)}, 'draft', ${seg.segments}, ${sql(seg.encoding)}, ${sql(now)});`,
    `INSERT INTO job_recipients (job_id, phone) SELECT (SELECT MAX(id) FROM jobs WHERE kind = 'welcome' AND status = 'draft'), phone
       FROM members WHERE status = 'active' AND welcomed_at IS NULL AND phone IN (${phones});`,
    `UPDATE jobs SET status = CASE WHEN EXISTS (SELECT 1 FROM job_recipients WHERE job_id = jobs.id) THEN 'queued' ELSE 'done' END
       WHERE kind = 'welcome' AND status = 'draft';`,
  );
}

// The SQL holds phone numbers, so it lives only briefly in the temp folder.
const tmp = join(tmpdir(), `import-${process.pid}.sql`);
writeFileSync(tmp, statements.join("\n"));
try {
  wrangler(["d1", "execute", "text-blast-db", args.includes("--local") ? "--local" : "--remote", "--file", tmp]);
} finally {
  rmSync(tmp, { force: true });
}
console.log(`\nSaved ${rows.length} members.${args.includes("--welcome") ? " Welcome texts are queued and go out about 15 a minute." : ""}`);
