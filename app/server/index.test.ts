import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fetcher } from './cache.ts';
import { DEMO_NOTE, isCompleteArea, startServer, type ServerOptions } from './index.ts';
import type { AreaData } from '../src/engine/types.ts';

let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

async function serve(fetcher: Fetcher, demoFile: string, extra: ServerOptions = {}): Promise<string> {
  const overpassTiming = { budgetMs: 8000, primaryMs: 1000, mirrorMs: 1000, retryCapMs: 20, retryDefaultMs: 10 };
  const server = startServer(0, { fetcher, demoFile, cacheDir: await mkdtemp(path.join(tmpdir(), 'sp-idx-')), overpassTiming, ...extra });
  await new Promise((r) => server.once('listening', r));
  close = () => server.close();
  return `http://localhost:${(server.address() as AddressInfo).port}`;
}

const down: Fetcher = async () => new Response('err', { status: 503 });

describe('server', () => {
  it('health, plan, 404 and bad input', async () => {
    const base = await serve(down, '/nonexistent/demo.json');
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/plan`, { method: 'POST', body: 'not json' })).status).toBe(400);
    const saved = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;
    try {
      const plan = await fetch(`${base}/api/plan`, { method: 'POST', body: JSON.stringify({ household: { adults: 1 }, main: { roadNames: ['A Rd'], driveMin: 5, destination: 'D1 School' } }) });
      expect(plan.status).toBe(200);
      expect(((await plan.json()) as { source: string }).source).toBe('fallback');
    } finally {
      if (saved !== undefined) process.env.MODEL_API_KEY = saved;
    }
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/area?lat=abc&lon=1`)).status).toBe(400);
    expect((await fetch(`${base}/api/geocode`)).status).toBe(400);
  });

  it('503 when roads fail without a demo file', async () => {
    const base = await serve(down, '/nonexistent/demo.json');
    const res = await fetch(`${base}/api/area?lat=37&lon=-122`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'roads_unavailable', reason: 'failed' });
  });

  it('geocode: too long, rejected, unavailable, and clean labels', async () => {
    const long = await serve(down, '/nonexistent/demo.json');
    const tooLong = await fetch(`${long}/api/geocode?q=${'a'.repeat(201)}`);
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as { error: string }).error).toBe('query_too_long');
    const outage = await fetch(`${long}/api/geocode?q=somewhere`);
    expect(outage.status).toBe(502);
    expect(await outage.json()).toEqual({ error: 'geocode_unavailable' });
    close?.();

    const rejected = await serve(async () => new Response('bad request', { status: 400 }), '/nonexistent/demo.json');
    const r = await fetch(`${rejected}/api/geocode?q=somewhere`);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'query_rejected' });
  });

  it('area-status reports each part, keyed by the client', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const fetcher: Fetcher = async (url, init) => {
      if (url.includes('overpass')) { await gate; return overpassOk(init); }
      return completeFetcher(url, init);
    };
    const base = await serve(fetcher, '/nonexistent/demo.json');
    expect((await fetch(`${base}/api/area-status?key=nope`)).status).toBe(404);
    const area = fetch(`${base}/api/area?lat=37&lon=-122&country=us&key=job-1`);
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 50 && status.terrain !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const res = await fetch(`${base}/api/area-status?key=job-1`);
      if (res.ok) status = (await res.json()) as Record<string, unknown>;
    }
    expect(status).toMatchObject({ roads: 'working', places: 'working', terrain: 'done', wind: 'done', done: false, mapAttempt: 1, mapServer: 'main' });
    release();
    expect((await area).status).toBe(200);
    const end = (await (await fetch(`${base}/api/area-status?key=job-1`)).json()) as Record<string, unknown>;
    expect(end).toMatchObject({ roads: 'done', places: 'done', done: true });
    expect(typeof end.elapsedMs).toBe('number');
  });

  it('serves the saved demo when live data fails', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-demo-'));
    const demoFile = path.join(dir, 'demo.json');
    await writeFile(demoFile, JSON.stringify({ roads: [], fallbacksUsed: ['x'] }));
    const base = await serve(down, demoFile);
    const body = (await (await fetch(`${base}/api/area?lat=37&lon=-122&demo=1`)).json()) as { fallbacksUsed: string[] };
    expect(body.fallbacksUsed).toEqual(['x', DEMO_NOTE]);
    expect(JSON.parse(await readFile(demoFile, 'utf8')).fallbacksUsed).toEqual(['x']);
  });

  const roadsBody = JSON.stringify({ elements: [
    { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
    { type: 'node', id: 10, lat: 37, lon: -122 }, { type: 'node', id: 11, lat: 37.001, lon: -122 },
  ] });
  const overpassOk = (_init?: RequestInit) => new Response(roadsBody);
  const savedDemo = async (): Promise<string> => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'sp-demo-')), 'demo.json');
    await writeFile(file, JSON.stringify({ roads: [], fallbacksUsed: ['saved'] }));
    return file;
  };

  it('serves the saved demo when live data is too slow', async () => {
    const demoFile = await savedDemo();
    const hang: Fetcher = () => new Promise(() => {});
    const base = await serve(hang, demoFile, { demoDeadlineMs: 100 });
    const t0 = Date.now();
    const body = (await (await fetch(`${base}/api/area?lat=37&lon=-122&demo=1`)).json()) as { fallbacksUsed: string[] };
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(body.fallbacksUsed).toEqual(['saved', DEMO_NOTE]);
  });

  it('does not overwrite the saved demo with incomplete live data', async () => {
    const demoFile = await savedDemo();
    // Roads fine; elevation and wind down outside the US.
    const fetcher: Fetcher = async (url, init) => (url.includes('overpass') ? overpassOk(init) : new Response('err', { status: 500 }));
    const base = await serve(fetcher, demoFile);
    const body = (await (await fetch(`${base}/api/area?lat=37&lon=-122&demo=1&country=fr`)).json()) as AreaData;
    expect(body.elevation).toBeNull();
    expect(body.roads).toHaveLength(1);
    expect(JSON.parse(await readFile(demoFile, 'utf8')).fallbacksUsed).toEqual(['saved']);
  });

  const completeFetcher: Fetcher = async (url, init) => {
    if (url.includes('overpass')) return overpassOk(init);
    if (url.includes('/v1/elevation')) {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length;
      return new Response(JSON.stringify({ elevation: Array(n).fill(100) }));
    }
    if (url.includes('/v1/forecast')) return new Response('{"current":{"wind_speed_10m":8,"wind_direction_10m":270}}');
    return new Response('err', { status: 500 });
  };

  it('saves the demo when live data is complete', async () => {
    const demoFile = await savedDemo();
    const base = await serve(completeFetcher, demoFile);
    const res = await fetch(`${base}/api/area?lat=37&lon=-122&demo=1&country=us`);
    expect(res.status).toBe(200);
    const saved = JSON.parse(await readFile(demoFile, 'utf8')) as AreaData;
    expect(saved.fallbacksUsed).toEqual([]);
    expect(saved.wind?.speedMph).toBe(8);
    expect(isCompleteArea(saved)).toBe(true);
  });

  it('a failed snapshot write still returns live data', async () => {
    const base = await serve(completeFetcher, '/nonexistent/dir/demo.json');
    const res = await fetch(`${base}/api/area?lat=37&lon=-122&demo=1&country=us`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AreaData;
    expect(body.fallbacksUsed).toEqual([]);
    expect(body.wind?.speedMph).toBe(8);
  });
});
