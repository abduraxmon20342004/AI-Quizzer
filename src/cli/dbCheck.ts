/**
 * Read-only database check (safe on production/Neon): connectivity, SSL, server version, latency,
 * pooled vs direct endpoint, applied migrations. Never writes anything.
 *
 *   npm run db:check
 */
import "dotenv/config";
import { createDatabase, isNeonPooler } from "../db/db.js";
import { sql } from "kysely";

async function check(label: string, url: string | undefined) {
  if (!url) return;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "(invalid URL)";
    }
  })();
  const database = createDatabase(url, 1);
  try {
    const t0 = performance.now();
    const info = await sql<{ version: string; ssl: boolean | null; db: string }>`
      select version() as version, current_database() as db,
             (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as ssl`.execute(database.db);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) await sql`select 1`.execute(database.db);
    const rtt = (performance.now() - t1) / 5;
    const mig = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(database.db).catch(() => ({ rows: [{ n: -1 }] }));
    const row = info.rows[0]!;
    console.log(
      `${label}: ${host}${isNeonPooler(url) ? " (Neon pooler)" : ""}\n  database ${row.db}, ${row.version.split(" ").slice(0, 2).join(" ")}, ssl=${row.ssl ?? "n/a"}\n` +
        `  first query ${first.toFixed(0)} ms (includes connect / cold start), round trip ${rtt.toFixed(1)} ms\n` +
        `  migrations applied: ${mig.rows[0]!.n === -1 ? "none yet (run npm run migrate)" : mig.rows[0]!.n}`,
    );
  } catch (err) {
    console.error(`${label}: FAILED - ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

await check("DATABASE_URL", process.env.DATABASE_URL);
await check("DATABASE_DIRECT_URL", process.env.DATABASE_DIRECT_URL);
if (process.env.DATABASE_URL && isNeonPooler(process.env.DATABASE_URL) && !process.env.DATABASE_DIRECT_URL) {
  console.error("DATABASE_URL uses the Neon pooler: set DATABASE_DIRECT_URL (same host without '-pooler') for migrations and the job queue.");
  process.exitCode = 1;
}
