import { toE164 } from "./phone";

export type Command =
  | { kind: "add"; phone: string; name: string }
  | { kind: "remove"; phone: string }
  | { kind: "count" }
  | { kind: "cancel" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const HELP_TEXT =
  "Commands: #add 2125551234 Name, #remove 2125551234, #count, #cancel, #help. Any other text goes to everyone.";

export function isCommand(text: string): boolean {
  return text.trim().startsWith("#");
}

/** Parses an admin message that starts with "#". */
export function parseCommand(text: string): Command {
  const body = text.trim().replace(/^#\s*/, "");
  const match = body.match(/^(\S*)\s*([\s\S]*)$/);
  const word = (match?.[1] ?? "").toLowerCase();
  const rest = (match?.[2] ?? "").trim();

  switch (word) {
    case "add": {
      // Phone first (digits, spaces, dashes, dots, parentheses), then the name.
      const m = rest.match(/^(\+?[\d(][\d\s().-]*\d)\s*(.*)$/s);
      const phone = m ? toE164(m[1]) : null;
      if (!phone) return { kind: "error", message: "Not done. Use: #add 2125551234 Name" };
      return { kind: "add", phone, name: m![2].replace(/\s+/g, " ").trim().slice(0, 60) };
    }
    case "remove": {
      const phone = toE164(rest);
      if (!phone) return { kind: "error", message: "Not done. Use: #remove 2125551234" };
      return { kind: "remove", phone };
    }
    case "count":
      return { kind: "count" };
    case "cancel":
      return { kind: "cancel" };
    case "help":
      return { kind: "help" };
    default:
      return { kind: "error", message: `Unknown command "#${word.slice(0, 20)}". Not sent. Text #help for the list.` };
  }
}
