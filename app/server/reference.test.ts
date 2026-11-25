import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fetcher } from './cache.ts';
import { startServer } from './index.ts';
import {
  BadKeyError, clearReferenceCache, distanceToPolygonM, envelope, fetchReference, firmsUrl, parseFirmsCsv, parsePerimeters, perimeterQueryUrl,
  REFERENCE_TTL_MS, type ReferenceData,
} from './reference.ts';

const home = { lat: 37.1275, lon: -122.1238 };
const M_PER_DEG_LAT = 111320;

/** A square perimeter 0.01 degree wide whose west edge is `km` east of home. */
function squareEast(km: number): [number, number][] {
  const lon0 = home.lon + (km * 1000) / (M_PER_DEG_LAT * Math.cos((home.lat * Math.PI) / 180));
  return [[lon0, home.lat - 0.005], [lon0 + 0.01, home.lat - 0.005], [lon0 + 0.01, home.lat + 0.005], [lon0, home.lat + 0.005], [lon0, home.lat - 0.005]];
}

function wfigsBody(features: { name: string; acres?: number; date?: number; rings: [number, number][][] }[]): string {
  return JSON.stringify({
    features: features.map((f) => ({
      attributes: { poly_IncidentName: f.name, attr_IncidentName: f.name.toUpperCase(), poly_GISAcres: f.acres ?? null, poly_DateCurrent: f.date ?? null },
      geometry: { rings: f.rings },
    })),
  });
}

const CSV_HEAD = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';

beforeEach(() => clearReferenceCache());

describe('geometry', () => {
  it('envelope is about 50 km each way', () => {
    const [w, s, e, n] = envelope(home);
    expect((n - s) * M_PER_DEG_LAT).toBeCloseTo(100000, -3);
    expect((e - w) * M_PER_DEG_LAT * Math.cos((home.lat * Math.PI) / 180)).toBeCloseTo(100000, -3);
  });

  it('distance to a polygon: outside, inside and inside a hole', () => {
    expect(distanceToPolygonM(home, [squareEast(3)])).toBeCloseTo(3000, -1);
    const around: [number, number][] = [[home.lon - 0.01, home.lat - 0.01], [home.lon + 0.01, home.lat - 0.01], [home.lon + 0.01, home.lat + 0.01], [home.lon - 0.01, home.lat + 0.01]];
    expect(distanceToPolygonM(home, [around])).toBe(0);
    const hole: [number, number][] = [[home.lon - 0.001, home.lat - 0.001], [home.lon + 0.001, home.lat - 0.001], [home.lon + 0.001, home.lat + 0.001], [home.lon - 0.001, home.lat + 0.001]];
    expect(distanceToPolygonM(home, [around, hole])).toBeGreaterThan(80);
  });
});

describe('parsers', () => {
  it('perimeters: names, acres, update time, nearest first, empty rings dropped', () => {
    const body = wfigsBody([
      { name: 'Far', acres: 120.5, date: Date.UTC(2026, 10, 24, 18), rings: [squareEast(20)] },
      { name: 'Near', rings: [squareEast(2)] },
      { name: 'Broken', rings: [] },
    ]);
    const p = parsePerimeters(body, home);
    expect(p.map((x) => x.name)).toEqual(['Near', 'Far']);
    expect(p[0].acres).toBeNull();
    expect(p[0].updatedAt).toBeNull();
    expect(p[1].acres).toBe(120.5);
    expect(p[1].updatedAt).toBe('2026-11-24T18:00:00.000Z');
    expect(p[0].distanceM).toBeCloseTo(2000, -1);
  });

  it('perimeters: an ArcGIS error answer throws', () => {
    expect(() => parsePerimeters(JSON.stringify({ error: { code: 400, message: 'Invalid query' } }), home)).toThrow(/Invalid query/);
  });

  it('FIRMS CSV: rows, times in UTC, confidence words; key complaints and junk', () => {
    const lat = home.lat + 0.05;
    const csv = `${CSV_HEAD}\n${lat},${home.lon},330,0.4,0.4,2026-11-24,912,N20,VIIRS,h,2.0NRT,290,5.1,N\nbad,row\n`;
    const d = parseFirmsCsv(csv, home);
    expect(d).toHaveLength(1);
    expect(d[0].acquiredAt).toBe('2026-11-24T09:12:00.000Z');
    expect(d[0].confidence).toBe('high');
    expect(d[0].satellite).toBe('N20');
    expect(d[0].distanceM).toBeCloseTo(0.05 * M_PER_DEG_LAT, -1);
    expect(parseFirmsCsv(CSV_HEAD, home)).toEqual([]);
    expect(() => parseFirmsCsv('Invalid MAP_KEY.', home)).toThrow(BadKeyError);
    expect(() => parseFirmsCsv('<html>down</html>', home)).toThrow(/not detection data/);
  });

  it('URLs: envelope query and FIRMS area path', () => {
    const q = new URL(perimeterQueryUrl(home));
    expect(q.hostname).toBe('services3.arcgis.com');
    expect(q.searchParams.get('geometryType')).toBe('esriGeometryEnvelope');
    expect(q.searchParams.get('outSR')).toBe('4326');
    expect(firmsUrl('KEY', 'VIIRS_NOAA20_NRT', home)).toMatch(/\/api\/area\/csv\/KEY\/VIIRS_NOAA20_NRT\/-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+\/2$/);
  });
});

describe('fetchReference', () => {
  function recording(handler: (url: string) => Response): { fetcher: Fetcher; calls: string[] } {
    const calls: string[] = [];
    return { calls, fetcher: async (url) => { calls.push(url); return handler(url); } };
  }

  it('no key: perimeters only, detections say no_key, no FIRMS call', async () => {
    const r = recording(() => new Response(wfigsBody([{ name: 'Near', rings: [squareEast(4)] }])));
    const data = await fetchReference(home, 'us', { fetcher: r.fetcher, firmsKey: '' });
    expect(data.detections).toEqual({ available: false, reason: 'no_key', source: expect.any(String) });
    expect(data.perimeters.available).toBe(true);
    if (data.perimeters.available) expect(data.perimeters.items[0].name).toBe('Near');
    expect(r.calls).toHaveLength(1);
  });

  it('outside the US: perimeters are not requested', async () => {
    const r = recording(() => new Response(CSV_HEAD));
    const data = await fetchReference({ lat: -33.7, lon: 150.3 }, 'au', { fetcher: r.fetcher, firmsKey: 'KEY' });
    expect(data.perimeters).toMatchObject({ available: false, reason: 'outside_us' });
    expect(data.notes.join(' ')).toMatch(/US only/);
    expect(r.calls.every((u) => u.includes('firms'))).toBe(true);
    expect(data.detections).toMatchObject({ available: true, items: [] });
  });

  it('caches for 30 minutes, then asks again', async () => {
    let t = Date.UTC(2026, 10, 25, 12);
    const r = recording((url) => (url.includes('firms') ? new Response(CSV_HEAD) : new Response(wfigsBody([]))));
    const opts = { fetcher: r.fetcher, firmsKey: 'KEY', now: () => t };
    const first = await fetchReference(home, 'us', opts);
    expect(r.calls).toHaveLength(3); // WFIGS + two FIRMS sources
    t += REFERENCE_TTL_MS - 1000;
    const second = await fetchReference(home, 'us', opts);
    expect(r.calls).toHaveLength(3);
    expect(second.perimeters).toEqual(first.perimeters);
    t += 2000;
    await fetchReference(home, 'us', opts);
    expect(r.calls).toHaveLength(6);
  });

  it('service failures and a bad key are reported, never thrown', async () => {
    const r = recording((url) => (url.includes('firms') ? new Response('Invalid MAP_KEY.', { status: 400 }) : new Response('err', { status: 503 })));
    const data = await fetchReference(home, 'us', { fetcher: r.fetcher, firmsKey: 'BAD' });
    expect(data.perimeters).toMatchObject({ available: false, reason: 'failed' });
    expect(data.detections).toMatchObject({ available: false, reason: 'bad_key' });
  });
});

describe('GET /api/reference', () => {
  let close: (() => void) | null = null;
  afterEach(() => { close?.(); close = null; });

  it('400 on bad coordinates, 200 with both parts', async () => {
    const fetcher: Fetcher = async () => new Response(wfigsBody([{ name: 'Near', acres: 50, rings: [squareEast(4)] }]));
    const server = startServer(0, { fetcher, reference: { firmsKey: '' } });
    await new Promise((r) => server.once('listening', r));
    close = () => server.close();
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/reference?lat=x&lon=1`)).status).toBe(400);
    const res = await fetch(`${base}/api/reference?lat=${home.lat}&lon=${home.lon}&country=us`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReferenceData;
    expect(body.perimeters.available && body.perimeters.items[0].acres).toBe(50);
    expect(body.detections).toMatchObject({ available: false, reason: 'no_key' });
    expect(typeof body.fetchedAt).toBe('string');
  });
});
