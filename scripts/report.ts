// Shows the most recent blast and who it went (or would have gone) to.
//   npm run report            (add --local for the local test database)
import { d1Rows, wrangler } from "./lib";

const where = process.argv.includes("--local") ? "--local" : "--remote";
const q = (sqlText: string): any[] => {
  const r = wrangler(["d1", "execute", "text-blast-db", where, "--json", "--command", sqlText], { quiet: true });
  return d1Rows(r);
};

const [job] = q("SELECT id, kind, status, body, segments, created_at, finished_at FROM jobs WHERE status != 'draft' ORDER BY id DESC LIMIT 1");
if (!job) {
  console.log("No blasts yet.");
  process.exit(0);
}
console.log(`Blast #${job.id} (${job.kind}) — ${job.status}, created ${job.created_at}${job.finished_at ? `, finished ${job.finished_at}` : ""}`);
console.log(`Text (${job.segments} text${job.segments > 1 ? "s" : ""} per person): ${job.body}\n`);
const people = q(
  `SELECT COALESCE(m.name, '') AS name, substr(r.phone, -4) AS last4, r.status, COALESCE(r.delivery, '') AS delivery, COALESCE(r.error, '') AS error
   FROM job_recipients r LEFT JOIN members m ON m.phone = r.phone WHERE r.job_id = ${Number(job.id)} ORDER BY m.name`,
);
for (const p of people) console.log(`  ${p.name.padEnd(24)} …${p.last4}  ${p.status}${p.delivery ? ` / ${p.delivery}` : ""}${p.error ? `  (${p.error})` : ""}`);
const counts = people.reduce<Record<string, number>>((a, p) => ((a[p.status] = (a[p.status] ?? 0) + 1), a), {});
console.log(`\n${people.length} recipients: ${JSON.stringify(counts)}`);
