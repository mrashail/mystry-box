import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

const databaseUrl = process.env.DATABASE_URL ?? "file:dev.sqlite";
if (databaseUrl.startsWith("file:")) {
  const configuredPath = databaseUrl.slice(5).split("?")[0];
  const databasePath = resolve("prisma", configuredPath);
  mkdirSync(dirname(databasePath), { recursive: true });
  if (!existsSync(databasePath)) closeSync(openSync(databasePath, "a"));
}
