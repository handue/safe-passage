// Small local API server for Safe Passage. Plain node:http, JSON in and out.
// Run with: node server/index.ts (Node 24 strips the TypeScript types).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AreaData } from '../src/engine/types.ts';
import { buildArea, geocode, RoadsUnavailableError, type SourceContext } from './sources.ts';
import { sanitizePlanInput, writePlan } from './plan.ts';

export const DEFAULT_DEMO_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-area.json');
export const DEMO_NOTE = 'Live data unavailable: showing the saved demo';

/** With demo=1, serve the saved demo if live data has not arrived by then. */
export const DEMO_DEADLINE_MS = 25000;

export interface ServerOptions extends SourceContext {
  demoFile?: string;
  demoDeadlineMs?: number;
}

class DeadlineError extends Error {}

/** Resolves with `p`, or rejects with DeadlineError after ms. `p` keeps running (and fills the cache). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`no live data after ${ms} ms`)), ms);
  });
  p.catch(() => {}); // a late failure must not become an unhandled rejection
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Only a complete live result may replace the saved demo: places, terrain and wind all present, no fallbacks. */
export function isCompleteArea(area: AreaData): boolean {
  return area.elevation !== null && area.wind !== null && area.fallbacksUsed.length === 0 && area.roads.length > 0;
}

async function saveDemo(file: string, area: AreaData): Promise<void> {
  if (!isCompleteArea(area)) {
    console.warn('Demo snapshot not updated: live data was incomplete');
    return;
  }
  try {
    await writeFile(file, JSON.stringify(area, null, 1));
  } catch (err) {
    console.warn(`Demo snapshot write failed: ${String(err)}`);
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readDemo(file: string): Promise<AreaData | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AreaData;
  } catch {
    return null;
  }
}

async function handleArea(url: URL, res: ServerResponse, opts: ServerOptions): Promise<void> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!url.searchParams.get('lat') || !url.searchParams.get('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    sendJson(res, 400, { error: 'bad_coordinates' });
    return;
  }
  const label = url.searchParams.get('label') ?? '';
  const country = (url.searchParams.get('country') ?? '').toLowerCase();
  const demo = url.searchParams.get('demo') === '1';
  const demoFile = opts.demoFile ?? DEFAULT_DEMO_FILE;

  const live = buildArea({ home: { lat, lon }, label, country }, opts);
  let area: AreaData;
  try {
    area = demo ? await withDeadline(live, opts.demoDeadlineMs ?? DEMO_DEADLINE_MS) : await live;
  } catch (err) {
    const saved = demo ? await readDemo(demoFile) : null;
    if (saved) {
      sendJson(res, 200, { ...saved, fallbacksUsed: [...saved.fallbacksUsed, DEMO_NOTE] });
      return;
    }
    try {
      // Deadline passed but there is no saved demo: keep waiting for live data.
      if (!(err instanceof DeadlineError)) throw err;
      area = await live;
    } catch (liveErr) {
      if (liveErr instanceof RoadsUnavailableError) {
        sendJson(res, 503, { error: 'roads_unavailable' });
        return;
      }
      throw liveErr;
    }
  }
  // Outside the live-data try: a failed snapshot write never replaces good live data.
  if (demo) await saveDemo(demoFile, area);
  sendJson(res, 200, area);
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, opts: ServerOptions = {}): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
    } else if (req.method === 'GET' && url.pathname === '/api/geocode') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (!q) {
        sendJson(res, 400, { error: 'missing_query' });
        return;
      }
      try {
        sendJson(res, 200, { results: await geocode(q, opts) });
      } catch {
        sendJson(res, 502, { error: 'geocode_unavailable' });
      }
    } else if (req.method === 'GET' && url.pathname === '/api/area') {
      await handleArea(url, res, opts);
    } else if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readJsonBody(req, 64 * 1024);
      if (body === null) {
        sendJson(res, 400, { error: 'bad_body' });
      } else {
        const plan = await writePlan(sanitizePlanInput(body));
        if (plan.note) console.log(`plan: fallback (${plan.note})`);
        sendJson(res, 200, plan);
      }
    } else {
      sendJson(res, 404, { error: 'not_found' });
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function startServer(port: number, opts: ServerOptions = {}): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts);
  });
  server.listen(port);
  return server;
}

if (import.meta.main) {
  try {
    process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
  } catch {
    // No .env: plans use the fixed checklist.
  }
  const port = Number(process.env.PORT ?? 8787);
  startServer(port);
  console.log(`Safe Passage API on http://localhost:${port}`);
}
