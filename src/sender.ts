import type { Config } from "./config";
import { preview, type Deps } from "./inbound";
import { log } from "./log";
import { mask } from "./phone";
import { countSegments } from "./segments";
import type { Job, JobCounts, RecipientResult } from "./store";
import { type SendResult, sendSms } from "./telnyx";

export const MAX_ATTEMPTS = 4;
/** Longest a sender run may hold the lock before another run may take over. */
const LOCK_TTL_MS = 5 * 60_000;
/** Minimum time between the starts of two batches (carrier limit is ~15 texts/minute). */
export const BATCH_GAP_MS = 55_000;
/** A recipient stuck mid-send longer than this belongs to a run that died. Must exceed LOCK_TTL_MS. */
const STALE_CLAIM_MS = 10 * 60_000;
/** How many minutes to wait for carrier delivery reports before sending the summary. */
const RECEIPT_WAITS = 2;
/** Summary send attempts before giving up on it. */
const SUMMARY_ATTEMPTS = 3;

/** Calendar day (YYYY-MM-DD) in the configured time zone, for the daily cap. */
export function dayKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Backoff before retry n (1-based): 30s, 60s, 120s. */
export function backoffMs(attempt: number): number {
  return 30_000 * 2 ** (attempt - 1);
}

/**
 * How many people to text this run. `batchSize` and `capLeft` are in texts
 * (segments); a 2-segment message reaches half as many people per run.
 */
export function batchLimit(batchSize: number, segments: number, capLeft: number): number {
  const seg = Math.max(1, segments);
  const perRun = Math.max(1, Math.floor(batchSize / seg));
  return Math.max(0, Math.min(perRun, Math.floor(capLeft / seg)));
}

/** Sends one text (admin reply, welcome, etc.) and counts it toward the daily total. */
export async function sendAndCount(cfg: Config, deps: Deps, to: string, text: string, day: string): Promise<SendResult> {
  const r = await sendSms(cfg, deps.fetch, to, text);
  if (r.ok && !cfg.dryRun) await deps.store.addDailyCount(day, countSegments(text).segments);
  if (!r.ok) log("send_failed", { to: mask(to), error: r.error });
  return r;
}

export function summaryText(job: Job, c: JobCounts, dryRun: boolean): string {
  const what = job.kind === "welcome" ? "Welcome texts: sent" : "Sent";
  const parts = [`${dryRun ? "DRY RUN (nothing really sent): " : ""}${what} to ${c.sent} of ${c.total}.`];
  if (c.failed) parts.push(`${c.failed} failed.`);
  if (c.skipped) parts.push(`${c.skipped} skipped (opted out or removed).`);
  if (job.segments > 1 || job.encoding !== "GSM-7") {
    const why = job.encoding !== "GSM-7" ? "Special characters" : "Long message";
    parts.push(`${why}: used ${job.segments} text${job.segments > 1 ? "s" : ""} per person.`);
  }
  return parts.join(" ");
}

function adminFor(cfg: Config, job: Job): string | null {
  return job.admin_phone ?? cfg.admins[0] ?? null;
}

function toResult(phone: string, attempts: number, res: SendResult, now: Date): RecipientResult {
  if (res.ok) return { phone, outcome: "sent", telnyxId: res.id };
  if (res.retryable && attempts < MAX_ATTEMPTS) {
    return { phone, outcome: "retry", attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)).toISOString(), error: res.error };
  }
  return { phone, outcome: "failed", attempts, error: res.error, optedOut: res.optedOut };
}

/**
 * Sends the next batch of the current blast. Runs once a minute from the cron
 * trigger. A lock stops two runs from overlapping, and after a run that sent
 * texts the lock stays closed for BATCH_GAP_MS, which paces the batches.
 */
export async function runSender(cfg: Config, deps: Deps, scheduledMs?: number): Promise<string> {
  if (cfg.paused) return "paused";
  const { store } = deps;
  const lockToken = crypto.randomUUID();
  // Pace from the cron's scheduled minute, not the moment this run happened to
  // start, so a run that starts a few seconds late doesn't make the next one skip.
  const startMs = Math.min(scheduledMs ?? Infinity, deps.now().getTime());
  if (!(await store.acquireLock("sender", lockToken, startMs, LOCK_TTL_MS))) return "locked";

  let sentBatch = false;
  let cancelled = false;
  try {
    const now = deps.now();
    const nowIso = now.toISOString();
    const job = (await store.getSendingJob()) ?? (await store.startNextQueued(nowIso));
    if (!job) return "idle";

    // Never let a test-mode blast turn real (or a real one turn into a test) halfway.
    if (job.dry_run !== null && Boolean(job.dry_run) !== cfg.dryRun) {
      await store.cancelJob(job.id, nowIso);
      await store.skipUnsentClaims(job.id);
      const admin = adminFor(cfg, job);
      const mode = job.dry_run ? "test mode" : "live mode";
      if (admin) {
        await sendAndCount(cfg, deps, admin, `Stopped "${preview(job.body)}": it was started in ${mode} and the mode has changed. Send it again if needed.`, dayKey(now, cfg.timezone));
      }
      log("job_mode_changed", { job: job.id, jobDryRun: job.dry_run, dryRun: cfg.dryRun });
      return "mode_changed";
    }

    await store.tidyRecipients(job.id, new Date(now.getTime() - STALE_CLAIM_MS).toISOString());

    const day = dayKey(now, cfg.timezone);
    const capLeft = cfg.maxTextsPerDay - (await store.getDailyCount(day));
    const limit = batchLimit(cfg.batchSize, job.segments, capLeft);

    if (limit === 0) {
      const c = await store.jobCounts(job.id);
      if (c.pending > 0 && job.cap_notice_day !== day) {
        await store.setCapNoticeDay(job.id, day);
        const admin = adminFor(cfg, job);
        // Allowed past the cap on purpose: the admin must hear why sending stopped.
        if (admin) {
          await sendAndCount(
            cfg,
            deps,
            admin,
            `Daily limit of ${cfg.maxTextsPerDay} texts reached. Sent ${c.sent} of ${c.total} so far; the rest go out tomorrow. Text #cancel to stop it.`,
            day,
          );
        }
        log("daily_cap_reached", { job: job.id, sent: c.sent, total: c.total });
      }
      if (c.pending > 0) return "capped";
    } else {
      // Phone order matters: tidyRecipients relies on it after a crash.
      const due = (await store.claimDue(job.id, limit, nowIso)).sort((a, b) => (a.phone < b.phone ? -1 : 1));
      sentBatch = due.length > 0;
      // Count the whole batch against the daily cap up front and give back what
      // didn't go out at the end, so a run cut off mid-batch never under-counts.
      if (!cfg.dryRun) await store.addDailyCount(day, due.length * job.segments);
      let accepted = 0;
      for (const r of due) {
        const res = await sendSms(cfg, deps.fetch, r.phone, job.body);
        const result = toResult(r.phone, r.attempts + 1, res, now);
        if (res.ok) accepted++;
        else log("recipient_error", { job: job.id, to: mask(r.phone), attempt: r.attempts + 1, error: res.error });
        const jobStatus = await store.saveResult(job.id, result, nowIso);
        if (jobStatus !== "sending") {
          cancelled = true;
          await store.skipUnsentClaims(job.id);
          log("batch_stopped", { job: job.id, jobStatus });
          break;
        }
      }
      if (!cfg.dryRun) {
        await store.addDailyCount(day, (accepted - due.length) * job.segments);
        if (job.kind === "welcome") await store.markWelcomedFromJob(job.id, nowIso);
      }
      if (due.length) log("batch_sent", { job: job.id, tried: due.length, accepted, dryRun: cfg.dryRun });
      if (cancelled) return "cancelled";
    }

    const c = await store.jobCounts(job.id);
    if (c.pending > 0) return sentBatch ? "sent_batch" : "waiting";

    // Everyone's been tried. Give the carriers a minute or two to report delivery.
    if (!cfg.dryRun && c.awaitingReceipt > 0 && job.finish_waits < RECEIPT_WAITS) {
      await store.bumpJobCounter(job.id, "finish_waits");
      return "waiting_receipts";
    }

    const admin = adminFor(cfg, job);
    const text = summaryText(job, c, cfg.dryRun);
    const delivered = admin ? (await sendAndCount(cfg, deps, admin, text, day)).ok : true;
    if (!delivered && job.summary_attempts + 1 < SUMMARY_ATTEMPTS) {
      await store.bumpJobCounter(job.id, "summary_attempts");
      return "summary_retry";
    }
    await store.finishJob(job.id, nowIso);
    log("job_done", { job: job.id, ...c, summarySent: delivered, dryRun: cfg.dryRun });
    return "done";
  } finally {
    await store.releaseLock("sender", lockToken, sentBatch ? startMs + BATCH_GAP_MS : undefined);
  }
}
