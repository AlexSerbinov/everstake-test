import type { DocumentSnapshot } from "../../contracts.js";
import { getSetting, type Database } from "../../storage/database.js";

export interface CorpusQuery {
  page?: string;
  q?: string;
  kind?: string;
  copies?: string;
}
export function browseCorpus(db: Database, query: CorpusQuery = {}) {
  const pageSize = 100;
  const search = (query.q ?? "").trim().slice(0, 200);
  const clauses = ["active=1"];
  const params: string[] = [];
  if (search) {
    clauses.push(
      "(json_extract(snapshot,'$.title') LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR json_extract(snapshot,'$.publisher') LIKE ? ESCAPE '\\' OR json_extract(snapshot,'$.text') LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  if (query.kind) {
    clauses.push("json_extract(snapshot,'$.kind')=?");
    params.push(query.kind);
  }
  if (query.copies === "hide")
    clauses.push("json_extract(snapshot,'$.duplicateOf') IS NULL");
  if (query.copies === "only")
    clauses.push("json_extract(snapshot,'$.duplicateOf') IS NOT NULL");
  const where = clauses.join(" AND ");
  const total = Number(
    db
      .prepare(`SELECT count(*) n FROM documents WHERE ${where}`)
      .get(...params)!.n,
  );
  const requestedPage = Number(query.page ?? 0);
  const pageCount = Math.ceil(total / pageSize);
  const page = Math.min(
    Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
    Math.max(0, pageCount - 1),
  );
  const documents = db
    .prepare(
      `SELECT snapshot FROM documents WHERE ${where} ORDER BY lower(json_extract(snapshot,'$.title')), url LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, page * pageSize)
    .map((row) => {
      const doc = JSON.parse(String(row.snapshot)) as DocumentSnapshot;
      return { ...doc, text: doc.text.slice(0, 1200) };
    });
  const summary = db
    .prepare(
      "SELECT count(*) n, sum(CASE WHEN json_extract(snapshot,'$.duplicateOf') IS NOT NULL THEN 1 ELSE 0 END) copies FROM documents WHERE active=1",
    )
    .get()!;
  const kinds = db
    .prepare(
      "SELECT json_extract(snapshot,'$.kind') kind, count(*) n FROM documents WHERE active=1 GROUP BY kind ORDER BY kind",
    )
    .all()
    .map((row) => ({ kind: String(row.kind), count: Number(row.n) }));
  return {
    version: getSetting(db, "corpus_version", "unbuilt"),
    total,
    collectionTotal: Number(summary.n),
    duplicateCount: Number(summary.copies ?? 0),
    kinds,
    page,
    pageSize,
    pageCount,
    hasNext: page + 1 < pageCount,
    documents,
    events: db
      .prepare("SELECT * FROM crawl_events ORDER BY id DESC LIMIT 30")
      .all(),
  };
}
