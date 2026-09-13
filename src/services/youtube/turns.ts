import { z } from 'zod';

export const tokenSchema = z.object({
  text: z.string(),
  start_ms: z.number().nonnegative().nullable().optional(),
  end_ms: z.number().nonnegative().nullable().optional(),
  speaker: z.union([z.string(), z.number()]).nullish(),
  translation_status: z.string().nullish(),
}).passthrough();

export interface Turn { speaker: string | null; startMs: number | null; endMs: number | null; text: string; }

export function groupTurns(raw: unknown): Turn[] {
  const tokens = z.array(tokenSchema).parse(raw);
  const turns: Turn[] = [];
  for (const token of tokens) {
    if (token.translation_status === 'translation' || token.text === '<end>') continue;
    const text = cleanTokenText(token.text);
    if (!text.trim()) continue;
    const speaker = token.speaker == null ? null : String(token.speaker);
    let last = turns.at(-1);
    if (!last || last.speaker !== speaker || last.text.length + text.length > 1_800) {
      last = { speaker, startMs: token.start_ms ?? null, endMs: token.end_ms ?? null, text: '' };
      turns.push(last);
    }
    last.text += text;
    last.endMs = token.end_ms ?? last.endMs;
  }
  return turns
    .map(turn => ({ ...turn, text: sanitizeTranscriptText(turn.text) }))
    .filter(turn => turn.text);
}

/** Corpus-facing normalization. Raw provider tokens remain in the ignored job database. */
export function sanitizeTranscriptText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<\/?(?:system|assistant|developer|tool|prompt)[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTimestamp(milliseconds: number | null): string {
  if (milliseconds === null) return 'time unknown';
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function cleanTokenText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<\/?(?:system|assistant|developer|tool|prompt)[^>]*>/gi, ' ');
}
