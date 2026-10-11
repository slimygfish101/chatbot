// Checks Telnyx's Ed25519 webhook signature.
// Telnyx signs `${telnyx-timestamp}|${raw body}` and sends the base64 signature in
// the telnyx-signature-ed25519 header. The public key is in the Telnyx portal
// under Keys & Credentials (base64).

export const MAX_AGE_SECONDS = 300;

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function verifyTelnyxSignature(opts: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  publicKey: string;
  nowSeconds: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { rawBody, signature, timestamp, publicKey, nowSeconds } = opts;
  if (!signature || !timestamp) return { ok: false, reason: "missing signature headers" };
  if (!publicKey) return { ok: false, reason: "TELNYX_PUBLIC_KEY not set" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) return { ok: false, reason: "timestamp too old" };

  try {
    const keyBytes = fromBase64(publicKey);
    // 32 bytes = raw key. 44 bytes = the same key wrapped in SPKI (DER).
    const key = await crypto.subtle.importKey(
      keyBytes.length === 32 ? "raw" : "spki",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64(signature),
      new TextEncoder().encode(`${timestamp}|${rawBody}`),
    );
    return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
  } catch (e) {
    return { ok: false, reason: `verify error: ${(e as Error).message}` };
  }
}
