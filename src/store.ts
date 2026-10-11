// All database access lives here.

export type MemberStatus = "active" | "opted_out" | "removed";
export interface Member {
  phone: string;
  name: string;
  status: MemberStatus;
  added_at: string;
  welcomed_at: string | null;
}
export interface Job {
  id: number;
  kind: "blast" | "welcome";
  admin_phone: string | null;
  body: string;
  status: "draft" | "queued" | "sending" | "done" | "cancelled";
  segments: number;
  encoding: string;
  cap_notice_day: string | null;
}
export interface JobCounts {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
}
export type RecipientResult =
  | { phone: string; outcome: "sent"; telnyxId: string }
  | { phone: string; outcome: "retry"; attempts: number; nextAttemptAt: string; error: string }
  | { phone: string; outcome: "failed"; attempts: number; error: string; optedOut: boolean };

export class Store {
  constructor(private db: D1Database) {}

  // ---- dedupe ----

  /** Records an inbound message id. Returns false if we've already seen it. */
  async markProcessed(messageId: string, nowIso: string): Promise<boolean> {
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO processed_messages (message_id, received_at) VALUES (?, ?)")
      .bind(messageId, nowIso)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  // ---- members ----

  getMember(phone: string): Promise<Member | null> {
    return this.db.prepare("SELECT * FROM members WHERE phone = ?").bind(phone).first<Member>();
  }

  async upsertActive(phone: string, name: string, nowIso: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO members (phone, name, status, added_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)
         ON CONFLICT(phone) DO UPDATE SET status = 'active',
           name = CASE WHEN ?2 = '' THEN members.name ELSE ?2 END, updated_at = ?3`,
      )
      .bind(phone, name, nowIso)
      .run();
  }

  async setName(phone: string, name: string, nowIso: string): Promise<void> {
    await this.db.prepare("UPDATE members SET name = ?, updated_at = ? WHERE phone = ?").bind(name, nowIso, phone).run();
  }

  async setStatus(phone: string, status: MemberStatus, nowIso: string, onlyIf?: MemberStatus): Promise<boolean> {
    const sql = onlyIf
      ? "UPDATE members SET status = ?, updated_at = ? WHERE phone = ? AND status = ?"
      : "UPDATE members SET status = ?, updated_at = ? WHERE phone = ?";
    const stmt = this.db.prepare(sql);
    const r = await (onlyIf ? stmt.bind(status, nowIso, phone, onlyIf) : stmt.bind(status, nowIso, phone)).run();
    return (r.meta.changes ?? 0) > 0;
  }

  async markWelcomed(phone: string, nowIso: string): Promise<void> {
    await this.db.prepare("UPDATE members SET welcomed_at = ? WHERE phone = ?").bind(nowIso, phone).run();
  }

  async countByStatus(): Promise<Record<MemberStatus, number>> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM members GROUP BY status")
      .all<{ status: MemberStatus; n: number }>();
    const out: Record<MemberStatus, number> = { active: 0, opted_out: 0, removed: 0 };
    for (const r of results) out[r.status] = r.n;
    return out;
  }

  // ---- jobs ----

  /** Creates a blast for every active member. Returns the job id and recipient count. */
  async createBlastJob(
    adminPhone: string,
    body: string,
    segments: number,
    encoding: string,
    nowIso: string,
  ): Promise<{ jobId: number; recipients: number }> {
    const job = await this.db
      .prepare(
        `INSERT INTO jobs (kind, admin_phone, body, status, segments, encoding, created_at)
         VALUES ('blast', ?, ?, 'draft', ?, ?, ?) RETURNING id`,
      )
      .bind(adminPhone, body, segments, encoding, nowIso)
      .first<{ id: number }>();
    const jobId = job!.id;
    const ins = await this.db
      .prepare("INSERT INTO job_recipients (job_id, phone) SELECT ?, phone FROM members WHERE status = 'active'")
      .bind(jobId)
      .run();
    const recipients = ins.meta.changes ?? 0;
    await this.db
      .prepare("UPDATE jobs SET status = ? WHERE id = ?")
      .bind(recipients > 0 ? "queued" : "done", jobId)
      .run();
    return { jobId, recipients };
  }

  /** Number of jobs ahead of this one (sending or queued earlier). */
  async jobsAhead(jobId: number): Promise<number> {
    const r = await this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE id < ? AND status IN ('queued','sending')")
      .bind(jobId)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  getSendingJob(): Promise<Job | null> {
    return this.db.prepare("SELECT * FROM jobs WHERE status = 'sending' ORDER BY id LIMIT 1").first<Job>();
  }

  async countQueued(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Moves the oldest queued job to 'sending' and returns it. */
  async startNextQueued(nowIso: string): Promise<Job | null> {
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'sending', started_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1)
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE status = 'sending')
         RETURNING *`,
      )
      .bind(nowIso)
      .first<Job>();
  }

  async setCapNoticeDay(jobId: number, day: string): Promise<void> {
    await this.db.prepare("UPDATE jobs SET cap_notice_day = ? WHERE id = ?").bind(day, jobId).run();
  }

  /** Marks the job finished. Returns false if it wasn't 'sending' (e.g. cancelled meanwhile). */
  async finishJob(jobId: number, nowIso: string): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ? AND status = 'sending'")
      .bind(nowIso, jobId)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async cancelJob(jobId: number, nowIso: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status IN ('queued','sending')")
        .bind(nowIso, jobId),
      this.db
        .prepare("UPDATE job_recipients SET status = 'skipped', error = 'cancelled' WHERE job_id = ? AND status = 'pending'")
        .bind(jobId),
    ]);
  }

  async jobCounts(jobId: number): Promise<JobCounts> {
    const { results } = await this.db
      .prepare("SELECT status, COUNT(*) AS n FROM job_recipients WHERE job_id = ? GROUP BY status")
      .bind(jobId)
      .all<{ status: string; n: number }>();
    const c: JobCounts = { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
    for (const r of results) {
      c.total += r.n;
      if (r.status === "sent") c.sent += r.n;
      else if (r.status === "failed") c.failed += r.n;
      else if (r.status === "skipped") c.skipped += r.n;
      else c.pending += r.n; // pending or sending
    }
    return c;
  }

  // ---- recipients ----

  /**
   * Housekeeping before a batch: anyone no longer active is skipped, and any
   * recipient stuck in 'sending' (a run that crashed mid-send) is marked failed
   * rather than resent, so nobody ever gets the same blast twice.
   */
  async tidyRecipients(jobId: number, staleBeforeIso: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE job_recipients SET status = 'skipped', error = 'not active'
           WHERE job_id = ? AND status = 'pending'
             AND phone NOT IN (SELECT phone FROM members WHERE status = 'active')`,
        )
        .bind(jobId),
      this.db
        .prepare(
          `UPDATE job_recipients SET status = 'failed', error = 'interrupted; not resent'
           WHERE job_id = ? AND status = 'sending' AND claimed_at < ?`,
        )
        .bind(jobId, staleBeforeIso),
    ]);
  }

  /** Claims up to `limit` recipients that are due now, marking them 'sending'. */
  async claimDue(jobId: number, limit: number, nowIso: string): Promise<{ phone: string; attempts: number }[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE job_recipients SET status = 'sending', claimed_at = ?1
         WHERE job_id = ?2 AND phone IN (
           SELECT phone FROM job_recipients
           WHERE job_id = ?2 AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
           ORDER BY phone LIMIT ?3)
         RETURNING phone, attempts`,
      )
      .bind(nowIso, jobId, limit)
      .all<{ phone: string; attempts: number }>();
    return results;
  }

  async saveResults(jobId: number, results: RecipientResult[], nowIso: string): Promise<void> {
    if (results.length === 0) return;
    const stmts: D1PreparedStatement[] = [];
    for (const r of results) {
      if (r.outcome === "sent") {
        stmts.push(
          this.db
            .prepare(
              "UPDATE job_recipients SET status = 'sent', attempts = attempts + 1, telnyx_id = ?, error = NULL WHERE job_id = ? AND phone = ?",
            )
            .bind(r.telnyxId, jobId, r.phone),
        );
      } else if (r.outcome === "retry") {
        stmts.push(
          this.db
            .prepare(
              "UPDATE job_recipients SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ? WHERE job_id = ? AND phone = ?",
            )
            .bind(r.attempts, r.nextAttemptAt, r.error, jobId, r.phone),
        );
      } else {
        stmts.push(
          this.db
            .prepare("UPDATE job_recipients SET status = 'failed', attempts = ?, error = ? WHERE job_id = ? AND phone = ?")
            .bind(r.attempts, r.error, jobId, r.phone),
        );
        if (r.optedOut) {
          stmts.push(
            this.db
              .prepare("UPDATE members SET status = 'opted_out', updated_at = ? WHERE phone = ? AND status = 'active'")
              .bind(nowIso, r.phone),
          );
        }
      }
    }
    await this.db.batch(stmts);
  }

  async markWelcomedFromJob(jobId: number, nowIso: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE members SET welcomed_at = ? WHERE welcomed_at IS NULL
         AND phone IN (SELECT phone FROM job_recipients WHERE job_id = ? AND status = 'sent')`,
      )
      .bind(nowIso, jobId)
      .run();
  }

  async recordDelivery(telnyxId: string, status: string): Promise<void> {
    await this.db.prepare("UPDATE job_recipients SET delivery = ? WHERE telnyx_id = ?").bind(status, telnyxId).run();
  }

  // ---- daily cap ----

  async getDailyCount(day: string): Promise<number> {
    const r = await this.db.prepare("SELECT count FROM daily_counts WHERE day = ?").bind(day).first<{ count: number }>();
    return r?.count ?? 0;
  }

  async addDailyCount(day: string, n: number): Promise<void> {
    if (n <= 0) return;
    await this.db
      .prepare("INSERT INTO daily_counts (day, count) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET count = count + ?2")
      .bind(day, n)
      .run();
  }

  // ---- lock ----

  async acquireLock(name: string, token: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `INSERT INTO locks (name, token, until) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET token = ?2, until = ?3 WHERE locks.until < ?4`,
      )
      .bind(name, token, nowMs + ttlMs, nowMs)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async releaseLock(name: string, token: string): Promise<void> {
    await this.db.prepare("DELETE FROM locks WHERE name = ? AND token = ?").bind(name, token).run();
  }
}
