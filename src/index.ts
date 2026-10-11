import { loadConfig, type Env } from "./config";
import { handleInbound, type Deps, type InboundPayload } from "./inbound";
import { log } from "./log";
import { runSender } from "./sender";
import { Store } from "./store";
import type { FetchFn } from "./telnyx";
import { verifyTelnyxSignature } from "./verify";

export function makeDeps(env: Env, fetchFn: FetchFn = (u, i) => fetch(u, i)): Deps {
  return { store: new Store(env.DB), fetch: fetchFn, now: () => new Date() };
}

export async function handleFetch(req: Request, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/" && req.method === "GET") return new Response("Text Blast is running.\n");
  if (url.pathname !== "/telnyx") return new Response("Not found\n", { status: 404 });
  if (req.method !== "POST") return new Response("Method not allowed\n", { status: 405 });

  const cfg = loadConfig(env);
  const rawBody = await req.text();
  const check = await verifyTelnyxSignature({
    rawBody,
    signature: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
    publicKey: cfg.publicKey,
    nowSeconds: Math.floor(deps.now().getTime() / 1000),
  });
  if (!check.ok) {
    log("webhook_rejected", { reason: check.reason });
    return new Response("Invalid signature\n", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON\n", { status: 400 });
  }
  const type = event?.data?.event_type;
  const payload = event?.data?.payload;

  if (type === "message.received" && payload) {
    // Answer Telnyx right away; do the work in the background.
    // Blasts start on the next once-a-minute sender run (within 60 seconds).
    ctx.waitUntil(
      handleInbound(cfg, deps, payload as InboundPayload)
        .then((outcome) => log("inbound_handled", { outcome }))
        .catch((e) => log("inbound_error", { error: String(e?.message ?? e) })),
    );
  } else if (type === "message.finalized" && payload?.id) {
    // Delivery report for something we sent. Saved for troubleshooting.
    const status = String(payload?.to?.[0]?.status ?? "unknown");
    ctx.waitUntil(deps.store.recordDelivery(String(payload.id), status).catch(() => undefined));
  }
  return new Response("ok\n");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(req, env, ctx, makeDeps(env));
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const deps = makeDeps(env);
    ctx.waitUntil(
      runSender(loadConfig(env), deps, controller.scheduledTime)
        .then((result) => {
          if (result !== "idle") log("sender_run", { result });
        })
        .catch((e) => log("sender_error", { error: String(e?.message ?? e) })),
    );
  },
} satisfies ExportedHandler<Env>;
