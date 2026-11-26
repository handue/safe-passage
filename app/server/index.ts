// Small local API server for Safe Passage. Plain node:http, JSON in and out.
// Run with: node server/index.ts (Node 24 strips the TypeScript types).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AreaData } from '../src/engine/types.ts';
import { buildArea, geocode, GeocodeRejectedError, newProgress, RoadsUnavailableError, type AreaProgress, type SourceContext } from './sources.ts';
import { sanitizePlanInput, writePlan } from './plan.ts';
import { pickSituations, sanitizeSituationsInput } from './situations.ts';
import { fetchReference, type ReferenceOptions } from './reference.ts';

export const DEFAULT_DEMO_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-area.json');
export const DEMO_NOTE = 'Live data unavailable: showing the saved demo';

/** With demo=1, serve the saved demo if live data has not arrived by then. */
export const DEMO_DEADLINE_MS = 25000;

/** Longest address query passed on to the address services. */
export const MAX_QUERY_CHARS = 200;

/** How long a finished load's status stays readable. */
const STATUS_KEEP_MS = 120000;

export interface AreaStatus extends AreaProgress {
  done: boolean;
  /** Set when the load failed: the same code the /api/area response carries. */
  error?: string;
  elapsedMs: number;
}

interface StatusEntry {
  progress: AreaProgress;
  startedAt: number;
  done: boolean;
  error?: string;
}

/** Loads in progress (and recently finished), by the client's `key`. */
const statuses = new Map<string, StatusEntry>();

function validKey(key: string | null): key is string {
  return key !== null && /^[A-Za-z0-9_-]{1,64}$/.test(key);
}

function finishStatus(key: string | null, error?: string): void {
  const entry = key ? statuses.get(key) : undefined;
  if (!entry || !key) return;
  entry.done = true;
  entry.error = error;
  setTimeout(() => {
    if (statuses.get(key) === entry) statuses.delete(key);
  }, STATUS_KEEP_MS).unref();
}

export function readStatus(key: string, now = Date.now()): AreaStatus | null {
  const entry = statuses.get(key);
  if (!entry) return null;
  const status: AreaStatus = { ...entry.progress, done: entry.done, elapsedMs: now - entry.startedAt };
  if (entry.error) status.error = entry.error;
  return status;
}

export interface ServerOptions extends SourceContext {
  demoFile?: string;
  demoDeadlineMs?: number;
  /** Reference layer (real fires near home): fetcher and FIRMS key overrides for tests. */
  reference?: ReferenceOptions;
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

  const key = url.searchParams.get('key');
  const progress = newProgress();
  if (validKey(key)) statuses.set(key, { progress, startedAt: Date.now(), done: false });

  const live = buildArea({ home: { lat, lon }, label, country }, opts, progress);
  let area: AreaData;
  try {
    area = demo ? await withDeadline(live, opts.demoDeadlineMs ?? DEMO_DEADLINE_MS) : await live;
  } catch (err) {
    const saved = demo ? await readDemo(demoFile) : null;
    if (saved) {
      finishStatus(key);
      sendJson(res, 200, { ...saved, fallbacksUsed: [...saved.fallbacksUsed, DEMO_NOTE] });
      return;
    }
    try {
      // Deadline passed but there is no saved demo: keep waiting for live data.
      if (!(err instanceof DeadlineError)) throw err;
      area = await live;
    } catch (liveErr) {
      if (liveErr instanceof RoadsUnavailableError) {
        finishStatus(key, 'roads_unavailable');
        // reason: 'busy' (map server overloaded), 'timeout' (no answer in time) or 'failed'.
        sendJson(res, 503, { error: 'roads_unavailable', reason: liveErr.reason });
        return;
      }
      finishStatus(key, 'internal_error');
      throw liveErr;
    }
  }
  // Outside the live-data try: a failed snapshot write never replaces good live data.
  finishStatus(key);
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
      if (q.length > MAX_QUERY_CHARS) {
        sendJson(res, 400, { error: 'query_too_long', maxChars: MAX_QUERY_CHARS });
        return;
      }
      try {
        sendJson(res, 200, { results: await geocode(q, opts) });
      } catch (err) {
        // 400: the service answered and refused this query. 502: the service failed or did not answer.
        if (err instanceof GeocodeRejectedError) sendJson(res, 400, { error: 'query_rejected' });
        else sendJson(res, 502, { error: 'geocode_unavailable' });
      }
    } else if (req.method === 'GET' && url.pathname === '/api/area-status') {
      const key = url.searchParams.get('key');
      const status = validKey(key) ? readStatus(key) : null;
      if (status) sendJson(res, 200, status);
      else sendJson(res, 404, { error: 'unknown_key' });
    } else if (req.method === 'GET' && url.pathname === '/api/reference') {
      // Reference only: real fires near home. Never part of the drill.
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!url.searchParams.get('lat') || !url.searchParams.get('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        sendJson(res, 400, { error: 'bad_coordinates' });
        return;
      }
      const country = (url.searchParams.get('country') ?? '').toLowerCase();
      sendJson(res, 200, await fetchReference({ lat, lon }, country, { fetcher: opts.fetcher, ...opts.reference }));
    } else if (req.method === 'GET' && url.pathname === '/api/area') {
      await handleArea(url, res, opts);
    } else if (req.method === 'POST' && !isSameSiteJsonPost(req)) {
      // Both POST routes spend the model key. A cross-site "simple" POST (text/plain, no preflight)
      // or a request from another site's page is refused before the body is read.
      sendJson(res, 415, { error: 'json_from_this_site_only' });
    } else if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readJsonBody(req, 64 * 1024);
      if (body === null) {
        sendJson(res, 400, { error: 'bad_body' });
      } else {
        // Stop the model call when the browser closes the request (it no longer wants this plan).
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        const plan = await writePlan(sanitizePlanInput(body), { signal: controller.signal });
        if (plan.note) console.log(`plan: fallback (${plan.note})`);
        if (!controller.signal.aborted) sendJson(res, 200, plan);
      }
    } else if (req.method === 'POST' && url.pathname === '/api/situations') {
      const body = await readJsonBody(req, 64 * 1024);
      if (body === null) {
        sendJson(res, 400, { error: 'bad_body' });
      } else {
        // Stop the model call when the browser closes the request.
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        const out = await pickSituations(sanitizeSituationsInput(body), { signal: controller.signal });
        if (out.note) console.log(`situations: fallback (${out.note})`);
        if (!controller.signal.aborted) sendJson(res, 200, out);
      }
    } else {
      sendJson(res, 404, { error: 'not_found' });
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/i;

/** True for a POST sent as application/json whose Origin, when present, is this server's own host. */
export function isSameSiteJsonPost(req: IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser page (curl, tests): no cross-site risk
  try {
    const o = new URL(origin);
    // Vite's dev proxy rewrites Host to the API's own address, so a page on this machine counts too.
    return o.host === req.headers.host || LOOPBACK.test(o.hostname);
  } catch {
    return false;
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
  // Dev API: this machine only (Vite proxies to it). The production server (prod.ts) listens itself.
  server.listen(port, '127.0.0.1');
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
