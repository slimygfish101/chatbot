/**
 * Turns a US phone number in almost any format into E.164 (+1XXXXXXXXXX).
 * Returns null if it isn't a valid US number.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+") && !trimmed.startsWith("+1")) return null; // non-US
  const digits = trimmed.replace(/\D/g, "");
  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith("1")) national = digits.slice(1);
  else return null;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

/** For logs: never print a full number. "+12125551234" -> "…1234". */
export function mask(phone: string | null | undefined): string {
  if (!phone) return "?";
  const d = phone.replace(/\D/g, "");
  return `…${d.slice(-4)}`;
}

/** For texts to the admin (plain GSM characters only): "ending 1234". */
export function smsMask(phone: string): string {
  return `ending ${phone.replace(/\D/g, "").slice(-4)}`;
}

/** Parses the comma-separated ADMIN_NUMBERS setting. Invalid entries are dropped. */
export function parseAdminNumbers(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => toE164(s))
    .filter((p): p is string => p !== null);
}
