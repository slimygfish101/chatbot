// Works out how many billable texts (segments) one message uses per person.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€\f";

/** True if the character can be sent in a plain (GSM-7) text. */
export function isGsmChar(ch: string): boolean {
  return GSM_BASIC.includes(ch) || GSM_EXTENDED.includes(ch);
}

export interface SegmentInfo {
  encoding: "GSM-7" | "UCS-2";
  segments: number;
}

export function countSegments(text: string): SegmentInfo {
  let gsmUnits = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) gsmUnits += 1;
    else if (GSM_EXTENDED.includes(ch)) gsmUnits += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) {
    return { encoding: "GSM-7", segments: gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153) };
  }
  const units = text.length; // UTF-16 code units
  return { encoding: "UCS-2", segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
