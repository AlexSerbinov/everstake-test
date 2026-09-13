import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { runtime } from './config.js';
const app = new Hono();
app.get('/health', c => c.json({ status: 'ok', application: 'Everstate Knowledge Base' }));
serve({ fetch: app.fetch, port: runtime.port });
console.log(`Everstate Knowledge Base listening on ${runtime.port}`);
