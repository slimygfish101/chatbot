// Carrier/Telnyx keywords. Matched against the whole message, ignoring case,
// spaces and trailing punctuation ("Stop." counts).
export const OPT_OUT = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"] as const;
export const OPT_IN = ["START", "UNSTOP"] as const;
export const HELP = ["HELP", "INFO"] as const;

export type Keyword = "opt_out" | "opt_in" | "help" | null;

export function classifyKeyword(text: string): Keyword {
  const word = text.trim().replace(/[.!?\s]+$/, "").toUpperCase();
  if ((OPT_OUT as readonly string[]).includes(word)) return "opt_out";
  if ((OPT_IN as readonly string[]).includes(word)) return "opt_in";
  if ((HELP as readonly string[]).includes(word)) return "help";
  return null;
}
