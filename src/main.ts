import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { serve } from "@hono/node-server";
import { openDatabase } from "./storage/database.js";
import { createApplication } from "./application.js";
import { createApi } from "./api.js";
// Load optional local secrets before constructing clients; deployment injects environment values.
if (existsSync(".env")) loadEnvFile();
const db = openDatabase();
const application = createApplication(db);
const app = createApi(application);
// The controller resumes saved work and schedules only sources enabled by the operator.
application.updates.start();
const port = Number(process.env.PORT ?? 4318);
serve({ fetch: app.fetch, port });
console.log(`Everstate Knowledge Base listening on ${port}`);
