import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { SourceConfig } from './contracts.js';
export function readConfig<T>(name: string): T { return parse(readFileSync(`config/${name}.yaml`, 'utf8')) as T; }
export function readSources(): SourceConfig[] { return readConfig<{ sources: SourceConfig[] }>('sources').sources.filter(s => s.enabled); }
export const runtime = { port: Number(process.env.PORT ?? 4318), dbPath: process.env.DB_PATH ?? 'data/knowledge.sqlite' };
