import type { Config } from "./config";
import type { Deps } from "./inbound";
import { log } from "./log";
import { mask } from "./phone";
import type { Job, RecipientResult } from "./store";
import { type SendResult, sendSms } from "./telnyx";

export const MAX_ATTEMPTS = 4;
const LOCK_TTL_MS = 55_000;
const STALE_CLAIM_MS = 5 * 60_000;

/** Calendar day (YYYY-MM-DD) in the configured time zone, for the daily cap. */
export function dayKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Backoff before retry n (1-based): 30s, 60s, 120s. */
export function backoffMs(attempt: number): number {
  return 30_000 * 2 ** (attempt - 1);
}

/** How many recipients to send to this run, given the cap and texts-per-person. */
export function batchLimit(batchSize: number, segments: number, capLeft: number): number {
  const perRun = Math.max(1, Math.floor(batchSize / Math.max(1, segments)));
  return Math.max(0, Math.min(perRun, capLeft));
}

/** Sends one text (admin reply, welcome, etc.) and counts it toward the daily total. */
export async function sendAndCount(cfg: Config, deps: Deps, to: string, text: string, day: string): Promise<SendResult> {
  const r = await sendSms(cfg, deps.fetch, to, text);
  if (r.ok) await deps.store.addDailyCount(day, 1);
  else log("send_failed", { to: mask(to), error: r.error });
  return r;
}

export function summaryText(job: Job, c: { total: number; sent: number; failed: number; skipped: number }, dryRun: boolean): string {
  const what = job.kind === "welcome" ? "Welcome texts: sent" : "Sent";
  const parts = [`${dryRun ? "DRY RUN (nothing really sent): " : ""}${what} to ${c.sent} of ${c.total}.`];
  if (c.failed) parts.push(`${c.failed} failed.`);
  if (c.skipped) parts.push(`${c.skipped} skipped (opted out or removed).`);
  if (job.segments > 1) parts.push(`Long or special characters: used ${job.segments} texts per person.`);
  return parts.join(" ");
}

function adminFor(cfg: Config, job: Job): string | null {
  return job.admin_phone ?? cfg.admins[0] ?? null;
}

/**
 * Sends the next batch of the current blast. Runs every minute from the cron
 * trigger, and right after a new blast arrives. Safe to run twice at once:
 * a lock makes the second run do nothing.
 */
export async function runSender(cfg: Config, deps: Deps): Promise<string> {
  if (cfg.paused) return "paused";
  const { store } = deps;
  const lockToken = crypto.randomUUID();
  if (!(await store.acquireLock("sender", lockToken, deps.now().getTime(), LOCK_TTL_MS))) return "locked";

  try {
    const now = deps.now();
    const nowIso = now.toISOString();
    const job = (await store.getSendingJob()) ?? (await store.startNextQueued(nowIso));
    if (!job) return "idle";

    await store.tidyRecipients(job.id, new Date(now.getTime() - STALE_CLAIM_MS).toISOString());

    const day = dayKey(now, cfg.timezone);
    const capLeft = cfg.maxTextsPerDay - (await store.getDailyCount(day));
    const limit = batchLimit(cfg.batchSize, job.segments, capLeft);

    let results: RecipientResult[] = [];
    if (limit === 0) {
      const c = await store.jobCounts(job.id);
      if (c.pending > 0 && job.cap_notice_day !== day) {
        await store.setCapNoticeDay(job.id, day);
        const admin = adminFor(cfg, job);
        // Over the cap on purpose: the admin must hear why sending stopped.
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
    } else {
      const due = await store.claimDue(job.id, limit, nowIso);
      let accepted = 0;
      for (const r of due) {
        const res = await sendSms(cfg, deps.fetch, r.phone, job.body);
        const attempts = r.attempts + 1;
        if (res.ok) {
          accepted++;
          results.push({ phone: r.phone, outcome: "sent", telnyxId: res.id });
        } else if (res.retryable && attempts < MAX_ATTEMPTS) {
          results.push({
            phone: r.phone,
            outcome: "retry",
            attempts,
            nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)).toISOString(),
            error: res.error,
          });
        } else {
          results.push({ phone: r.phone, outcome: "failed", attempts, error: res.error, optedOut: res.optedOut });
        }
        if (!res.ok) log("recipient_error", { job: job.id, to: mask(r.phone), attempt: attempts, error: res.error });
      }
      await store.saveResults(job.id, results, nowIso);
      await store.addDailyCount(day, accepted);
      if (due.length) log("batch_sent", { job: job.id, tried: due.length, accepted, dryRun: cfg.dryRun });
    }

    const c = await store.jobCounts(job.id);
    if (c.pending === 0 && (await store.finishJob(job.id, nowIso))) {
      if (job.kind === "welcome") await store.markWelcomedFromJob(job.id, nowIso);
      const admin = adminFor(cfg, job);
      const text = summaryText(job, c, cfg.dryRun);
      if (admin) await sendAndCount(cfg, deps, admin, text, day);
      log("job_done", { job: job.id, ...c, dryRun: cfg.dryRun });
      return "done";
    }
    return results.length ? "sent_batch" : "waiting";
  } finally {
    await store.releaseLock("sender", lockToken);
  }
}
