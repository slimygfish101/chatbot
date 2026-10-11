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
  summary_attempts: number;
  finish_waits: number;
  /** 1 = created in test mode, 0 = live, null = before this was recorded. */
  dry_run: number | null;
}
export interface JobCounts {
  total: number;
  /** Accepted by Telnyx and not reported undeliverable by the carrier. */
  sent: number;
  /** Failed to send, or the carrier reported it undeliverable. */
  failed: number;
  skipped: number;
  /** Still to send (pending) or being sent right now. */
  pending: number;
  /** Of `pending`, how many are mid-send. */
  inFlight: number;
  /** Sent, but no delivery report from the carrier yet. */
  awaitingReceipt: number;
}

/** Telnyx's final statuses that mean the text didn't arrive. */
export const UNDELIVERED = ["sending_failed", "delivery_failed"];
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

  /** #remove: takes him off the list. If he had texted STOP, a later START won't put him back on. */
  async removeMember(phone: string, nowIso: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE members SET
           status = CASE WHEN status = 'opted_out' THEN 'opted_out' ELSE 'removed' END,
           status_before_optout = CASE WHEN status = 'opted_out' THEN 'removed' ELSE status_before_optout END,
           updated_at = ?
         WHERE phone = ?`,
      )
      .bind(nowIso, phone)
      .run();
  }

  /**
   * #add of someone who texted STOP: we can't text him, but when he texts START
   * he goes straight onto the list (with this name).
   */
  async addAfterStart(phone: string, name: string, nowIso: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE members SET status_before_optout = 'active', name = CASE WHEN ?1 = '' THEN name ELSE ?1 END, updated_at = ?2
         WHERE phone = ?3 AND status = 'opted_out'`,
      )
      .bind(name, nowIso, phone)
      .run();
  }

  /**
   * Records a STOP from any number, member or not, so nothing (an #add, an
   * import) can text him again until he texts START himself.
   */
  async optOut(phone: string, nowIso: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO members (phone, name, status, added_at, updated_at) VALUES (?1, '', 'opted_out', ?2, ?2)
         ON CONFLICT(phone) DO UPDATE SET
           status_before_optout = CASE WHEN members.status = 'opted_out' THEN members.status_before_optout ELSE members.status END,
           status = 'opted_out', updated_at = ?2`,
      )
      .bind(phone, nowIso)
      .run();
  }

  /**
   * START/UNSTOP: puts an opted-out number back where it was before STOP.
   * A stranger (never on the list) becomes 'removed': allowed to be #added, not on the list.
   */
  async optIn(phone: string, nowIso: string): Promise<boolean> {
    const r = await this.db
      .prepare(
        `UPDATE members SET status = COALESCE(status_before_optout, 'removed'), status_before_optout = NULL, updated_at = ?
         WHERE phone = ? AND status = 'opted_out'`,
      )
      .bind(nowIso, phone)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }

  async markWelcomed(phone: string, nowIso: string): Promise<void> {
    await this.db.prepare("UPDATE members SET welcomed_at = ? WHERE phone = ?").bind(nowIso, phone).run();
  }

  /**
   * Counts for #count. "Opted out" only counts people who were on the list,
   * not strangers or admins whose STOP was recorded.
   */
  async countByStatus(): Promise<Record<MemberStatus, number>> {
    const { results } = await this.db
      .prepare(
        `SELECT CASE WHEN status = 'opted_out' AND COALESCE(status_before_optout, '') != 'active' THEN 'other' ELSE status END AS status,
           COUNT(*) AS n FROM members GROUP BY 1`,
      )
      .all<{ status: string; n: number }>();
    const out: Record<MemberStatus, number> = { active: 0, opted_out: 0, removed: 0 };
    for (const r of results) if (r.status in out) out[r.status as MemberStatus] = r.n;
    return out;
  }

  // ---- jobs ----

  /**
   * Creates a blast for every active member, in one transaction (all or nothing).
   * Returns the job id and recipient count.
   */
  async createBlastJob(
    adminPhone: string,
    body: string,
    segments: number,
    encoding: string,
    nowIso: string,
    sourceMessageId: string,
    dryRun: boolean,
  ): Promise<{ jobId: number; recipients: number }> {
    // D1 runs a batch as one transaction with no other writer in between,
    // so the job just inserted is MAX(id).
    const [job, recipients] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO jobs (kind, admin_phone, body, status, segments, encoding, created_at, source_message_id, dry_run)
           VALUES ('blast', ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .bind(adminPhone, body, segments, encoding, nowIso, sourceMessageId, dryRun ? 1 : 0),
      this.db.prepare(
        "INSERT INTO job_recipients (job_id, phone) SELECT (SELECT MAX(id) FROM jobs), phone FROM members WHERE status = 'active'",
      ),
      this.db.prepare(
        `UPDATE jobs SET status = 'done', finished_at = created_at, summary_attempts = 0
         WHERE id = (SELECT MAX(id) FROM jobs)
           AND NOT EXISTS (SELECT 1 FROM job_recipients WHERE job_id = jobs.id)`,
      ),
    ]);
    return { jobId: Number(job.meta.last_row_id), recipients: recipients.meta.changes ?? 0 };
  }

  /** Whether a blast from this admin message was saved (used after an unclear database error). */
  async blastExistsFor(sourceMessageId: string): Promise<boolean> {
    const r = await this.db
      .prepare("SELECT 1 AS x FROM jobs WHERE source_message_id = ? AND status != 'done'")
      .bind(sourceMessageId)
      .first();
    return r !== null;
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

  /**
   * The message #cancel should stop: the most recent one that still has texts
   * to send ("undo my last message"). Texting #cancel again stops the one
   * before it. A message whose texts have all gone out (only waiting for
   * delivery reports or its summary) is left alone.
   */
  getCancellableJob(): Promise<Job | null> {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('sending', 'queued')
           AND EXISTS (SELECT 1 FROM job_recipients WHERE job_id = jobs.id AND status IN ('pending', 'sending'))
         ORDER BY id DESC LIMIT 1`,
      )
      .first<Job>();
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

  async bumpJobCounter(jobId: number, column: "summary_attempts" | "finish_waits"): Promise<void> {
    await this.db.prepare(`UPDATE jobs SET ${column} = ${column} + 1 WHERE id = ?`).bind(jobId).run();
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
    const undelivered = UNDELIVERED.map((u) => `'${u}'`).join(",");
    const r = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(status = 'sent' AND COALESCE(delivery, '') NOT IN (${undelivered})) AS sent,
           SUM(status = 'failed' OR (status = 'sent' AND delivery IN (${undelivered}))) AS failed,
           SUM(status = 'skipped') AS skipped,
           SUM(status IN ('pending', 'sending')) AS pending,
           SUM(status = 'sending') AS inFlight,
           SUM(status = 'sent' AND delivery IS NULL) AS awaitingReceipt
         FROM job_recipients WHERE job_id = ?`,
      )
      .bind(jobId)
      .first<Record<keyof JobCounts, number | null>>();
    const n = (k: keyof JobCounts) => Number(r?.[k] ?? 0);
    return {
      total: n("total"),
      sent: n("sent"),
      failed: n("failed"),
      skipped: n("skipped"),
      pending: n("pending"),
      inFlight: n("inFlight"),
      awaitingReceipt: n("awaitingReceipt"),
    };
  }

  // ---- recipients ----

  /**
   * Housekeeping before a batch:
   * - anyone no longer active is skipped;
   * - if a run died mid-batch, its claimed recipients are still 'sending'. A run
   *   texts them in phone order and saves each result right away, so the lowest
   *   leftover number was the one in flight: it's marked failed rather than resent
   *   (nobody ever gets the same blast twice). The rest were never tried and go
   *   back to pending.
   */
  async tidyRecipients(jobId: number, staleBeforeIso: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE job_recipients SET status = 'failed', error = 'interrupted; not resent'
           WHERE job_id = ?1 AND status = 'sending' AND claimed_at < ?2
             AND phone = (SELECT MIN(r2.phone) FROM job_recipients r2
                          WHERE r2.job_id = ?1 AND r2.status = 'sending' AND r2.claimed_at = job_recipients.claimed_at)`,
        )
        .bind(jobId, staleBeforeIso),
      this.db
        .prepare("UPDATE job_recipients SET status = 'pending', claimed_at = NULL WHERE job_id = ? AND status = 'sending' AND claimed_at < ?")
        .bind(jobId, staleBeforeIso),
      // After the recovery above, so a recovered recipient who was removed meanwhile is skipped too.
      this.db
        .prepare(
          `UPDATE job_recipients SET status = 'skipped', error = 'not active'
           WHERE job_id = ? AND status = 'pending'
             AND phone NOT IN (SELECT phone FROM members WHERE status = 'active')`,
        )
        .bind(jobId),
      // A welcome job never welcomes someone twice (e.g. the admin #added him meanwhile).
      this.db
        .prepare(
          `UPDATE job_recipients SET status = 'skipped', error = 'already welcomed'
           WHERE job_id = ?1 AND status = 'pending' AND (SELECT kind FROM jobs WHERE id = ?1) = 'welcome'
             AND phone IN (SELECT phone FROM members WHERE welcomed_at IS NOT NULL)`,
        )
        .bind(jobId),
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

  /**
   * Saves one recipient's result right after his send, so a run that's cut off
   * loses at most the one text in flight. Returns the job's status, so the
   * sender notices a #cancel between texts.
   */
  async saveResult(jobId: number, r: RecipientResult, nowIso: string): Promise<string> {
    const jobStatus = "(SELECT status FROM jobs WHERE id = job_recipients.job_id) AS job_status";
    let stmt: D1PreparedStatement;
    if (r.outcome === "sent") {
      stmt = this.db
        .prepare(
          `UPDATE job_recipients SET status = 'sent', attempts = attempts + 1, telnyx_id = ?, error = NULL
           WHERE job_id = ? AND phone = ? RETURNING ${jobStatus}`,
        )
        .bind(r.telnyxId, jobId, r.phone);
    } else if (r.outcome === "retry") {
      stmt = this.db
        .prepare(
          `UPDATE job_recipients SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?
           WHERE job_id = ? AND phone = ? RETURNING ${jobStatus}`,
        )
        .bind(r.attempts, r.nextAttemptAt, r.error, jobId, r.phone);
    } else {
      stmt = this.db
        .prepare(`UPDATE job_recipients SET status = 'failed', attempts = ?, error = ? WHERE job_id = ? AND phone = ? RETURNING ${jobStatus}`)
        .bind(r.attempts, r.error, jobId, r.phone);
    }
    if (r.outcome === "failed" && r.optedOut) {
      // Telnyx says he texted STOP: record it like an inbound STOP.
      await this.optOut(r.phone, nowIso);
    }
    const row = await stmt.first<{ job_status: string }>();
    return row?.job_status ?? "unknown";
  }

  /** After a #cancel mid-batch: the claimed texts this run didn't get to are skipped. */
  async skipUnsentClaims(jobId: number): Promise<void> {
    await this.db
      .prepare("UPDATE job_recipients SET status = 'skipped', error = 'cancelled' WHERE job_id = ? AND status = 'sending'")
      .bind(jobId)
      .run();
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

  /** True the first time this number asks for HELP today. */
  async firstHelpToday(phone: string, day: string): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO help_replies (phone, day) VALUES (?, ?)").bind(phone, day).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Lets him ask again today (used when the HELP reply failed to send). */
  async forgetHelp(phone: string, day: string): Promise<void> {
    await this.db.prepare("DELETE FROM help_replies WHERE phone = ? AND day = ?").bind(phone, day).run();
  }

  // ---- daily cap ----

  async getDailyCount(day: string): Promise<number> {
    const r = await this.db.prepare("SELECT count FROM daily_counts WHERE day = ?").bind(day).first<{ count: number }>();
    return r?.count ?? 0;
  }

  /** Adds to (or, with a negative n, gives back to) the day's text count. */
  async addDailyCount(day: string, n: number): Promise<void> {
    if (n === 0) return;
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

  /**
   * Releases the lock. `holdUntilMs` keeps it closed until then, which is how
   * batches are spaced at least a minute apart.
   */
  async releaseLock(name: string, token: string, holdUntilMs?: number): Promise<void> {
    if (holdUntilMs) {
      await this.db.prepare("UPDATE locks SET until = ? WHERE name = ? AND token = ?").bind(holdUntilMs, name, token).run();
    } else {
      await this.db.prepare("DELETE FROM locks WHERE name = ? AND token = ?").bind(name, token).run();
    }
  }
}
