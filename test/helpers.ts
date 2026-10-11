// Test helpers: an in-memory stand-in for Cloudflare D1 (real SQLite, same SQL)
// and a fake Telnyx API that records every text instead of sending it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config, type Env } from "../src/config";
import type { Deps } from "../src/inbound";
import { Store } from "../src/store";
import type { FetchFn } from "../src/telnyx";

/** Every SQL statement executed (batch statements counted one by one). */
export const d1Stats = { statements: 0 };

class FakeStatement {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new FakeStatement(this.db, this.sql, args);
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    d1Stats.statements++;
    const r = this.db.prepare(this.sql).run(...(this.args as any[]));
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    d1Stats.statements++;
    return { success: true, results: this.db.prepare(this.sql).all(...(this.args as any[])), meta: {} };
  }
  async first() {
    d1Stats.statements++;
    return this.db.prepare(this.sql).get(...(this.args as any[])) ?? null;
  }
}

export class FakeD1 {
  constructor(public sqlite: DatabaseSync) {}
  prepare(sql: string) {
    return new FakeStatement(this.sqlite, sql);
  }
  async batch(stmts: FakeStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.runSync());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  /** Test convenience: run a query and return rows. */
  rows<T = any>(sql: string, ...args: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...(args as any[])) as T[];
  }
}

export function makeDb(): FakeD1 {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  return new FakeD1(sqlite);
}

export const OUR_NUMBER = "+12125550000";
export const ADMIN = "+12125550001";

export function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TELNYX_API_KEY: "KEYtest",
    TELNYX_PUBLIC_KEY: "",
    TELNYX_NUMBER: OUR_NUMBER,
    ADMIN_NUMBERS: ADMIN,
    GROUP_NAME: "Yeshiva Boys",
    ADMIN_NAME: "Rabbi Cohen",
    MAX_TEXTS_PER_DAY: "1000",
    DRY_RUN: "false",
    PAUSED: "false",
    SEND_BATCH_SIZE: "15",
    TIMEZONE: "America/New_York",
    TELNYX_REPLIES_TO_HELP: "false",
    ...overrides,
  };
}

export interface SentText {
  to: string;
  text: string;
  from: string;
  type: string;
}

/** Fake Telnyx. `respond` can return a custom status/body for a given recipient. */
export class FakeTelnyx {
  sent: SentText[] = [];
  calls = 0;
  respond: (to: string, n: number) => { status: number; body: unknown } | null = () => null;
  fetch: FetchFn = async (_url, init) => {
    this.calls++;
    const body = JSON.parse(String(init?.body));
    const custom = this.respond(body.to, this.calls);
    if (custom) return new Response(JSON.stringify(custom.body), { status: custom.status });
    this.sent.push(body);
    return new Response(JSON.stringify({ data: { id: `msg-${this.calls}` } }), { status: 200 });
  };
  to(phone: string) {
    return this.sent.filter((s) => s.to === phone);
  }
}

export class Clock {
  constructor(public t = new Date("2026-10-11T14:00:00Z").getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export function setup(overrides: Partial<Env> = {}) {
  const db = makeDb();
  const env = makeEnv(db, overrides);
  const cfg: Config = loadConfig(env);
  const telnyx = new FakeTelnyx();
  const clock = new Clock();
  const deps: Deps = { store: new Store(env.DB), fetch: telnyx.fetch, now: clock.now };
  return { db, env, cfg, telnyx, clock, deps };
}

export function addMembers(db: FakeD1, n: number, status = "active"): string[] {
  const phones: string[] = [];
  for (let i = 0; i < n; i++) {
    const phone = `+1347555${String(1000 + i).padStart(4, "0")}`;
    phones.push(phone);
    db.sqlite
      .prepare("INSERT INTO members (phone, name, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(phone, `Boy ${i}`, status, "2026-10-01", "2026-10-01");
  }
  return phones;
}

let seq = 0;
export function inbound(from: string, text: string, extra: Record<string, unknown> = {}) {
  seq++;
  return {
    id: `in-${seq}-${Math.random().toString(36).slice(2)}`,
    direction: "inbound",
    type: "SMS",
    text,
    from: { phone_number: from },
    to: [{ phone_number: OUR_NUMBER }],
    media: [],
    ...extra,
  };
}
