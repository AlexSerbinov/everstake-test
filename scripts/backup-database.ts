import { backup } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { openDatabase } from "../src/storage/database.js";
const output = process.argv[2];
if (!output) throw new Error("Provide a new backup destination");
if (existsSync(output))
  throw new Error("Backup destination already exists; choose a new filename");
const db = openDatabase();
try {
  await backup(db, output);
  console.log(`Consistent SQLite backup saved to ${output}`);
} catch (error) {
  rmSync(output, { force: true });
  throw error;
} finally {
  db.close();
}
