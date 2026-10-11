import type { Config } from "./config";
import { mask } from "./phone";
import { log } from "./log";

export const TELNYX_MESSAGES_URL = "https://api.telnyx.com/v2/messages";

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; retryable: boolean; optedOut: boolean; error: string };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Sends one plain SMS. Never throws. In DRY_RUN it only logs. */
export async function sendSms(cfg: Config, fetchFn: FetchFn, to: string, text: string): Promise<SendResult> {
  if (cfg.dryRun) {
    log("dry_run_send", { to: mask(to), chars: text.length });
    return { ok: true, id: `dry-run-${crypto.randomUUID()}` };
  }
  let res: Response;
  try {
    res = await fetchFn(TELNYX_MESSAGES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.number, to, text, type: "SMS" }),
      // A hung request becomes a retryable error instead of stalling the whole batch.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, retryable: true, optedOut: false, error: `network: ${(e as Error).message}` };
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no JSON body */
  }
  if (res.ok && body?.data?.id) return { ok: true, id: String(body.data.id) };

  const codes: string[] = (body?.errors ?? []).map((e: any) => String(e?.code ?? ""));
  const title = body?.errors?.[0]?.title ?? body?.errors?.[0]?.detail ?? "";
  return {
    ok: false,
    retryable: res.status === 429 || res.status >= 500,
    // 40300: the person texted STOP, so Telnyx blocks messages to them.
    optedOut: codes.includes("40300"),
    error: `${res.status} ${codes.join(",")} ${title}`.trim().slice(0, 200),
  };
}
