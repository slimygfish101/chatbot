import { type Config, helpReplyText, welcomeText } from "./config";
import { HELP_TEXT, isCommand, parseCommand } from "./commands";
import { classifyKeyword, type Keyword } from "./keywords";
import { log } from "./log";
import { mask, smsMask, toE164 } from "./phone";
import { countSegments, isGsmChar } from "./segments";
import type { Job, Store } from "./store";
import type { FetchFn, SendResult } from "./telnyx";
import { dayKey, sendAndCount } from "./sender";

export interface Deps {
  store: Store;
  fetch: FetchFn;
  now: () => Date;
}

/** The part of a Telnyx message.received payload we use. */
export interface InboundPayload {
  id?: string;
  direction?: string;
  type?: string;
  text?: string | null;
  from?: { phone_number?: string };
  to?: { phone_number?: string }[];
  media?: unknown[];
  autoresponse_type?: string | null;
}

export type InboundOutcome =
  | "ignored_wrong_number"
  | "ignored_bad_payload"
  | "duplicate"
  | "failed"
  | "blast_created"
  | "blast_empty"
  | "admin_command"
  | "admin_rejected"
  | "member_opt_out"
  | "member_opt_in"
  | "member_help"
  | "ignored_member_text";

export async function handleInbound(cfg: Config, deps: Deps, p: InboundPayload): Promise<InboundOutcome> {
  const nowIso = deps.now().toISOString();
  const from = toE164(p.from?.phone_number ?? "");
  const id = p.id;
  if (!id || !from) return "ignored_bad_payload";

  const toOurs = (p.to ?? []).some((t) => toE164(t.phone_number ?? "") === cfg.number);
  if (!toOurs) {
    log("ignored_wrong_number", { from: mask(from) });
    return "ignored_wrong_number";
  }

  // Must come before anything that sends or saves: a repeated webhook stops here.
  if (!(await deps.store.markProcessed(id, nowIso))) {
    log("duplicate_webhook", { id });
    return "duplicate";
  }

  // Only the text part. Pictures/attachments (MMS media) are never forwarded.
  const text = (p.text ?? "").trim();
  const hadMedia = Array.isArray(p.media) && p.media.length > 0;
  const isAdmin = cfg.admins.includes(from);

  try {
    if (isAdmin) return await handleAdmin(cfg, deps, from, text, hadMedia, id);
    return await handleMember(cfg, deps, from, text, p.autoresponse_type);
  } catch (e) {
    log("inbound_error", { id, from: mask(from), error: String((e as Error)?.message ?? e) });
    if (!isAdmin) return "failed";
    // A database error can come back even though the write went through, so check
    // before asking the admin to resend (a resend of a saved blast would go out twice).
    if (!isCommand(text) && !classifyKeyword(text)) {
      const saved = await deps.store.blastExistsFor(id).catch(() => null);
      if (saved) return "blast_created";
      const msg =
        saved === false
          ? "Not sent because of a system error. Please send it again."
          : "Something went wrong. Your message may or may not go out. Wait 10 minutes before sending it again.";
      await reply(cfg, deps, from, msg).catch(() => false);
    } else {
      await reply(cfg, deps, from, "Something went wrong. That command may or may not have worked.").catch(() => false);
    }
    return "failed";
  }
}

/** Sends one text and returns Telnyx's result. */
async function send(cfg: Config, deps: Deps, to: string, text: string): Promise<SendResult> {
  return sendAndCount(cfg, deps, to, text, dayKey(deps.now(), cfg.timezone));
}

async function reply(cfg: Config, deps: Deps, to: string, text: string): Promise<boolean> {
  return (await send(cfg, deps, to, text)).ok;
}

/** Applies a member STOP/START from any number (admins too, if they're on the list). */
async function applyKeywordStatus(deps: Deps, from: string, kw: Keyword, nowIso: string): Promise<void> {
  if (kw === "opt_out") await deps.store.optOut(from, nowIso);
  if (kw === "opt_in") await deps.store.optIn(from, nowIso);
}

/** First few words of a blast, in plain characters only, so the reply stays one ordinary text. */
export function preview(body: string): string {
  const chars = Array.from(body).filter(isGsmChar);
  const short = chars.slice(0, 25).join("").replace(/\s+/g, " ").trim();
  if (!short) return "your message";
  return chars.length > 25 ? `${short}...` : short;
}

async function handleAdmin(
  cfg: Config,
  deps: Deps,
  admin: string,
  text: string,
  hadMedia: boolean,
  messageId: string,
): Promise<InboundOutcome> {
  const { store } = deps;
  const nowIso = deps.now().toISOString();

  if (!text) {
    await reply(cfg, deps, admin, hadMedia ? "Not sent: pictures aren't forwarded, and there was no text." : "Not sent: the message was empty.");
    return "admin_rejected";
  }

  // A lone carrier keyword from the admin is never broadcast.
  const kw = classifyKeyword(text);
  if (kw) {
    log("admin_keyword_not_sent", { admin: mask(admin), kw });
    await applyKeywordStatus(deps, admin, kw, nowIso);
    // After STOP the carrier blocks texts to the admin, so there's no point replying.
    if (kw !== "opt_out") await reply(cfg, deps, admin, `Not sent: "${text.toUpperCase()}" is a reserved word. Text #help for commands.`);
    return "admin_rejected";
  }

  if (isCommand(text)) {
    const cmd = parseCommand(text);
    log("admin_command", { admin: mask(admin), cmd: cmd.kind });
    switch (cmd.kind) {
      case "error":
        await reply(cfg, deps, admin, cmd.message);
        break;
      case "help":
        await reply(cfg, deps, admin, HELP_TEXT);
        break;
      case "count": {
        const c = await store.countByStatus();
        await reply(cfg, deps, admin, `${c.active} active members. ${c.opted_out} opted out.`);
        break;
      }
      case "add": {
        const existing = await store.getMember(cmd.phone);
        const label = (name: string) => `${name || "Member"} (${smsMask(cmd.phone)})`;
        if (existing?.status === "opted_out") {
          await store.addAfterStart(cmd.phone, cmd.name, nowIso);
          await reply(cfg, deps, admin, `Not added yet: ${label(cmd.name || existing.name)} texted STOP. He'll be added when he texts START to this number.`);
        } else if (existing?.status === "active") {
          if (cmd.name && cmd.name !== existing.name) await store.setName(cmd.phone, cmd.name, nowIso);
          await reply(cfg, deps, admin, `Already on the list: ${label(cmd.name || existing.name)}.`);
        } else {
          await store.upsertActive(cmd.phone, cmd.name, nowIso);
          const name = cmd.name || existing?.name || "";
          const welcome = await send(cfg, deps, cmd.phone, welcomeText(cfg));
          if (!welcome.ok && welcome.optedOut) {
            // He had texted STOP to this number before; the carrier blocks us.
            await store.optOut(cmd.phone, nowIso);
            await store.addAfterStart(cmd.phone, name, nowIso);
            await reply(cfg, deps, admin, `Not added yet: ${label(name)} had texted STOP. He'll be added when he texts START to this number.`);
            break;
          }
          if (welcome.ok && !cfg.dryRun) await store.markWelcomed(cmd.phone, nowIso);
          const c = await store.countByStatus();
          await reply(cfg, deps, admin, `Added ${label(name)}. ${welcome.ok ? "Welcome text sent." : "Welcome text FAILED."} ${c.active} active.`);
        }
        break;
      }
      case "remove": {
        const existing = await store.getMember(cmd.phone);
        if (!existing) {
          await reply(cfg, deps, admin, `No member with number ${smsMask(cmd.phone)}.`);
        } else {
          await store.removeMember(cmd.phone, nowIso);
          const c = await store.countByStatus();
          await reply(cfg, deps, admin, `Removed ${existing.name || "member"} (${smsMask(cmd.phone)}). ${c.active} active.`);
        }
        break;
      }
      case "cancel": {
        // The one that's going out now; if none, the next one waiting.
        const job: Job | null = await store.getCancellableJob();
        if (!job) {
          await reply(cfg, deps, admin, "Nothing is sending right now.");
          break;
        }
        await store.cancelJob(job.id, nowIso);
        const c = await store.jobCounts(job.id);
        const queued = await store.countQueued();
        const parts = [`Cancelled "${preview(job.body)}". ${c.sent} of ${c.total} had already been sent.`];
        // The sender checks for #cancel after every text, so at most the one in flight still goes out.
        if (c.inFlight) parts.push("One more may have gone out.");
        if (queued) parts.push(`${queued} waiting message(s) will go out next.`);
        await reply(cfg, deps, admin, parts.join(" "));
        break;
      }
    }
    return "admin_command";
  }

  // Anything else is a blast.
  const seg = countSegments(text);
  const { jobId, recipients } = await store.createBlastJob(admin, text, seg.segments, seg.encoding, nowIso, messageId, cfg.dryRun);
  log("blast_created", { job: jobId, recipients, segments: seg.segments, encoding: seg.encoding, dryRun: cfg.dryRun });
  if (recipients === 0) {
    await reply(cfg, deps, admin, "Not sent: there are no active members on the list.");
    return "blast_empty";
  }
  const ahead = await store.jobsAhead(jobId);
  if (cfg.paused) {
    await reply(cfg, deps, admin, "Sending is paused right now. Your message is saved and will go out when it's turned back on.");
  } else if (ahead > 0) {
    await reply(cfg, deps, admin, "Queued. It will go out after the message that's sending now.");
  }
  return "blast_created";
}

async function handleMember(
  cfg: Config,
  deps: Deps,
  from: string,
  text: string,
  autoresponseType: string | null | undefined,
): Promise<InboundOutcome> {
  const { store } = deps;
  const now = deps.now();
  const nowIso = now.toISOString();
  const kw = classifyKeyword(text);

  if (kw === "opt_out") {
    // Telnyx/the carrier sends the opt-out confirmation; we only update the list.
    // Recorded even for numbers not on the list, so a later #add or import can't text them.
    await applyKeywordStatus(deps, from, kw, nowIso);
    log("member_opt_out", { from: mask(from) });
    return "member_opt_out";
  }
  if (kw === "opt_in") {
    // Puts him back where he was before STOP. Nobody joins the list this way.
    await applyKeywordStatus(deps, from, kw, nowIso);
    log("member_opt_in", { from: mask(from) });
    return "member_opt_in";
  }
  if (kw === "help") {
    const day = dayKey(now, cfg.timezone);
    const telnyxAnswered = cfg.telnyxRepliesToHelp || Boolean(autoresponseType);
    // One reply per number per day, and never past the daily cap, so HELP can't be used to run up texts.
    const shouldReply =
      !telnyxAnswered && (await store.getDailyCount(day)) < cfg.maxTextsPerDay && (await store.firstHelpToday(from, day));
    if (shouldReply && !(await reply(cfg, deps, from, helpReplyText(cfg)))) {
      await store.forgetHelp(from, day); // didn't go through; he can ask again
    }
    log("member_help", { from: mask(from), replied: shouldReply });
    return "member_help";
  }
  log("ignored_member_text", { from: mask(from) });
  return "ignored_member_text";
}
