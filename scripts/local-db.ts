/**
 * Local PostgreSQL for Windows/macOS development without Docker (real PostgreSQL 17 binaries from the
 * `embedded-postgres` dev dependency). Data lives in .data/pg. Creates `gamebot` and `gamebot_test`.
 *
 *   npm run db:local          # start and keep running (Ctrl+C to stop)
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const port = Number(process.env.LOCAL_PG_PORT ?? 54340);
const dir = path.resolve(".data/pg");
const fresh = !existsSync(path.join(dir, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "gamebot",
  password: "gamebot",
  port,
  persistent: true,
  // The Windows code page would otherwise make initdb default to a non-UTF8 encoding.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: (e: unknown) => console.error(String(e)),
});

if (fresh) await pg.initialise();
await pg.start();
for (const name of ["gamebot", "gamebot_test"]) {
  try {
    await pg.createDatabase(name);
    console.log(`created database ${name}`);
  } catch {
    /* already exists */
  }
}
console.log(`PostgreSQL ready: postgres://gamebot:gamebot@localhost:${port}/gamebot (test db: gamebot_test). Ctrl+C to stop.`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
