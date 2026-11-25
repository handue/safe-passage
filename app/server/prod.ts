// Production server for Safe Passage: one Node process serves the built app (dist/)
// and the API from server/index.ts. Run with: npm run build && npm start
// (Node 24 strips the TypeScript types.)

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AreaData } from '../src/engine/types.ts';
import { DEFAULT_DEMO_FILE, handleRequest, type ServerOptions } from './index.ts';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIST_DIR = path.join(APP_DIR, 'dist');
export const DEFAULT_PORT = 8080;

/** Vite puts content-hashed files here, so they can be cached for a year. */
const HASHED_PREFIX = '/assets/';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Cache-Control for a served file, by its URL path. */
export function cacheControl(urlPath: string): string {
  if (urlPath.startsWith(HASHED_PREFIX)) return 'public, max-age=31536000, immutable';
  if (urlPath === '/' || urlPath.endsWith('.html')) return 'no-cache';
  return 'public, max-age=3600';
}

/** The file under distDir for a URL path, or null if the path is bad or leaves distDir. */
export function staticPath(distDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const root = path.resolve(distDir);
  const file = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

/** True when any path segment starts with a dot (/.env, /.git/config, /a/.cache/x). Those are never served. */
export function hasDotSegment(urlPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  return decoded.split(/[\\/]/).some((part) => part.startsWith('.'));
}

/** A path with a file extension is a file request; anything else is an app route that gets index.html. Dot-paths are not app routes. */
export function isAppRoute(urlPath: string): boolean {
  return !hasDotSegment(urlPath) && path.posix.extname(urlPath) === '';
}

/** Coordinates match the saved demo home (the app sends the same numbers it read from the demo). */
export function isDemoHome(area: AreaData, lat: number, lon: number): boolean {
  return Math.abs(area.home.lat - lat) < 0.0005 && Math.abs(area.home.lon - lon) < 0.0005;
}

export interface ProdOptions extends ServerOptions {
  distDir?: string;
  /** true: demo requests try live data first, like the dev server. Default false: the saved demo is served directly. */
  liveDemo?: boolean;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sendText(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, urlPath: string): Promise<void> {
  const info = await stat(file);
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': String(info.size),
    'Cache-Control': cacheControl(urlPath),
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string, distDir: string): Promise<void> {
  const file = staticPath(distDir, urlPath);
  if (file === null) {
    sendText(res, 400, 'Bad path');
    return;
  }
  if (hasDotSegment(urlPath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  if (await isFile(file)) {
    await sendFile(req, res, file, urlPath);
    return;
  }
  if (!isAppRoute(urlPath)) {
    sendText(res, 404, 'Not found');
    return;
  }
  const index = path.join(distDir, 'index.html');
  if (!(await isFile(index))) {
    sendText(res, 503, 'App not built: run npm run build');
    return;
  }
  await sendFile(req, res, index, '/index.html');
}

/** The saved demo, read once. Null when the file is missing or unreadable. */
let demoCache: { file: string; area: AreaData | null } | null = null;
async function savedDemo(file: string): Promise<AreaData | null> {
  if (demoCache?.file !== file) {
    let area: AreaData | null = null;
    try {
      area = JSON.parse(await readFile(file, 'utf8')) as AreaData;
    } catch {
      area = null;
    }
    demoCache = { file, area };
  }
  return demoCache.area;
}

/** Serves /api/area?demo=1 for the demo home from the saved file, so the demo makes no outside calls. */
async function tryServeDemo(url: URL, res: ServerResponse, opts: ProdOptions): Promise<boolean> {
  if (opts.liveDemo || url.pathname !== '/api/area' || url.searchParams.get('demo') !== '1') return false;
  const area = await savedDemo(opts.demoFile ?? DEFAULT_DEMO_FILE);
  if (!area || !isDemoHome(area, Number(url.searchParams.get('lat')), Number(url.searchParams.get('lon')))) return false;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(area));
  return true;
}

export async function handleProdRequest(req: IncomingMessage, res: ServerResponse, opts: ProdOptions = {}): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && (await tryServeDemo(url, res, opts))) return;
      await handleRequest(req, res, opts);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    await serveStatic(req, res, url.pathname, opts.distDir ?? DEFAULT_DIST_DIR);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal error');
    else res.destroy();
  }
}

export function startProdServer(port: number, opts: ProdOptions = {}): Server {
  const server = createServer((req, res) => {
    void handleProdRequest(req, res, opts);
  });
  server.listen(port);
  return server;
}

if (import.meta.main) {
  try {
    process.loadEnvFile(path.join(APP_DIR, '.env'));
  } catch {
    // No .env file: use the environment as given (keys are optional).
  }
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = startProdServer(port, { liveDemo: process.env.LIVE_DEMO === '1' });
  server.on('listening', () => console.log(`Safe Passage on http://localhost:${port}`));
  // Stop cleanly on docker stop / Ctrl-C.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
