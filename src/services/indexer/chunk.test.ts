import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentSnapshot } from '../../contracts.js';
import { chunkDocument } from './chunk.js';

test('creates stable bounded chunks and carries neighboring context', () => {
  const text = `# Terms\n\n${'First condition remains applicable. '.repeat(12)}\n\n${'Second condition depends on the first. '.repeat(12)}`;
  const document = { id: 'doc', text } as DocumentSnapshot;
  const first = chunkDocument(document, { maxChars: 300, overlapChars: 70 });
  const second = chunkDocument(document, { maxChars: 300, overlapChars: 70 });
  assert.ok(first.length > 2);
  assert.deepEqual(first, second);
  assert.ok(first.every((chunk, ordinal) => chunk.text.length <= 300 && chunk.ordinal === ordinal));
  assert.match(first[1]!.text, /condition/);
});
