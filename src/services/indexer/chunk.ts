import { createHash } from 'node:crypto';
import type { DocumentSnapshot } from '../../contracts.js';

export interface DocumentChunk {
  id: string;
  documentId: string;
  text: string;
  ordinal: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

function splitLongBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block];
  const sentences = block.split(/(?<=[.!?])\s+|\n/).filter(Boolean);
  const output: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) output.push(current);
      for (let offset = 0; offset < sentence.length; offset += maxChars) output.push(sentence.slice(offset, offset + maxChars));
      current = '';
    } else if (!current || current.length + 1 + sentence.length <= maxChars) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      output.push(current);
      current = sentence;
    }
  }
  if (current) output.push(current);
  return output;
}

function tail(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const value = text.slice(-maxChars);
  const boundary = value.search(/[.!?]\s|\n/);
  return (boundary >= 0 ? value.slice(boundary + 1) : value).trim();
}

/** Chunks at paragraph/section boundaries and keeps bounded neighboring context. */
export function chunkDocument(document: DocumentSnapshot, options: ChunkOptions = {}): DocumentChunk[] {
  const maxChars = options.maxChars ?? 1_600;
  const overlapChars = Math.min(options.overlapChars ?? 180, Math.floor(maxChars / 3));
  if (maxChars < 200) throw new Error('maxChars must be at least 200');
  const blocks = document.text.split(/\n{2,}|(?=^#{1,6}\s)/m).map(value => value.trim()).filter(Boolean).flatMap(value => splitLongBlock(value, maxChars));
  const texts: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (!current || current.length + 2 + block.length <= maxChars) {
      current = current ? `${current}\n\n${block}` : block;
      continue;
    }
    texts.push(current);
    const overlap = tail(current, overlapChars);
    current = overlap && overlap.length + 2 + block.length <= maxChars ? `${overlap}\n\n${block}` : block;
  }
  if (current) texts.push(current);
  return texts.map((text, ordinal) => ({
    id: createHash('sha256').update(`${document.id}:${ordinal}:${text}`).digest('hex').slice(0, 32),
    documentId: document.id,
    text,
    ordinal,
  }));
}
