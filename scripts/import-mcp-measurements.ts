import { readFileSync } from "node:fs";
import { openDatabase } from "../src/storage/database.js";
import { importMcpLedger } from "../src/services/measurements/import-ledger.js";
const input = process.argv[2];
if (!input)
  throw new Error("Provide the published MCP measurement ledger JSON path");
const db = openDatabase();
try {
  console.log(
    JSON.stringify(
      importMcpLedger(db, JSON.parse(readFileSync(input, "utf8"))),
    ),
  );
} finally {
  db.close();
}
