// Import a member list.
//
//   npm run import -- list.txt                 preview only: cleans the list, shows problems
//   npm run import -- list.txt --apply         save to the live database
//   npm run import -- list.txt --apply --welcome   also queue the welcome text to new members
//   add --local to use the local test database instead
//
// Nobody already opted out (STOP) is re-activated by an import.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { welcomeText, type Config } from "../src/config";
import { buildImportSql } from "./import-sql";
import { die, ROOT, tomlVar, wrangler } from "./lib";
import { maskLine, parseMemberList, toCsv } from "./members-parse";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) die("Usage: npm run import -- <file> [--apply] [--welcome] [--local]");

const { rows, flags } = parseMemberList(readFileSync(file, "utf8"));
const cleanPath = join(ROOT, "setup", "members.clean.csv");
writeFileSync(cleanPath, toCsv(rows));

console.log(`\n${rows.length} members ready. Clean list saved to setup/members.clean.csv`);
if (flags.length) {
  console.log(`\n${flags.length} line(s) need a look:`);
  for (const f of flags) console.log(`  line ${f.line}: ${maskLine(f.problem)}\n      ${maskLine(f.text)}`);
}

if (!args.includes("--apply")) {
  console.log("\nPreview only. Nothing saved. Add --apply to save.");
  process.exit(0);
}

const now = new Date().toISOString();
let welcomeBody: string | undefined;
if (args.includes("--welcome") && rows.length) {
  const cfg = { groupName: tomlVar("GROUP_NAME"), adminName: tomlVar("ADMIN_NAME") } as Config;
  if (!cfg.groupName || cfg.groupName.startsWith("REPLACE")) die("Set GROUP_NAME/ADMIN_NAME first (npm run deploy does it).");
  welcomeBody = welcomeText(cfg);
}
const statements = buildImportSql(rows, now, welcomeBody);

// The SQL holds phone numbers, so it lives only briefly in a private temp folder.
const tmpDir = mkdtempSync(join(tmpdir(), "textblast-import-"));
const tmp = join(tmpDir, "import.sql");
writeFileSync(tmp, statements.join("\n"), { mode: 0o600 });
const result = wrangler(["d1", "execute", "text-blast-db", args.includes("--local") ? "--local" : "--remote", "--file", tmp], {
  allowFail: true,
});
rmSync(tmpDir, { recursive: true, force: true });
if (!result.ok) die(`Import failed:\n${result.out}`);
console.log(`\nSaved ${rows.length} members.${args.includes("--welcome") ? " Welcome texts are queued and go out about 15 a minute." : ""}`);
