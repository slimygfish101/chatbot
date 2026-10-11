// One JSON line per event, visible with `npx wrangler tail`.
// Callers must pass masked phone numbers only.
export function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}
