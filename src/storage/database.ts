import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
export function openDatabase(
  path = process.env.DB_PATH ?? "data/knowledge.sqlite",
): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}
export type Database = DatabaseSync;
export function getSetting(db: Database, key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
    { value: string } | undefined;
  return row?.value ?? fallback;
}
export function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value);
}
