// Shared helpers for the setup scripts (run on a computer, not on Cloudflare).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_FILE = join(ROOT, "setup", "state.json");
export const ANSWERS_FILE = join(ROOT, "setup", "answers.json");

/** Non-secret IDs created during setup (number, profile, brand, campaign). Safe to commit. */
export interface SetupState {
  phoneNumber?: string;
  phoneNumberId?: string;
  messagingProfileId?: string;
  brandId?: string;
  campaignId?: string;
  webhookUrl?: string;
  workerUrl?: string;
  numberAssigned?: boolean;
}

/** Answers from the owner. Contains personal details, so it's git-ignored. */
export interface Answers {
  groupName?: string;
  adminName?: string;
  adminNumbers?: string[];
  ownerNumber?: string;
  areaCode?: string;
  schoolName?: string;
  /** Telnyx's webhook public key. Not a secret (it can only check signatures). */
  telnyxPublicKey?: string;
  brand?: {
    firstName: string;
    lastName: string;
    email: string;
    mobilePhone: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
  };
}

export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

export const loadState = () => readJson<SetupState>(STATE_FILE, {});
export const loadAnswers = () => readJson<Answers>(ANSWERS_FILE, {});

export function saveState(patch: Partial<SetupState>): SetupState {
  const next = { ...loadState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function die(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/** Runs wrangler. Returns stdout; exits on failure unless allowFail. */
export function wrangler(
  args: string[],
  opts: { input?: string; allowFail?: boolean; quiet?: boolean } = {},
): { ok: boolean; out: string; stdout: string } {
  const r = spawnSync("npx", ["--no-install", "wrangler", ...args], {
    cwd: ROOT,
    input: opts.input,
    encoding: "utf8",
    stdio: [opts.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (!opts.quiet) process.stdout.write(r.stdout ?? "");
  if (r.status !== 0 && !opts.allowFail) {
    process.stderr.write(r.stderr ?? "");
    die(`wrangler ${args[0]} failed`);
  }
  return { ok: r.status === 0, out, stdout: r.stdout ?? "" };
}

/** Rows from `wrangler d1 execute --json` (parses stdout only; warnings go to stderr). */
export function d1Rows(r: { stdout: string }): any[] {
  const start = r.stdout.indexOf("[");
  if (start < 0) die(`Unexpected wrangler output:\n${r.stdout.slice(0, 500)}`);
  return JSON.parse(r.stdout.slice(start))[0]?.results ?? [];
}

/** Reads a [vars] value from wrangler.toml. */
export function tomlVar(name: string): string | undefined {
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  return toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

/** Sets a [vars] value (or top-level key) in wrangler.toml, keeping comments. */
export function setTomlValue(name: string, value: string): void {
  const file = join(ROOT, "wrangler.toml");
  const toml = readFileSync(file, "utf8");
  const re = new RegExp(`^(${name}\\s*=\\s*)"[^"]*"`, "m");
  if (!re.test(toml)) die(`${name} not found in wrangler.toml`);
  writeFileSync(file, toml.replace(re, `$1${JSON.stringify(value)}`));
}
