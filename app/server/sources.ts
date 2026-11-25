// Outside data sources for one address: geocoding, roads, places, elevation, wind.
// Each source has a primary service and, where one exists, a fallback.

import type { AreaData, ElevationGrid, LatLon, RawPlace, RawRoadWay, Wind, XY } from '../src/engine/types.ts';
import { cachedFetch, HttpError, readCached, type CacheOptions, type Fetcher, type RequestSpec } from './cache.ts';

export const USER_AGENT = 'SafePassage/0.1 (wildfire drill app)';

export interface SourceContext {
  cacheDir?: string;
  fetcher?: Fetcher;
  /** Overrides for the Overpass time limits (tests use short ones). */
  overpassTiming?: Partial<OverpassTiming>;
}

/** How exactly the match places home: at the house, somewhere on the street, or only a town or landmark. */
export type GeocodePrecision = 'house' | 'street' | 'place';

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  country: string;
  precision: GeocodePrecision;
}

/** The address services answered but turned the query down (a 4xx other than rate limiting). */
export class GeocodeRejectedError extends Error {}

/** Why the map data could not be loaded: the server was busy, it ran out of time, or it failed another way. */
export type RoadsFailure = 'busy' | 'timeout' | 'failed';

export class RoadsUnavailableError extends Error {
  reason: RoadsFailure;
  constructor(cause: unknown, reason: RoadsFailure = 'failed') {
    super(`Roads unavailable: ${String(cause)}`);
    this.reason = reason;
  }
}

const M_PER_DEG_LAT = 111320;

// ---------- Small helpers ----------

/** Local equirectangular projection (same math as the engine): x east, y north of origin in meters. */
export function localToLatLon(origin: LatLon, p: XY): LatLon {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat + p.y / M_PER_DEG_LAT, lon: origin.lon + p.x / mPerDegLon };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns a function that resolves when the caller may make its request; spaces requests gapMs apart. */
export function makeGate(gapMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let last = 0;
  return () => {
    const turn = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    });
    chain = turn;
    return turn;
  };
}

/** Map over items with at most `limit` calls in flight. Keeps order. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function opts(ctx: SourceContext, extra: CacheOptions = {}): CacheOptions {
  return { dir: ctx.cacheDir, fetcher: ctx.fetcher, ...extra };
}

function isJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

// ---------- Geocoding ----------

const nominatimGate = makeGate(1000);

interface NominatimAddress {
  house_number?: string;
  road?: string;
  town?: string;
  village?: string;
  suburb?: string;
  hamlet?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface NominatimHit {
  display_name: string;
  name?: string;
  lat: string;
  lon: string;
  address?: NominatimAddress;
}

/**
 * A short label from the address parts: name, "house number road", town before city, "state postcode", country.
 * Falls back to display_name when there are no parts.
 */
export function nominatimLabel(h: NominatimHit): string {
  const a = h.address;
  if (!a) return h.display_name;
  const parts: string[] = [];
  const name = h.name?.trim();
  if (name && name !== a.road) parts.push(name);
  if (a.road) parts.push(a.house_number ? `${a.house_number} ${a.road}` : a.road);
  const local = a.town ?? a.village ?? a.suburb ?? a.hamlet;
  if (local) parts.push(local);
  if (a.city && a.city !== local) parts.push(a.city);
  if (!local && !a.city && a.county) parts.push(a.county);
  const region = [a.state, a.postcode].filter(Boolean).join(' ');
  if (region) parts.push(region);
  if (a.country) parts.push(a.country);
  return parts.length >= 2 ? parts.join(', ') : h.display_name;
}

export function nominatimPrecision(a: NominatimAddress | undefined): GeocodePrecision {
  if (a?.house_number && a.road) return 'house';
  if (a?.road) return 'street';
  return 'place';
}

/** Keeps the first result for each label, so the pick list never shows the same line twice. */
export function uniqueByLabel(results: GeocodeResult[]): GeocodeResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseNominatim(body: string): GeocodeResult[] {
  return resultsFromHits(JSON.parse(body) as NominatimHit[]);
}

/**
 * True when two hits are the same place: same country and postcode, and a street or place name in
 * common (Toronto "315 Main Street" and "Main Street, Main Bus Terminal", both M4C 1L3).
 */
function samePlace(a: NominatimHit, b: NominatimHit): boolean {
  const x = a.address;
  const y = b.address;
  if (!x?.postcode || x.postcode !== y?.postcode || x.country_code !== y.country_code) return false;
  const names = (h: NominatimHit) => [h.address?.road, h.name].filter((n): n is string => !!n && n.trim() !== '').map((n) => n.toLowerCase());
  const nb = names(b);
  return names(a).some((n) => nb.includes(n));
}

/** US matches first (a US-focused tool), keeping the service's order otherwise. */
function usFirst(hits: NominatimHit[]): NominatimHit[] {
  const us = (h: NominatimHit) => (h.address?.country_code ?? '').toLowerCase() === 'us';
  return [...hits.filter(us), ...hits.filter((h) => !us(h))];
}

function resultsFromHits(all: NominatimHit[]): GeocodeResult[] {
  const hits: NominatimHit[] = [];
  for (const h of usFirst(all)) if (!hits.some((k) => samePlace(k, h))) hits.push(h);
  return uniqueByLabel(
    hits.map((h) => ({
      label: nominatimLabel(h),
      lat: Number(h.lat),
      lon: Number(h.lon),
      country: (h.address?.country_code ?? '').toLowerCase(),
      precision: nominatimPrecision(h.address),
    })),
  );
}

interface CensusResponse {
  result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] };
}

export function parseCensus(body: string): GeocodeResult[] {
  const matches = (JSON.parse(body) as CensusResponse).result?.addressMatches ?? [];
  return uniqueByLabel(
    matches.slice(0, 5).map((m) => ({
      label: m.matchedAddress,
      lat: m.coordinates.y,
      lon: m.coordinates.x,
      country: 'us',
      precision: 'house' as const,
    })),
  );
}

/** True when a hit names only a big city (Sydney for Katoomba), with no town or suburb. */
export function lacksLocality(h: NominatimHit): boolean {
  const a = h.address;
  return !!a && !!a.city && !(a.town ?? a.village ?? a.suburb ?? a.hamlet);
}

/** The town or suburb from a Nominatim reverse lookup, or null. Never the same as `city`. */
export function localityFromReverse(body: string, city: string | undefined): string | null {
  const a = (JSON.parse(body) as NominatimHit).address;
  const local = a ? a.town ?? a.village ?? a.suburb ?? a.hamlet : undefined;
  return local && local !== city ? local : null;
}

/** True when the service answered and refused the query itself (not rate limiting). */
function isRejection(err: unknown): boolean {
  return err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * Nominatim first, then the US Census geocoder. Throws GeocodeRejectedError when a service turned the
 * query down, or the last error when both services failed.
 */
export async function geocode(q: string, ctx: SourceContext = {}): Promise<GeocodeResult[]> {
  const query = q.trim();
  const base = ctx.fetcher ?? fetch;
  // The 1 request/second gate only applies to real network calls, not cache hits.
  const gated: Fetcher = async (url, init) => {
    await nominatimGate();
    return base(url, init);
  };

  const errors: unknown[] = [];
  try {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      limit: '5',
    })}`;
    const res = await cachedFetch(
      { url, headers: { 'User-Agent': USER_AGENT } },
      { dir: ctx.cacheDir, fetcher: gated, accept: isJson },
    );
    const hits = JSON.parse(res.body) as NominatimHit[];
    // A hit that names only a big city gets its town or suburb from a reverse lookup (first hit only).
    const first = hits[0];
    if (first && lacksLocality(first)) {
      try {
        const rev = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({ lat: first.lat, lon: first.lon, format: 'json', zoom: '14', addressdetails: '1' })}`;
        const r = await cachedFetch({ url: rev, headers: { 'User-Agent': USER_AGENT } }, { dir: ctx.cacheDir, fetcher: gated, accept: isJson });
        const local = localityFromReverse(r.body, first.address?.city);
        if (local && first.address) first.address = { ...first.address, suburb: local };
      } catch {
        // Keep the city-only label.
      }
    }
    const results = resultsFromHits(hits).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (results.length > 0) return results;
  } catch (err) {
    errors.push(err);
  }

  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({
      address: query,
      benchmark: 'Public_AR_Current',
      format: 'json',
    })}`;
    const res = await cachedFetch({ url, headers: { 'User-Agent': USER_AGENT } }, opts(ctx, { accept: isJson }));
    return parseCensus(res.body);
  } catch (err) {
    errors.push(err);
    if (errors.some(isRejection)) throw new GeocodeRejectedError(`Address query rejected: ${String(err)}`);
    if (errors.length === 2) throw err;
    return [];
  }
}

// ---------- Overpass (roads and places) ----------

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  tags?: Record<string, string>;
}

/** Overpass answers 200 with a "remark" when a query times out; treat that as a failure. */
function isCompleteOverpass(body: string): boolean {
  try {
    const json = JSON.parse(body) as { elements?: unknown; remark?: string };
    return Array.isArray(json.elements) && !(json.remark && /error|timed out|out of memory/i.test(json.remark));
  } catch {
    return false;
  }
}

/**
 * Time limits for the one Overpass query per address. The main server gets one retry after a
 * "busy" answer (429, 502, 504); the backup mirror gets a short attempt; the whole call fits in budgetMs.
 */
export interface OverpassTiming {
  budgetMs: number;
  primaryMs: number;
  mirrorMs: number;
  /** Longest wait taken from a Retry-After header. */
  retryCapMs: number;
  /** Wait before the retry when the server sent no Retry-After. */
  retryDefaultMs: number;
}

// Measured 2026-11-25: overpass-api.de took 70-80 s for a full-size cold query (even small
// queries took ~40 s), so the main attempt must allow well over a minute.
export const OVERPASS_TIMING: OverpassTiming = {
  budgetMs: 110000,
  primaryMs: 95000,
  mirrorMs: 30000,
  retryCapMs: 8000,
  retryDefaultMs: 3000,
};

/** An attempt with less time than this left is not started. */
const MIN_ATTEMPT_MS = 5000;

const BUSY_STATUS = new Set([429, 502, 504]);

function isBusy(err: unknown): boolean {
  return err instanceof HttpError && BUSY_STATUS.has(err.status);
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Runs one task at a time, in call order. A failed task does not block the next. */
export function makeLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

/** Rejects when the signal aborts, even if `p` never settles. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** One Overpass call at a time from this process, so our own queries never compete for the per-IP slots. */
const overpassLock = makeLock();

function lockedFetcher(base: Fetcher): Fetcher {
  return (url, init) =>
    overpassLock(async () => {
      const res = await untilAborted(base(url, init), init?.signal);
      const text = await untilAborted(res.text(), init?.signal);
      return new Response(text, { status: res.status, headers: res.headers });
    });
}

/** Where the map data came from, for the loading screen. */
export type MapServer = 'main' | 'backup' | 'cache';

/** Live state of one area load. buildArea updates it; GET /api/area-status returns it. */
export type PartState = 'waiting' | 'working' | 'done' | 'failed';

export interface AreaProgress {
  roads: PartState;
  places: PartState;
  terrain: PartState;
  wind: PartState;
  /** Overpass attempts started so far (0 before the first, 1 on the first try). */
  mapAttempt: number;
  mapServer: MapServer | null;
  /** True once the main map server has answered "busy". */
  mapBusy: boolean;
}

export function newProgress(): AreaProgress {
  return { roads: 'waiting', places: 'waiting', terrain: 'waiting', wind: 'waiting', mapAttempt: 0, mapServer: null, mapBusy: false };
}

interface OverpassResult {
  elements: OsmElement[];
  fetchedAt: string;
}

async function overpass(query: string, ctx: SourceContext, progress?: AreaProgress): Promise<OverpassResult> {
  const timing = { ...OVERPASS_TIMING, ...ctx.overpassTiming };
  const deadline = Date.now() + timing.budgetMs;
  const fetcher = lockedFetcher(ctx.fetcher ?? fetch);
  const [primary, mirror] = OVERPASS_ENDPOINTS;

  const attempt = async (endpoint: string, server: MapServer, capMs: number): Promise<OverpassResult> => {
    if (progress) {
      progress.mapAttempt++;
      progress.mapServer = server;
    }
    const res = await cachedFetch(
      {
        method: 'POST',
        url: endpoint,
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeoutMs: Math.min(capMs, deadline - Date.now()),
        // Same entry for every endpoint, so a cached answer is used before any live call.
        cacheKey: `overpass:${query}`,
      },
      { dir: ctx.cacheDir, fetcher, accept: isCompleteOverpass },
    );
    if (progress && res.fromCache) progress.mapServer = 'cache';
    return { elements: (JSON.parse(res.body) as { elements: OsmElement[] }).elements, fetchedAt: res.fetchedAt };
  };
  const left = () => deadline - Date.now();
  const errors: unknown[] = [];
  const failWith = (err: unknown, where: string) => {
    console.warn(`Overpass ${where} failed: ${String(err)}`);
    errors.push(err);
  };

  try {
    return await attempt(primary, 'main', timing.primaryMs);
  } catch (err) {
    failWith(err, primary);
    if (isBusy(err)) {
      if (progress) progress.mapBusy = true;
      const after = (err as HttpError).retryAfterS;
      const wait = Math.min(timing.retryCapMs, after !== undefined ? after * 1000 : timing.retryDefaultMs);
      if (left() - wait >= MIN_ATTEMPT_MS) {
        await sleep(wait);
        try {
          return await attempt(primary, 'main', timing.primaryMs);
        } catch (err2) {
          failWith(err2, `${primary} (retry)`);
        }
      }
    }
  }
  if (left() >= MIN_ATTEMPT_MS) {
    try {
      return await attempt(mirror, 'backup', timing.mirrorMs);
    } catch (err) {
      failWith(err, mirror);
    }
  }
  const last = errors[errors.length - 1] ?? new Error('Overpass: no time left');
  const reason: RoadsFailure = errors.some(isBusy) ? 'busy' : errors.length === 0 || errors.some(isTimeout) ? 'timeout' : 'failed';
  throw new RoadsUnavailableError(last, reason);
}

const NEAR_HIGHWAYS = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$';
const FAR_HIGHWAYS = '^((motorway|trunk|primary|secondary|tertiary)(_link)?|unclassified)$';
const MINOR_HIGHWAYS = '^(unclassified|residential|living_street|service)$';
/** Minor roads are also loaded this close to each candidate place, so places beyond 3 km can be reached. */
export const PLACE_ROADS_M = 600;

const PLACE_AMENITY = '["amenity"~"^(school|community_centre|townhall|library)$"]["name"]';
const PLACE_ASSEMBLY = '["emergency"="assembly_point"]["name"]';

/**
 * One query for the whole map: candidate places (with centers and tags), then the roads, then the road nodes.
 * Minor roads within 3 km of home and within PLACE_ROADS_M of each place; major roads within 8 km.
 */
export function mapQuery(home: LatLon): string {
  const at = `${round6(home.lat)},${round6(home.lon)}`;
  return [
    '[out:json][timeout:40][maxsize:134217728];',
    '(',
    `  node(around:8000,${at})${PLACE_AMENITY};`,
    `  way(around:8000,${at})${PLACE_AMENITY};`,
    `  node(around:8000,${at})${PLACE_ASSEMBLY};`,
    `  way(around:8000,${at})${PLACE_ASSEMBLY};`,
    ')->.places;',
    '.places out center tags;',
    '(',
    `  way(around:3000,${at})["highway"~"${NEAR_HIGHWAYS}"];`,
    `  way(around:8000,${at})["highway"~"${FAR_HIGHWAYS}"];`,
    `  way(around.places:${PLACE_ROADS_M})["highway"~"${MINOR_HIGHWAYS}"];`,
    ')->.roads;',
    '.roads out body;',
    'node(w.roads);',
    'out skel qt;',
  ].join('\n');
}

/** The two separate queries used before mapQuery. Read only from the cache, so areas loaded earlier stay instant. */
function legacyQueries(home: LatLon): [string, string] {
  const at = `${round6(home.lat)},${round6(home.lon)}`;
  const roads = [
    '[out:json][timeout:90];',
    '(',
    `  way(around:3000,${at})["highway"~"${NEAR_HIGHWAYS}"];`,
    `  way(around:8000,${at})["highway"~"${FAR_HIGHWAYS}"];`,
    ');',
    'out body;',
    '>;',
    'out skel qt;',
  ].join('\n');
  const places = [
    '[out:json][timeout:60];',
    '(',
    `  node(around:8000,${at})${PLACE_AMENITY};`,
    `  way(around:8000,${at})${PLACE_AMENITY};`,
    `  node(around:8000,${at})${PLACE_ASSEMBLY};`,
    `  way(around:8000,${at})${PLACE_ASSEMBLY};`,
    ');',
    'out center tags;',
  ].join('\n');
  return [roads, places];
}

function overpassSpec(query: string): RequestSpec {
  return { method: 'POST', url: OVERPASS_ENDPOINTS[0], cacheKey: `overpass:${query}` };
}

/** "25 mph" -> 25; "40" or "40 km/h" -> km/h converted to mph; anything else (none, signals, US:urban) -> undefined. */
export function parseMaxspeedMph(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(raw.split(';')[0]);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!(value > 0)) return undefined;
  if (m[2]?.toLowerCase() === 'mph') return value;
  return Math.round(value * 0.621371 * 10) / 10;
}

/** OSM oneway tag -> direction. Without a tag, motorways, motorway links, roundabouts and circular junctions are oneway. */
export function parseOneway(tags: Record<string, string>): 'forward' | 'reverse' | 'both' {
  const v = (tags.oneway ?? '').toLowerCase();
  if (v === '-1' || v === 'reverse') return 'reverse';
  if (v === 'yes' || v === '1' || v === 'true') return 'forward';
  if (v === '') {
    if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 'forward';
    if (tags.junction === 'roundabout' || tags.junction === 'circular') return 'forward';
  }
  return 'both';
}

/** True when cars may not use the way: emergency-access roads, or access/vehicle tags of no or private. */
export function isRestricted(tags: Record<string, string>): boolean {
  if (tags.service === 'emergency_access') return true;
  // The most specific tag wins: motorcar, then motor_vehicle, then vehicle, then access.
  const v = (tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access ?? '').toLowerCase();
  return v === 'no' || v === 'private';
}

/** A private way with a node this close to home is kept: it is likely the home's own driveway or lane. */
export const OWN_DRIVEWAY_M = 300;

function metersBetween(a: LatLon, b: LatLon): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * Overpass elements -> road ways. Drops ways cars may not use (see isRestricted), except
 * no/private ways that come within OWN_DRIVEWAY_M of `home`. Emergency-access roads are always dropped.
 */
export function parseRoads(elements: OsmElement[], home?: LatLon): RawRoadWay[] {
  const nodes = new Map<number, LatLon>();
  for (const el of elements) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) nodes.set(el.id, { lat: el.lat, lon: el.lon });
  }
  const seen = new Set<number>();
  const roads: RawRoadWay[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.highway || !el.nodes || seen.has(el.id)) continue;
    seen.add(el.id);
    let nodeIds = el.nodes.filter((id) => nodes.has(id));
    if (nodeIds.length < 2) continue;
    if (isRestricted(el.tags)) {
      const ownDriveway =
        el.tags.service !== 'emergency_access' &&
        home !== undefined &&
        nodeIds.some((id) => metersBetween(home, nodes.get(id)!) <= OWN_DRIVEWAY_M);
      if (!ownDriveway) continue;
    }
    const dir = parseOneway(el.tags);
    if (dir === 'reverse') nodeIds = [...nodeIds].reverse();
    const road: RawRoadWay = {
      id: el.id,
      highway: el.tags.highway,
      coords: nodeIds.map((id) => nodes.get(id)!),
      nodeIds,
    };
    const name = el.tags.name ?? el.tags.ref;
    if (name) road.name = name;
    const mph = parseMaxspeedMph(el.tags.maxspeed);
    if (mph !== undefined) road.maxspeedMph = mph;
    if (dir !== 'both') road.oneway = true;
    roads.push(road);
  }
  return roads;
}

const PLACE_KINDS = ['school', 'community_centre', 'townhall', 'library'] as const;

/** Abandoned, disused or former buildings are never offered as destinations. */
export function isDefunctPlace(tags: Record<string, string>): boolean {
  const yes = (v: string | undefined) => v !== undefined && v !== 'no';
  if (yes(tags.abandoned) || yes(tags.disused)) return true;
  if (tags['abandoned:amenity'] || tags['disused:amenity']) return true;
  return /\b(abandoned|disused)\b|\(former\)/i.test(tags.name ?? '');
}

export function parsePlaces(elements: OsmElement[]): RawPlace[] {
  const places: RawPlace[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    const at = el.type === 'node' && el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : el.center;
    const id = `${el.type}/${el.id}`;
    if (!name || !at || seen.has(id) || isDefunctPlace(tags)) continue;
    const amenity = PLACE_KINDS.find((k) => k === tags.amenity);
    const assembly = tags.emergency === 'assembly_point';
    // Road elements share the response; only real candidate places count.
    if (!amenity && !assembly) continue;
    seen.add(id);
    places.push({ id, name, kind: amenity ?? 'assembly_point', at: { lat: at.lat, lon: at.lon } });
  }
  return places;
}

export interface MapData {
  roads: RawRoadWay[];
  places: RawPlace[];
  fetchedAt: string;
}

/** Roads and candidate places for one address, from one Overpass response (or the cache). */
export async function fetchMap(home: LatLon, ctx: SourceContext = {}, progress?: AreaProgress): Promise<MapData> {
  const [legacyRoads, legacyPlaces] = legacyQueries(home);
  const cacheOpts = { dir: ctx.cacheDir };
  const [oldRoads, oldPlaces] = await Promise.all([
    readCached(overpassSpec(legacyRoads), cacheOpts),
    readCached(overpassSpec(legacyPlaces), cacheOpts),
  ]);
  const isNew = await readCached(overpassSpec(mapQuery(home)), cacheOpts);
  if (!isNew && oldRoads && oldPlaces && isCompleteOverpass(oldRoads.body) && isCompleteOverpass(oldPlaces.body)) {
    if (progress) progress.mapServer = 'cache';
    const roadEls = (JSON.parse(oldRoads.body) as { elements: OsmElement[] }).elements;
    const placeEls = (JSON.parse(oldPlaces.body) as { elements: OsmElement[] }).elements;
    return { roads: parseRoads(roadEls, home), places: parsePlaces(placeEls), fetchedAt: oldRoads.fetchedAt };
  }
  const { elements, fetchedAt } = await overpass(mapQuery(home), ctx, progress);
  return { roads: parseRoads(elements, home), places: parsePlaces(elements), fetchedAt };
}

// ---------- Elevation ----------

/** Sample points of an n x n grid centered on home, row-major with row 0 = south. */
export function gridPoints(home: LatLon, n: number, spacing: number): { originXY: XY; points: LatLon[] } {
  const half = ((n - 1) / 2) * spacing;
  const originXY = { x: -half, y: -half };
  const points: LatLon[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const p = localToLatLon(home, { x: originXY.x + c * spacing, y: originXY.y + r * spacing });
      points.push({ lat: round6(p.lat), lon: round6(p.lon) });
    }
  }
  return { originXY, points };
}

async function openMeteoElevation(points: LatLon[], ctx: SourceContext): Promise<{ values: number[]; fetchedAt: string }> {
  const chunks: LatLon[][] = [];
  for (let i = 0; i < points.length; i += 100) chunks.push(points.slice(i, i + 100));
  let fetchedAt = '';
  const parts = await mapPool(chunks, 5, async (chunk) => {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((p) => p.lat).join(',')}&longitude=${chunk
      .map((p) => p.lon)
      .join(',')}`;
    const res = await cachedFetch({ url, headers: { 'User-Agent': USER_AGENT } }, opts(ctx, { accept: isJson }));
    const elev = (JSON.parse(res.body) as { elevation?: number[] }).elevation;
    if (!elev || elev.length !== chunk.length || elev.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('Open-Meteo elevation: bad response');
    }
    if (res.fetchedAt > fetchedAt) fetchedAt = res.fetchedAt;
    return elev;
  });
  return { values: parts.flat(), fetchedAt };
}

async function usgsElevation(points: LatLon[], ctx: SourceContext): Promise<{ values: number[]; fetchedAt: string }> {
  let fetchedAt = '';
  const values = await mapPool(points, 8, async (p) => {
    const url = `https://epqs.nationalmap.gov/v1/json?x=${p.lon}&y=${p.lat}&units=Meters&wkid=4326`;
    const res = await cachedFetch({ url, headers: { 'User-Agent': USER_AGENT } }, opts(ctx, { accept: isJson }));
    const v = Number((JSON.parse(res.body) as { value?: unknown }).value);
    if (!Number.isFinite(v)) throw new Error('USGS EPQS: bad value');
    if (res.fetchedAt > fetchedAt) fetchedAt = res.fetchedAt;
    return v < -1000 ? 0 : v; // EPQS uses -1000000 for "no data" (water)
  });
  return { values, fetchedAt };
}

export interface ElevationOutcome {
  elevation: ElevationGrid | null;
  service?: string;
  fetchedAt?: string;
  notes: string[];
}

export async function fetchElevation(home: LatLon, country: string, ctx: SourceContext = {}): Promise<ElevationOutcome> {
  try {
    const { originXY, points } = gridPoints(home, 21, 300);
    const { values, fetchedAt } = await openMeteoElevation(points, ctx);
    return { elevation: { rows: 21, cols: 21, originXY, spacing: 300, values }, service: 'Elevation: Open-Meteo', fetchedAt, notes: [] };
  } catch {
    // fall through
  }
  if (country === 'us') {
    try {
      const { originXY, points } = gridPoints(home, 11, 600);
      const { values, fetchedAt } = await usgsElevation(points, ctx);
      return {
        elevation: { rows: 11, cols: 11, originXY, spacing: 600, values },
        service: 'Elevation: USGS EPQS',
        fetchedAt,
        notes: ['Elevation: Open-Meteo failed, used USGS on a coarser 600 m grid'],
      };
    } catch {
      // fall through
    }
  }
  return { elevation: null, notes: ['Elevation service: fire spreads as if the ground is flat'] };
}

// ---------- Wind ----------

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassToDeg(dir: string): number | undefined {
  const i = COMPASS.indexOf(dir.trim().toUpperCase());
  return i < 0 ? undefined : i * 22.5;
}

/** NWS wind speed text: "10 mph" -> 10, "5 to 15 mph" -> 15 (the higher value, to stay cautious). */
export function parseNwsWindSpeed(text: string): number | undefined {
  const nums = (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  return nums.length ? Math.max(...nums) : undefined;
}

export interface WindOutcome {
  wind: Wind | null;
  service?: string;
  notes: string[];
}

const WIND_TTL_MIN = 60;

async function openMeteoWind(home: LatLon, ctx: SourceContext): Promise<Wind> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${round6(home.lat)}&longitude=${round6(
    home.lon,
  )}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=mph`;
  const res = await cachedFetch({ url, headers: { 'User-Agent': USER_AGENT } }, opts(ctx, { ttlMin: WIND_TTL_MIN, accept: isJson }));
  const cur = (JSON.parse(res.body) as { current?: { wind_speed_10m?: number; wind_direction_10m?: number } }).current;
  if (typeof cur?.wind_speed_10m !== 'number' || typeof cur.wind_direction_10m !== 'number') {
    throw new Error('Open-Meteo wind: bad response');
  }
  return { fromDeg: cur.wind_direction_10m, speedMph: cur.wind_speed_10m, source: 'forecast', fetchedAt: res.fetchedAt };
}

async function nwsWind(home: LatLon, ctx: SourceContext): Promise<Wind> {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' };
  const pointsUrl = `https://api.weather.gov/points/${home.lat.toFixed(4)},${home.lon.toFixed(4)}`;
  const points = await cachedFetch({ url: pointsUrl, headers }, opts(ctx, { accept: isJson }));
  const hourlyUrl = (JSON.parse(points.body) as { properties?: { forecastHourly?: string } }).properties?.forecastHourly;
  if (!hourlyUrl) throw new Error('NWS: no hourly forecast');
  const hourly = await cachedFetch({ url: hourlyUrl, headers }, opts(ctx, { ttlMin: WIND_TTL_MIN, accept: isJson }));
  const period = (JSON.parse(hourly.body) as { properties?: { periods?: { windSpeed?: string; windDirection?: string }[] } })
    .properties?.periods?.[0];
  const speedMph = parseNwsWindSpeed(period?.windSpeed ?? '');
  const fromDeg = compassToDeg(period?.windDirection ?? '');
  if (speedMph === undefined || fromDeg === undefined) throw new Error('NWS: bad wind');
  return { fromDeg, speedMph, source: 'forecast', fetchedAt: hourly.fetchedAt };
}

export async function fetchWind(home: LatLon, country: string, ctx: SourceContext = {}): Promise<WindOutcome> {
  try {
    return { wind: await openMeteoWind(home, ctx), service: 'Wind: Open-Meteo forecast', notes: [] };
  } catch {
    // fall through
  }
  if (country === 'us') {
    try {
      return {
        wind: await nwsWind(home, ctx),
        service: 'Wind: National Weather Service hourly forecast',
        notes: ['Wind: Open-Meteo failed, used the National Weather Service forecast'],
      };
    } catch {
      // fall through
    }
  }
  return { wind: null, notes: ['Wind service: set the wind by hand'] };
}

// ---------- Whole area ----------

export interface AreaRequest {
  home: LatLon;
  label: string;
  country: string;
}

/** Marks a part working, then done or failed when the promise settles. */
function track<T>(p: () => Promise<T>, progress: AreaProgress | undefined, parts: ('roads' | 'places' | 'terrain' | 'wind')[]): Promise<T> {
  if (progress) for (const k of parts) progress[k] = 'working';
  const run = p();
  if (progress) {
    run.then(
      () => { for (const k of parts) progress[k] = 'done'; },
      () => { for (const k of parts) progress[k] = 'failed'; },
    );
  }
  return run;
}

/**
 * Fetch everything for one address in parallel: one Overpass call for roads and places, plus terrain and wind.
 * Throws RoadsUnavailableError when no Overpass endpoint answers in time. Updates `progress` as parts finish.
 */
export async function buildArea(req: AreaRequest, ctx: SourceContext = {}, progress?: AreaProgress): Promise<AreaData> {
  const { home } = req;
  const country = req.country.toLowerCase();
  const [map, elevation, wind] = await Promise.allSettled([
    track(() => fetchMap(home, ctx, progress), progress, ['roads', 'places']),
    track(() => fetchElevation(home, country, ctx), progress, ['terrain']),
    track(() => fetchWind(home, country, ctx), progress, ['wind']),
  ]);
  if (map.status === 'rejected') {
    throw map.reason instanceof RoadsUnavailableError ? map.reason : new RoadsUnavailableError(map.reason);
  }

  const fetchedAt: Record<string, string> = {
    'Roads: OpenStreetMap (Overpass)': map.value.fetchedAt,
    'Places: OpenStreetMap (Overpass)': map.value.fetchedAt,
  };
  const fallbacksUsed: string[] = [];

  // fetchElevation and fetchWind never reject, but stay safe.
  const elev: ElevationOutcome =
    elevation.status === 'fulfilled' ? elevation.value : { elevation: null, notes: ['Elevation service: fire spreads as if the ground is flat'] };
  if (elev.service && elev.fetchedAt) fetchedAt[elev.service] = elev.fetchedAt;
  fallbacksUsed.push(...elev.notes);

  const w: WindOutcome = wind.status === 'fulfilled' ? wind.value : { wind: null, notes: ['Wind service: set the wind by hand'] };
  if (w.service && w.wind?.fetchedAt) fetchedAt[w.service] = w.wind.fetchedAt;
  fallbacksUsed.push(...w.notes);

  return {
    home,
    addressLabel: req.label,
    country,
    roads: map.value.roads,
    places: map.value.places,
    elevation: elev.elevation,
    wind: w.wind,
    fetchedAt,
    fallbacksUsed,
  };
}
