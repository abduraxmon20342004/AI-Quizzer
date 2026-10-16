import { Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./schema.js";

const { Pool, types } = pg;

/**
 * BIGINT (int8) handling: Telegram ids may exceed 32 bits, so they are stored as BIGINT. JavaScript numbers
 * are exact up to 2^53-1; Telegram documents that its ids fit in 52 significant bits. We convert to number
 * only after checking Number.isSafeInteger and fail loudly otherwise, so an id is never silently rounded.
 */
export function parseInt8Safe(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`BIGINT ${value} is outside the safe JavaScript integer range`);
  return n;
}

let parsersInstalled = false;
export function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;
  types.setTypeParser(types.builtins.INT8, parseInt8Safe);
  types.setTypeParser(types.builtins.NUMERIC, (v: string) => Number(v));
  // DATE stays a plain 'YYYY-MM-DD' string: it is a local calendar date in the group's timezone.
  types.setTypeParser(types.builtins.DATE, (v: string) => v);
  // int8[] (OID 1016)
  const parseArray = types.getTypeParser(1016 as never) as (v: string) => (string | null)[];
  types.setTypeParser(1016 as never, (v: string) => {
    const raw = parseArray(v) as unknown[];
    return raw.map((x) => (x === null ? null : parseInt8Safe(String(x))));
  });
}

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Either the root connection or a transaction - most repository functions accept both. */
export type Executor = Kysely<DB> | Transaction<DB>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Connection options that work for local PostgreSQL, Docker and Neon:
 * - Neon strings carry `sslmode=require&channel_binding=require`. node-postgres treats sslmode=require as
 *   verify-full (and warns), and does not read channel_binding from the URL - so we map them explicitly:
 *   full certificate verification + SCRAM channel binding.
 * - Neon suspends idle computes and closes idle connections: keep-alive, a generous connect timeout (cold
 *   start) and a short idle timeout keep the pool healthy; the pool replaces dropped clients itself.
 */
export function poolConfig(connectionString: string, max: number): pg.PoolConfig {
  const url = new URL(connectionString);
  const channelBinding = url.searchParams.get("channel_binding");
  url.searchParams.delete("channel_binding");
  const mode = url.searchParams.get("sslmode");
  const neon = /\.neon\.tech$/.test(url.hostname);
  // Railway's public TCP proxy (*.proxy.rlwy.net) fronts a Postgres image with generated self-signed certificates:
  // "require" there can only mean "encrypt" (node-postgres would otherwise verify and fail). Inside Railway the
  // private DATABASE_URL (postgres.railway.internal) needs no TLS settings at all.
  const railwayProxy = /\.rlwy\.net$/.test(url.hostname);
  if (mode === "require" || mode === "prefer") url.searchParams.set("sslmode", railwayProxy ? "no-verify" : "verify-full");
  return {
    connectionString: url.toString(),
    max,
    application_name: "student-game-bot",
    keepAlive: true,
    connectionTimeoutMillis: neon ? 15_000 : 5_000,
    idleTimeoutMillis: neon ? 60_000 : 30_000,
    ...(channelBinding === "require" ? { enableChannelBinding: true } : {}),
  };
}

export function isNeonPooler(connectionString: string): boolean {
  try {
    return /-pooler\./.test(new URL(connectionString).hostname);
  } catch {
    return false;
  }
}

export function createDatabase(connectionString: string, max = 10): Database {
  installTypeParsers();
  const pool = new Pool(poolConfig(connectionString, max));
  pool.on("error", () => {
    /* idle client errors are surfaced on next query; avoid crashing the process */
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    async close() {
      await db.destroy();
    },
  };
}
