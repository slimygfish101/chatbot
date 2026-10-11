import { parseAdminNumbers, toE164 } from "./phone";

export interface Env {
  DB: D1Database;
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_NUMBER: string;
  ADMIN_NUMBERS: string;
  GROUP_NAME: string;
  ADMIN_NAME: string;
  MAX_TEXTS_PER_DAY?: string;
  DRY_RUN?: string;
  PAUSED?: string;
  SEND_BATCH_SIZE?: string;
  TIMEZONE?: string;
  TELNYX_REPLIES_TO_HELP?: string;
}

export interface Config {
  apiKey: string;
  publicKey: string;
  number: string;
  admins: string[];
  groupName: string;
  adminName: string;
  maxTextsPerDay: number;
  dryRun: boolean;
  paused: boolean;
  batchSize: number;
  timezone: string;
  telnyxRepliesToHelp: boolean;
}

const isTrue = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === "" ? fallback : ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());

const toInt = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env: Env): Config {
  return {
    apiKey: env.TELNYX_API_KEY ?? "",
    publicKey: env.TELNYX_PUBLIC_KEY ?? "",
    number: toE164(env.TELNYX_NUMBER ?? "") ?? "",
    admins: parseAdminNumbers(env.ADMIN_NUMBERS),
    groupName: env.GROUP_NAME ?? "Group",
    adminName: env.ADMIN_NAME ?? "the admin",
    maxTextsPerDay: toInt(env.MAX_TEXTS_PER_DAY, 1000),
    // Fail safe: anything other than an explicit "false" keeps dry-run on.
    dryRun: !["false", "0", "no", "off"].includes((env.DRY_RUN ?? "").trim().toLowerCase()),
    paused: isTrue(env.PAUSED, false),
    batchSize: Math.min(toInt(env.SEND_BATCH_SIZE, 15), 30),
    timezone: env.TIMEZONE || "America/New_York",
    telnyxRepliesToHelp: isTrue(env.TELNYX_REPLIES_TO_HELP, false),
  };
}

export const welcomeText = (c: Config) =>
  `${c.groupName}: You're on the announcement list from ${c.adminName}. About 20-30 texts a month. Reply HELP for help, STOP to opt out.`;

export const helpReplyText = (c: Config) =>
  `${c.groupName} announcements from ${c.adminName}. Reply STOP to opt out.`;
