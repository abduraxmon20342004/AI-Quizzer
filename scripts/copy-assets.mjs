// Copies non-TypeScript runtime assets next to the compiled output (dist/).
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/src/db/migrations", { recursive: true });
cpSync("src/db/migrations", "dist/src/db/migrations", { recursive: true });
cpSync("samples", "dist/samples", { recursive: true });
cpSync("data", "dist/data", { recursive: true });
console.log("assets copied");
