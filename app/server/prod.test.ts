import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheControl, contentType, isAppRoute, isDemoHome, startProdServer, staticPath, type ProdOptions } from './prod.ts';
import type { AreaData } from '../src/engine/types.ts';

let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

const demoArea = {
  home: { lat: 37.1275, lon: -122.1238 },
  addressLabel: 'Demo',
  country: 'us',
  roads: [],
  places: [],
  elevation: null,
  wind: null,
  fetchedAt: {},
  fallbacksUsed: [],
} as unknown as AreaData;

async function setup(extra: ProdOptions = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sp-prod-'));
  const dist = path.join(dir, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Safe Passage</title>');
  await writeFile(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(path.join(dist, 'favicon.svg'), '<svg/>');
  await writeFile(path.join(dir, 'secret.txt'), 'secret');
  const demoFile = path.join(dir, 'demo.json');
  await writeFile(demoFile, JSON.stringify(demoArea));
  const fetcher = async () => { throw new Error('no outside calls in tests'); };
  const server = startProdServer(0, { distDir: dist, demoFile, cacheDir: path.join(dir, 'cache'), fetcher, ...extra });
  await new Promise((r) => server.once('listening', r));
  close = () => server.close();
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

describe('prod helpers', () => {
  it('content types', () => {
    expect(contentType('a/index.html')).toBe('text/html; charset=utf-8');
    expect(contentType('x.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentType('f.woff2')).toBe('font/woff2');
    expect(contentType('noext')).toBe('application/octet-stream');
  });

  it('cache rules', () => {
    expect(cacheControl('/assets/index-abc.js')).toContain('immutable');
    expect(cacheControl('/index.html')).toBe('no-cache');
    expect(cacheControl('/')).toBe('no-cache');
    expect(cacheControl('/favicon.svg')).toBe('public, max-age=3600');
  });

  it('static paths stay inside dist', () => {
    const root = path.resolve('/srv/dist');
    expect(staticPath(root, '/assets/a.js')).toBe(path.join(root, 'assets', 'a.js'));
    expect(staticPath(root, '/../secret.txt')).toBe(path.join(root, 'secret.txt'));
    expect(staticPath(root, '/%2e%2e/%2e%2e/etc/passwd')).toBe(path.join(root, 'etc', 'passwd'));
    expect(staticPath(root, '/%E0%A4%A')).toBeNull();
    expect(staticPath(root, '/a%00.js')).toBeNull();
  });

  it('app routes and demo home', () => {
    expect(isAppRoute('/fix')).toBe(true);
    expect(isAppRoute('/drill/setup')).toBe(true);
    expect(isAppRoute('/missing.js')).toBe(false);
    expect(isAppRoute('/.env')).toBe(false);
    expect(isAppRoute('/.git/config')).toBe(false);
    expect(isAppRoute('/a/%2Ecache')).toBe(false);
    expect(isDemoHome(demoArea, 37.12751, -122.12381)).toBe(true);
    expect(isDemoHome(demoArea, 37.2, -122.1238)).toBe(false);
  });
});

describe('prod server', () => {
  it('serves index, hashed assets, SPA fallback and 404s', async () => {
    const base = await setup();
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('Safe Passage');

    const asset = await fetch(`${base}/assets/index-abc123.js`);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(asset.headers.get('cache-control')).toContain('max-age=31536000');

    const deep = await fetch(`${base}/drill/setup?x=1`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('cache-control')).toBe('no-cache');
    expect(await deep.text()).toContain('Safe Passage');

    expect((await fetch(`${base}/assets/missing-1.js`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/.env`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/.env`)).status).toBe(404);
    expect((await fetch(`${base}/.cache/x`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
    const head = await fetch(`${base}/favicon.svg`, { method: 'HEAD' });
    expect(head.headers.get('content-type')).toBe('image/svg+xml');
  });

  it('passes the API through and serves the saved demo without outside calls', async () => {
    const base = await setup();
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    const demo = await fetch(`${base}/api/area?lat=37.1275&lon=-122.1238&demo=1`);
    expect(demo.status).toBe(200);
    expect(((await demo.json()) as AreaData).addressLabel).toBe('Demo');
  });
});
