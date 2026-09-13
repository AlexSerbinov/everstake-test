import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Database } from '../../storage/database.js';
import { groupTurns, type Turn } from './turns.js';

export interface TranscriptionJob {
  videoId: string;
  audioHash: string;
  model: string;
  fileId?: string;
  transcriptionId?: string;
  status: 'new' | 'uploaded' | 'submission_unknown' | 'submitted' | 'poll_timeout' | 'completed' | 'failed';
  turns?: Turn[];
  providerMetadata?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface TranscriptionMeter {
  start(metadata: Record<string, unknown>): string;
  finish(attemptId: string, status: 'completed' | 'error', metadata: Record<string, unknown>): void;
}

export interface SonioxTransport {
  upload(audioPath: string, bytes: Buffer): Promise<{ id: string; requestId: string | null }>;
  submit(fileId: string, model: string, clientReferenceId: string): Promise<{ id: string; requestId: string | null }>;
  findByClientReference?(clientReferenceId: string): Promise<{ id: string; status: string } | null>;
  status(transcriptionId: string): Promise<Record<string, unknown>>;
  transcript(transcriptionId: string): Promise<Record<string, unknown>>;
}

export interface TranscriptionOptions {
  durationSeconds?: number | null;
  transport?: SonioxTransport;
  sleep?: (laughedMs: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  artifactDirectory?: string;
}

/** Persist a paid provider job before polling, then resume the same ID after timeout or restart. */
export async function transcribeVideo(
  db: Database,
  videoId: string,
  audioPath: string,
  meter: TranscriptionMeter,
  options: TranscriptionOptions = {},
): Promise<TranscriptionJob> {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid video ID');
  const bytes = readFileSync(audioPath);
  const audioHash = createHash('sha256').update(bytes).digest('hex');
  const model = process.env.SONIOX_MODEL ?? 'stt-async-v5';
  const transport = options.transport ?? createSonioxTransport();
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const row = db.prepare('SELECT data FROM youtube_jobs WHERE video_id=?').get(videoId) as { data: string } | undefined;
  const job: TranscriptionJob = row
    ? JSON.parse(row.data) as TranscriptionJob
    : { videoId, audioHash, model, status: 'new', startedAt: new Date().toISOString() };
  if (job.audioHash !== audioHash || job.model !== model) {
    throw new Error('Audio/model changed: retain the prior job and use an explicit new video revision');
  }
  const artifactDirectory = options.artifactDirectory ?? 'data/youtube';
  const persist = (): void => {
    db.prepare('INSERT OR REPLACE INTO youtube_jobs(video_id,status,data) VALUES(?,?,?)').run(videoId, job.status, JSON.stringify(job));
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(join(artifactDirectory, `${videoId}.job.json`), JSON.stringify(job, null, 2));
  };
  if (job.status === 'completed') {
    const transcriptPath = join(artifactDirectory, `${videoId}.transcript.json`);
    if (job.providerMetadata?.turnNormalizerVersion !== 2 && existsSync(transcriptPath)) {
      const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, unknown>;
      job.turns = groupTurns(transcript.tokens);
      job.providerMetadata = { ...job.providerMetadata, turnNormalizerVersion: 2 };
      persist();
    }
    return job;
  }
  if (job.status === 'failed') throw new Error('Prior Soniox job failed; inspect it before creating a paid retry');
  if (job.status === 'submission_unknown') {
    const operationId = typeof job.providerMetadata?.operationId === 'string' ? job.providerMetadata.operationId : null;
    const reconciled = operationId && transport.findByClientReference
      ? await transport.findByClientReference(operationId)
      : null;
    if (!reconciled) throw new Error('Prior Soniox submission is ambiguous; reconcile provider activity before resubmitting');
    job.transcriptionId = reconciled.id;
    job.status = 'submitted';
    job.providerMetadata = { ...job.providerMetadata, reconciledByClientReference: true, reconciledStatus: reconciled.status };
    persist();
  }

  if (!job.fileId) {
    const uploaded = await transport.upload(audioPath, bytes);
    job.fileId = uploaded.id;
    job.status = 'uploaded';
    job.providerMetadata = { ...job.providerMetadata, uploadRequestId: uploaded.requestId };
    persist();
  }

  let attemptId = typeof job.providerMetadata?.attemptId === 'string' ? job.providerMetadata.attemptId : undefined;
  if (!job.transcriptionId) {
    const operationId = randomUUID();
    attemptId = meter.start({
      videoId, audioHash, model, operationId,
      durationSeconds: options.durationSeconds ?? null,
      forecastCostUsd: options.durationSeconds == null ? null : options.durationSeconds / 3_600 * 0.10,
    });
    job.status = 'submission_unknown';
    job.providerMetadata = { ...job.providerMetadata, attemptId, operationId };
    persist();
    try {
      const submitted = await transport.submit(job.fileId, model, operationId);
      job.transcriptionId = submitted.id;
      job.status = 'submitted';
      job.providerMetadata = { ...job.providerMetadata, submitRequestId: submitted.requestId };
      persist();
    } catch (error) {
      job.providerMetadata = { ...job.providerMetadata, submissionAmbiguous: true };
      persist();
      throw error;
    }
  }
  if (!attemptId) throw new Error('Submitted Soniox job has no metered attempt ID');

  const deadline = Date.now() + (options.pollTimeoutMs ?? 30 * 60 * 1_000);
  while (Date.now() < deadline) {
    const status = await transport.status(job.transcriptionId!);
    const providerStatus = String(status.status ?? '').toLowerCase();
    if (providerStatus === 'completed') {
      const transcript = await transport.transcript(job.transcriptionId!);
      job.turns = groupTurns(transcript.tokens);
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.providerMetadata = { ...job.providerMetadata, terminalStatus: status, turnNormalizerVersion: 2 };
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(join(artifactDirectory, `${videoId}.transcript.json`), JSON.stringify(transcript, null, 2));
      persist();
      meter.finish(attemptId, 'completed', {
        videoId,
        transcriptionId: job.transcriptionId,
        providerRequestId: stringOrNull(status.request_id ?? status.requestId),
        providerMetadata: status,
        actualCostUsd: null,
        forecastCostUsd: options.durationSeconds == null ? null : options.durationSeconds / 3_600 * 0.10,
        costStatus: 'unknown_pending_provider_usage_or_billing_reconciliation',
      });
      return job;
    }
    if (['error', 'failed', 'canceled', 'cancelled'].includes(providerStatus)) {
      job.status = 'failed';
      job.providerMetadata = { ...job.providerMetadata, terminalStatus: status };
      persist();
      meter.finish(attemptId, 'error', {
        videoId,
        providerMetadata: status,
        actualCostUsd: null,
        costStatus: 'unknown_pending_provider_reconciliation',
      });
      throw new Error(`Soniox transcription failed with status ${providerStatus}`);
    }
    await sleep(options.pollIntervalMs ?? 5_000);
  }
  job.status = 'poll_timeout';
  persist();
  throw new Error('Soniox polling timed out; rerun resumes the existing paid job');
}

export function createSonioxTransport(fetchImpl: typeof fetch = fetch): SonioxTransport {
  const key = process.env.SONIOX_API_KEY;
  if (!key) throw new Error('Missing SONIOX_API_KEY');
  const request = async (path: string, init: RequestInit = {}): Promise<{ body: Record<string, unknown>; requestId: string | null }> => {
    const response = await fetchImpl(`https://api.soniox.com/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...init.headers },
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Soniox HTTP ${response.status}: ${String(body.error_message ?? body.message ?? 'request failed').slice(0, 300)}`);
    return { body, requestId: response.headers.get('x-request-id') };
  };
  return {
    async upload(audioPath, bytes) {
      const form = new FormData();
      form.append('file', new Blob([Uint8Array.from(bytes).buffer]), basename(audioPath));
      const response = await request('/files', { method: 'POST', body: form });
      return { id: requiredId(response.body, 'upload'), requestId: response.requestId };
    },
    async submit(fileId, model, clientReferenceId) {
      const response = await request('/transcriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, file_id: fileId, enable_speaker_diarization: true, enable_language_identification: true, client_reference_id: clientReferenceId }),
      });
      return { id: requiredId(response.body, 'transcription'), requestId: response.requestId };
    },
    async findByClientReference(clientReferenceId) {
      const response = await request('/transcriptions?limit=1000');
      const rows = Array.isArray(response.body.transcriptions) ? response.body.transcriptions : [];
      const match = rows.find(item => item && typeof item === 'object'
        && (item as Record<string, unknown>).client_reference_id === clientReferenceId) as Record<string, unknown> | undefined;
      return match && typeof match.id === 'string'
        ? { id: match.id, status: String(match.status ?? 'unknown') }
        : null;
    },
    async status(transcriptionId) { return (await request(`/transcriptions/${transcriptionId}`)).body; },
    async transcript(transcriptionId) { return (await request(`/transcriptions/${transcriptionId}/transcript`)).body; },
  };
}

function requiredId(body: Record<string, unknown>, operation: string): string {
  if (typeof body.id !== 'string' || !body.id) throw new Error(`Invalid Soniox ${operation} response`);
  return body.id;
}

function stringOrNull(value: unknown): string | null { return typeof value === 'string' ? value : null; }
