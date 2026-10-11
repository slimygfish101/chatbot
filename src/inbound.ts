import { type Config, helpReplyText, welcomeText } from "./config";
import { HELP_TEXT, isCommand, parseCommand } from "./commands";
import { classifyKeyword } from "./keywords";
import { log } from "./log";
import { mask, toE164 } from "./phone";
import { countSegments } from "./segments";
import type { Store } from "./store";
import type { FetchFn } from "./telnyx";
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

  if (cfg.admins.includes(from)) return handleAdmin(cfg, deps, from, text, hadMedia);
  return handleMember(cfg, deps, from, text, p.autoresponse_type);
}

/** Sends one text and returns whether Telnyx accepted it. */
async function reply(cfg: Config, deps: Deps, to: string, text: string): Promise<boolean> {
  const r = await sendAndCount(cfg, deps, to, text, dayKey(deps.now(), cfg.timezone));
  return r.ok;
}

async function handleAdmin(cfg: Config, deps: Deps, admin: string, text: string, hadMedia: boolean): Promise<InboundOutcome> {
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
        const label = (name: string) => `${name || "Member"} (${mask(cmd.phone)})`;
        if (existing?.status === "opted_out") {
          await reply(cfg, deps, admin, `Not added: ${label(existing.name)} texted STOP. He has to text START to this number himself.`);
        } else if (existing?.status === "active") {
          if (cmd.name && cmd.name !== existing.name) await store.setName(cmd.phone, cmd.name, nowIso);
          await reply(cfg, deps, admin, `Already on the list: ${label(cmd.name || existing.name)}.`);
        } else {
          await store.upsertActive(cmd.phone, cmd.name, nowIso);
          const sent = await reply(cfg, deps, cmd.phone, welcomeText(cfg));
          if (sent) await store.markWelcomed(cmd.phone, nowIso);
          const c = await store.countByStatus();
          await reply(
            cfg,
            deps,
            admin,
            `Added ${label(cmd.name || existing?.name || "")}. ${sent ? "Welcome text sent." : "Welcome text FAILED."} ${c.active} active.`,
          );
        }
        break;
      }
      case "remove": {
        const existing = await store.getMember(cmd.phone);
        if (!existing) {
          await reply(cfg, deps, admin, `No member with number ${mask(cmd.phone)}.`);
        } else {
          if (existing.status === "active") await store.setStatus(cmd.phone, "removed", nowIso);
          const c = await store.countByStatus();
          await reply(cfg, deps, admin, `Removed ${existing.name || "member"} (${mask(cmd.phone)}). ${c.active} active.`);
        }
        break;
      }
      case "cancel": {
        const job = await store.getSendingJob();
        if (!job) {
          await reply(cfg, deps, admin, "Nothing is sending right now.");
          break;
        }
        await store.cancelJob(job.id, nowIso);
        const c = await store.jobCounts(job.id);
        const queued = await store.countQueued();
        await reply(
          cfg,
          deps,
          admin,
          `Cancelled. ${c.sent} of ${c.total} had already been sent.${queued ? ` ${queued} queued message(s) will go out next.` : ""}`,
        );
        break;
      }
    }
    return "admin_command";
  }

  // Anything else is a blast.
  const seg = countSegments(text);
  const { jobId, recipients } = await store.createBlastJob(admin, text, seg.segments, seg.encoding, nowIso);
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
  const nowIso = deps.now().toISOString();
  const kw = classifyKeyword(text);

  if (kw === "opt_out") {
    // Telnyx/the carrier sends the opt-out confirmation; we only update the list.
    const changed = await store.setStatus(from, "opted_out", nowIso, "active");
    log("member_opt_out", { from: mask(from), changed });
    return "member_opt_out";
  }
  if (kw === "opt_in") {
    // Only people who were on the list and opted out themselves come back.
    // Someone the admin removed stays removed.
    const changed = await store.setStatus(from, "active", nowIso, "opted_out");
    log("member_opt_in", { from: mask(from), changed });
    return "member_opt_in";
  }
  if (kw === "help") {
    const telnyxAnswered = cfg.telnyxRepliesToHelp || Boolean(autoresponseType);
    if (!telnyxAnswered) await reply(cfg, deps, from, helpReplyText(cfg));
    log("member_help", { from: mask(from), replied: !telnyxAnswered });
    return "member_help";
  }
  log("ignored_member_text", { from: mask(from) });
  return "ignored_member_text";
}
