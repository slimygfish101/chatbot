// SQL for importing members (and optionally queueing their welcome text).
import { countSegments } from "../src/segments";

/** SQL string literal. */
export const sql = (v: string | null | undefined) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

/**
 * - New numbers are added as active.
 * - Existing names are updated; a member the admin removed is re-activated.
 * - Anyone who texted STOP stays opted out.
 * - With a welcome body: one welcome job for listed members who are active,
 *   never welcomed, and not already waiting in another welcome job.
 */
export function buildImportSql(rows: { name: string; phone: string }[], nowIso: string, welcomeBody?: string): string[] {
  const statements = rows.map(
    (r) =>
      `INSERT INTO members (phone, name, status, added_at, updated_at) VALUES (${sql(r.phone)}, ${sql(r.name)}, 'active', ${sql(nowIso)}, ${sql(nowIso)})
       ON CONFLICT(phone) DO UPDATE SET
         name = CASE WHEN excluded.name = '' THEN members.name ELSE excluded.name END,
         status = CASE WHEN members.status = 'removed' THEN 'active' ELSE members.status END,
         updated_at = excluded.updated_at;`,
  );
  if (welcomeBody && rows.length) {
    const seg = countSegments(welcomeBody);
    const phones = rows.map((r) => sql(r.phone)).join(",");
    statements.push(
      `INSERT INTO jobs (kind, admin_phone, body, status, segments, encoding, created_at)
       VALUES ('welcome', NULL, ${sql(welcomeBody)}, 'draft', ${seg.segments}, ${sql(seg.encoding)}, ${sql(nowIso)});`,
      `INSERT INTO job_recipients (job_id, phone) SELECT (SELECT MAX(id) FROM jobs WHERE kind = 'welcome' AND status = 'draft'), phone
       FROM members WHERE status = 'active' AND welcomed_at IS NULL AND phone IN (${phones})
       AND phone NOT IN (SELECT r.phone FROM job_recipients r JOIN jobs j ON j.id = r.job_id
                         WHERE j.kind = 'welcome' AND j.status IN ('queued', 'sending'));`,
      `UPDATE jobs SET status = CASE WHEN EXISTS (SELECT 1 FROM job_recipients WHERE job_id = jobs.id) THEN 'queued' ELSE 'done' END,
         finished_at = CASE WHEN EXISTS (SELECT 1 FROM job_recipients WHERE job_id = jobs.id) THEN NULL ELSE created_at END
       WHERE kind = 'welcome' AND status = 'draft';`,
    );
  }
  return statements;
}
