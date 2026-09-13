import { createHash } from 'node:crypto';
import type { DocumentSnapshot } from '../../contracts.js';

export interface DuplicateGroup {
  id: string;
  representativeId: string;
  documentIds: string[];
  reason: 'exact_content' | 'near_duplicate';
  similarity: number;
}

export interface DeduplicationResult {
  documents: DocumentSnapshot[];
  groups: DuplicateGroup[];
}

function normalizedWords(text: string): string[] {
  return text.toLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

function shingles(text: string, width = 5): Set<string> {
  const words = normalizedWords(text);
  if (words.length <= width) return new Set([words.join(' ')]);
  return new Set(words.slice(0, words.length - width + 1).map((_, index) => words.slice(index, index + width).join(' ')));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function numberSignature(text: string): string {
  return [...text.matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)].map(match => match[0]).sort().join('|');
}

function representative(documents: DocumentSnapshot[]): DocumentSnapshot {
  return [...documents].sort((left, right) => {
    if (left.authority !== right.authority) return left.authority - right.authority;
    const leftDate = left.updatedAt ?? left.publishedAt ?? '';
    const rightDate = right.updatedAt ?? right.publishedAt ?? '';
    return rightDate.localeCompare(leftDate) || left.canonicalUrl.localeCompare(right.canonicalUrl);
  })[0]!;
}

/** Groups copies for retrieval while retaining every URL and every revised snapshot. */
export function deduplicateDocuments(input: DocumentSnapshot[], nearThreshold = 0.88): DeduplicationResult {
  const byId = new Map<string, DocumentSnapshot>();
  for (const document of input) {
    const existing = byId.get(document.id);
    if (!existing) {
      byId.set(document.id, { ...document, metadata: { ...document.metadata } });
      continue;
    }
    const aliases = new Set<string>([
      ...((existing.metadata.aliasUrls as string[] | undefined) ?? []),
      existing.url,
      document.url,
    ]);
    existing.metadata = { ...existing.metadata, aliasUrls: [...aliases].sort() };
  }
  const documents = [...byId.values()];
  const parent = documents.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const union = (left: number, right: number): void => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const cachedShingles = documents.map(document => shingles(document.text));
  for (let left = 0; left < documents.length; left += 1) {
    for (let right = left + 1; right < documents.length; right += 1) {
      const a = documents[left]!; const b = documents[right]!;
      if (a.canonicalUrl === b.canonicalUrl) continue;
      if (a.contentHash === b.contentHash) {
        union(left, right);
        continue;
      }
      if (numberSignature(a.text) !== numberSignature(b.text)) continue;
      const similarity = jaccard(cachedShingles[left]!, cachedShingles[right]!);
      if (similarity >= nearThreshold) union(left, right);
    }
  }
  const members = new Map<number, number[]>();
  documents.forEach((_, index) => {
    const root = find(index);
    members.set(root, [...(members.get(root) ?? []), index]);
  });
  const groups: DuplicateGroup[] = [];
  for (const indexes of members.values()) {
    if (indexes.length < 2) continue;
    const grouped = indexes.map(index => documents[index]!);
    const chosen = representative(grouped);
    const exact = grouped.every(document => document.contentHash === grouped[0]!.contentHash);
    const pairSimilarities = indexes.flatMap((left, position) => indexes.slice(position + 1).map(right => jaccard(cachedShingles[left]!, cachedShingles[right]!)));
    const similarity = exact ? 1 : Math.min(...pairSimilarities);
    const id = createHash('sha256').update(grouped.map(document => document.id).sort().join('\n')).digest('hex').slice(0, 20);
    for (const document of grouped) {
      document.duplicateOf = document.id === chosen.id ? null : chosen.id;
      document.metadata = { ...document.metadata, duplicateGroup: id, duplicateReason: exact ? 'exact_content' : 'near_duplicate', duplicateSimilarity: similarity };
    }
    groups.push({ id, representativeId: chosen.id, documentIds: grouped.map(document => document.id), reason: exact ? 'exact_content' : 'near_duplicate', similarity });
  }
  for (const document of documents) {
    if (!document.metadata.duplicateGroup) document.metadata = { ...document.metadata, duplicateGroup: document.id };
  }
  return { documents, groups };
}
