import { createHash } from 'node:crypto';
import type { DocumentSnapshot } from '../../contracts.js';
import type { Database } from '../../storage/database.js';
import { chunkDocument, type ChunkOptions } from './chunk.js';
import { deduplicateDocuments, type DuplicateGroup } from './deduplicate.js';

export interface BuildIndexOptions extends ChunkOptions {
  version?: string;
  sourceIds?: string[];
}

export interface BuildIndexReport {
  version: string;
  documents: number;
  canonicalDocuments: number;
  chunks: number;
  duplicateGroups: DuplicateGroup[];
}

function defaultVersion(documents: DocumentSnapshot[]): string {
  const digest = createHash('sha256').update(documents.map(item => item.id).sort().join('\n')).digest('hex').slice(0, 12);
  return `corpus-${digest}`;
}

/** Builds all content first, then atomically replaces the selected active snapshot. */
export function buildIndex(db: Database, input: DocumentSnapshot[], options: BuildIndexOptions = {}): BuildIndexReport {
  if (input.length === 0) throw new Error('Cannot activate an empty corpus');
  const deduplicated = deduplicateDocuments(input);
  const representatives = deduplicated.documents.filter(document => document.duplicateOf === null);
  const chunks = representatives.flatMap(document => chunkDocument(document, options));
  const version = options.version ?? defaultVersion(deduplicated.documents);
  const deactivateBySource = options.sourceIds?.length
    ? db.prepare(`UPDATE documents SET active=0 WHERE active=1 AND json_extract(snapshot, '$.metadata.sourceId') IN (${options.sourceIds.map(() => '?').join(',')})`)
    : null;
  const deactivateAll = db.prepare('UPDATE documents SET active=0 WHERE active=1');
  const upsertDocument = db.prepare(`
    INSERT INTO documents(id,url,content_hash,active,snapshot) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, content_hash=excluded.content_hash, active=excluded.active, snapshot=excluded.snapshot
  `);
  const deleteFts = db.prepare('DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE document_id=?)');
  const deleteChunks = db.prepare('DELETE FROM chunks WHERE document_id=?');
  const insertChunk = db.prepare('INSERT INTO chunks(id,document_id,text,ordinal) VALUES(?,?,?,?)');
  const insertFts = db.prepare('INSERT INTO chunks_fts(id,text) VALUES(?,?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (deactivateBySource) deactivateBySource.run(...options.sourceIds!);
    else deactivateAll.run();
    for (const document of deduplicated.documents) {
      upsertDocument.run(document.id, document.url, document.contentHash, 1, JSON.stringify(document));
      deleteFts.run(document.id);
      deleteChunks.run(document.id);
    }
    for (const chunk of chunks) {
      insertChunk.run(chunk.id, chunk.documentId, chunk.text, chunk.ordinal);
      insertFts.run(chunk.id, chunk.text);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('corpus_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { version, documents: deduplicated.documents.length, canonicalDocuments: representatives.length, chunks: chunks.length, duplicateGroups: deduplicated.groups };
}
