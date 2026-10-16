import "dotenv/config";
import { migrateUrl } from "../db/migrate.js";

// Neon: migrations run on the direct endpoint (session advisory lock), never through the -pooler host.
const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
if (/-pooler\./.test(url)) throw new Error("Set DATABASE_DIRECT_URL to the direct Neon endpoint (host without -pooler) for migrations.");
const applied = await migrateUrl(url, (m) => console.log(m));
console.log(applied.length ? `done: ${applied.length} migration(s) applied` : "database is up to date");
