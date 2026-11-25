// Disk cache for outside service calls, so a demo replays the same data
// when a service is slow or down. One JSON file per request under app/.cache/.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');

export interface RequestSpec {
  method?: 'GET' | 'POST';
  url: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Logical cache key used instead of method+url+body, e.g. to share one entry across mirror endpoints. */
  cacheKey?: string;
}

export interface CacheOptions {
  dir?: string;
  /** Minutes before an entry expires; undefined = never. */
  ttlMin?: number;
  fetcher?: Fetcher;
  /** Return false to reject a 200 response (it is then not cached and the call fails). */
  accept?: (body: string) => boolean;
  now?: () => number;
}

export interface CachedResponse {
  body: string;
  /** When the data was actually fetched from the service. */
  fetchedAt: string;
  fromCache: boolean;
  /** True when an expired entry was served because the service failed. */
  stale: boolean;
}

interface CacheEntry {
  method: string;
  url: string;
  fetchedAt: string;
  body: string;
}

export class HttpError extends Error {
  status: number;
  /** Seconds from a Retry-After header, when the service sent one as a number. */
  retryAfterS?: number;
  constructor(status: number, url: string, retryAfter?: string | null) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    const s = Number(retryAfter);
    if (retryAfter && Number.isFinite(s) && s >= 0) this.retryAfterS = s;
  }
}

export function cacheKey(method: string, url: string, body = ''): string {
  return createHash('sha256').update(`${method}\n${url}\n${body}`).digest('hex');
}

async function readEntry(file: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeEntry(dir: string, file: string, entry: CacheEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Unique per write, so concurrent writers of the same key never share a temp file.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(entry));
  await rename(tmp, file);
}

/** Calls in flight per cache file, so identical concurrent requests share one fetch. */
const inFlight = new Map<string, Promise<CachedResponse>>();

/**
 * Fetch with a disk cache. Throws on network errors, non-2xx, or a rejected body (unless a stale entry exists).
 * A failed cache write is logged and never turns a good response into an error.
 */
function cacheFile(req: RequestSpec, dir: string): string {
  const method = req.method ?? 'GET';
  const key = req.cacheKey !== undefined ? cacheKey('KEY', req.cacheKey) : cacheKey(method, req.url, req.body);
  return path.join(dir, `${key}.json`);
}

/** The cached answer for a request, or null. Never calls the service; ignores expiry. */
export async function readCached(req: RequestSpec, opts: CacheOptions = {}): Promise<CachedResponse | null> {
  const entry = await readEntry(cacheFile(req, opts.dir ?? DEFAULT_CACHE_DIR));
  return entry ? { body: entry.body, fetchedAt: entry.fetchedAt, fromCache: true, stale: false } : null;
}

export function cachedFetch(req: RequestSpec, opts: CacheOptions = {}): Promise<CachedResponse> {
  const method = req.method ?? 'GET';
  const dir = opts.dir ?? DEFAULT_CACHE_DIR;
  const file = cacheFile(req, dir);
  const pending = inFlight.get(file);
  if (pending) return pending;
  const p = fetchOrRead(req, opts, method, dir, file).finally(() => inFlight.delete(file));
  inFlight.set(file, p);
  return p;
}

async function fetchOrRead(req: RequestSpec, opts: CacheOptions, method: string, dir: string, file: string): Promise<CachedResponse> {
  const now = opts.now ?? Date.now;

  const entry = await readEntry(file);
  if (entry) {
    const ageMin = (now() - Date.parse(entry.fetchedAt)) / 60000;
    if (opts.ttlMin === undefined || ageMin <= opts.ttlMin) {
      return { body: entry.body, fetchedAt: entry.fetchedAt, fromCache: true, stale: false };
    }
  }

  let body: string;
  let fetchedAt: string;
  try {
    const fetcher = opts.fetcher ?? fetch;
    const res = await fetcher(req.url, {
      method,
      body: req.body,
      headers: req.headers,
      signal: AbortSignal.timeout(req.timeoutMs ?? 20000),
    });
    body = await res.text();
    if (!res.ok) throw new HttpError(res.status, req.url, res.headers.get('retry-after'));
    if (opts.accept && !opts.accept(body)) throw new Error(`Rejected response from ${req.url}`);
    fetchedAt = new Date(now()).toISOString();
  } catch (err) {
    if (entry) return { body: entry.body, fetchedAt: entry.fetchedAt, fromCache: true, stale: true };
    throw err;
  }

  try {
    await writeEntry(dir, file, { method, url: req.url, fetchedAt, body });
  } catch (err) {
    console.warn(`Cache write failed for ${req.url}: ${String(err)}`);
  }
  return { body, fetchedAt, fromCache: false, stale: false };
}
