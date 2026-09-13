import { loadEnvFile } from "node:process";
import { openDatabase } from "../src/storage/database.js";
import { createModelClient } from "../src/providers/model-client.js";
import {
  beginRun,
  finishRun,
  buildReceipt,
} from "../src/services/measurements/index.js";
loadEnvFile();
const db = openDatabase();
const id = beginRun(db, "provider-probe");
try {
  const response = await createModelClient(db).generate({
    runId: id,
    stage: "provider-probe",
    system: "Return a JSON object only.",
    messages: [{ role: "user", text: 'Return {"status":"ready"}.' }],
    maxOutputTokens: 500,
  });
  JSON.parse(response.text);
  finishRun(db, id, "completed");
  console.log(
    JSON.stringify({
      model: response.model,
      text: response.text,
      receipt: buildReceipt(db, id),
    }),
  );
} catch (error) {
  finishRun(db, id, "failed");
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Unknown error",
      receipt: buildReceipt(db, id),
    }),
  );
  process.exitCode = 1;
} finally {
  db.close();
}
