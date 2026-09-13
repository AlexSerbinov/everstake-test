import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../../storage/database.js';
import { transcribeVideo, type SonioxTransport, type TranscriptionMeter } from './transcribe-video.js';

test('rerun resumes a submitted provider job without a second paid submission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'youtube-resume-'));
  const audio = join(directory, 'audio.m4a');
  writeFileSync(audio, 'audio fixture');
  const db = openDatabase(':memory:');
  let uploads = 0;
  let submissions = 0;
  let meterStarts = 0;
  let meterFinishes = 0;
  const transport: SonioxTransport = {
    async upload() { uploads += 1; return { id: 'file-1', requestId: 'upload-request' }; },
    async submit() { submissions += 1; return { id: 'transcription-1', requestId: 'submit-request' }; },
    async status() { return { status: 'completed', request_id: 'status-request' }; },
    async transcript() { return { tokens: [{ text: 'Hello', speaker: '1', start_ms: 0, end_ms: 500 }] }; },
  };
  const meter: TranscriptionMeter = {
    start() { meterStarts += 1; return 'attempt-1'; },
    finish() { meterFinishes += 1; },
  };

  await assert.rejects(
    transcribeVideo(db, 'DFSEQ3OGoL8', audio, meter, { transport, pollTimeoutMs: 0, artifactDirectory: directory }),
    /rerun resumes/,
  );
  const completed = await transcribeVideo(db, 'DFSEQ3OGoL8', audio, meter, {
    transport, pollTimeoutMs: 1_000, pollIntervalMs: 0, artifactDirectory: directory,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(uploads, 1);
  assert.equal(submissions, 1);
  assert.equal(meterStarts, 1);
  assert.equal(meterFinishes, 1);
  db.close();
});
