// Outside data sources for one address: geocoding, roads, places, elevation, wind.
// Each source has a primary service and, where one exists, a fallback.

import type { AreaData, ElevationGrid, LatLon, RawPlace, RawRoadWay, Wind, XY } from '../src/engine/types.ts';
import { cachedFetch, type CacheOptions, type Fetcher } from './cache.ts';

export const USER_AGENT = 'SafePassage/0.1 (wildfire drill app)';

export interface SourceContext {
  cacheDir?: string;
  fetcher?: Fetcher;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lon: number;
  country: string;
}

export class RoadsUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Roads unavailable: ${String(cause)}`);
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

interface NominatimHit {
  display_name: string;
  lat: string;
  lon: string;
  address?: { country_code?: string };
}

export function parseNominatim(body: string): GeocodeResult[] {
  const hits = JSON.parse(body) as NominatimHit[];
  return hits.map((h) => ({
    label: h.display_name,
    lat: Number(h.lat),
    lon: Number(h.lon),
    country: (h.address?.country_code ?? '').toLowerCase(),
  }));
}

interface CensusResponse {
  result?: { addressMatches?: { matchedAddress: string; coordinates: { x: number; y: number } }[] };
}

export function parseCensus(body: string): GeocodeResult[] {
  const matches = (JSON.parse(body) as CensusResponse).result?.addressMatches ?? [];
  return matches.slice(0, 5).map((m) => ({
    label: m.matchedAddress,
    lat: m.coordinates.y,
    lon: m.coordinates.x,
    country: 'us',
  }));
}

export async function geocode(q: string, ctx: SourceContext = {}): Promise<GeocodeResult[]> {
  const query = q.trim();
  const base = ctx.fetcher ?? fetch;
  // The 1 request/second gate only applies to real network calls, not cache hits.
  const gated: Fetcher = async (url, init) => {
    await nominatimGate();
    return base(url, init);
  };

  let failures = 0;
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
    const results = parseNominatim(res.body).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    if (results.length > 0) return results;
  } catch {
    failures++;
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
    failures++;
    if (failures === 2) throw err;
    return [];
  }
}

// ---------- Overpass (roads and places) ----------

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

interface OsmElement {
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
    return Array.isArray(json.elements) && !(json.remark && /error|timed out/i.test(json.remark));
  } catch {
    return false;
  }
}

/** Per-endpoint timeout, a little above the query's own [timeout:90]. */
export const OVERPASS_TIMEOUT_MS = 95000;
/** Total time for one Overpass query across all endpoints. */
export const OVERPASS_BUDGET_MS = 150000;

async function overpass(query: string, ctx: SourceContext): Promise<{ elements: OsmElement[]; fetchedAt: string }> {
  let lastErr: unknown = new Error('no Overpass endpoint');
  const deadline = Date.now() + OVERPASS_BUDGET_MS;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const res = await cachedFetch(
        {
          method: 'POST',
          url: endpoint,
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeoutMs: Math.min(OVERPASS_TIMEOUT_MS, left),
          // Same entry for every endpoint, so a cached answer is used before any live call.
          cacheKey: `overpass:${query}`,
        },
        opts(ctx, { accept: isCompleteOverpass }),
      );
      return { elements: (JSON.parse(res.body) as { elements: OsmElement[] }).elements, fetchedAt: res.fetchedAt };
    } catch (err) {
      console.warn(`Overpass ${endpoint} failed: ${String(err)}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

const NEAR_HIGHWAYS = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$';
const FAR_HIGHWAYS = '^((motorway|trunk|primary|secondary|tertiary)(_link)?|unclassified)$';

export function roadsQuery(home: LatLon): string {
  const at = `${round6(home.lat)},${round6(home.lon)}`;
  return [
    '[out:json][timeout:90];',
    '(',
    `  way(around:3000,${at})["highway"~"${NEAR_HIGHWAYS}"];`,
    `  way(around:8000,${at})["highway"~"${FAR_HIGHWAYS}"];`,
    ');',
    'out body;',
    '>;',
    'out skel qt;',
  ].join('\n');
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

export function placesQuery(home: LatLon): string {
  const at = `${round6(home.lat)},${round6(home.lon)}`;
  const amenity = '["amenity"~"^(school|community_centre|townhall|library)$"]["name"]';
  const assembly = '["emergency"="assembly_point"]["name"]';
  return [
    '[out:json][timeout:60];',
    '(',
    `  node(around:8000,${at})${amenity};`,
    `  way(around:8000,${at})${amenity};`,
    `  node(around:8000,${at})${assembly};`,
    `  way(around:8000,${at})${assembly};`,
    ');',
    'out center tags;',
  ].join('\n');
}

const PLACE_KINDS = ['school', 'community_centre', 'townhall', 'library'] as const;

export function parsePlaces(elements: OsmElement[]): RawPlace[] {
  const places: RawPlace[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    const at = el.type === 'node' && el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : el.center;
    const id = `${el.type}/${el.id}`;
    if (!name || !at || seen.has(id)) continue;
    seen.add(id);
    const amenity = PLACE_KINDS.find((k) => k === tags.amenity);
    const kind: RawPlace['kind'] = amenity ?? (tags.emergency === 'assembly_point' ? 'assembly_point' : 'other');
    places.push({ id, name, kind, at: { lat: at.lat, lon: at.lon } });
  }
  return places;
}

export async function fetchRoads(home: LatLon, ctx: SourceContext = {}): Promise<{ roads: RawRoadWay[]; fetchedAt: string }> {
  const { elements, fetchedAt } = await overpass(roadsQuery(home), ctx);
  return { roads: parseRoads(elements, home), fetchedAt };
}

export async function fetchPlaces(home: LatLon, ctx: SourceContext = {}): Promise<{ places: RawPlace[]; fetchedAt: string }> {
  const { elements, fetchedAt } = await overpass(placesQuery(home), ctx);
  return { places: parsePlaces(elements), fetchedAt };
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
  const values: number[] = [];
  let fetchedAt = '';
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((p) => p.lat).join(',')}&longitude=${chunk
      .map((p) => p.lon)
      .join(',')}`;
    const res = await cachedFetch({ url, headers: { 'User-Agent': USER_AGENT } }, opts(ctx, { accept: isJson }));
    const elev = (JSON.parse(res.body) as { elevation?: number[] }).elevation;
    if (!elev || elev.length !== chunk.length || elev.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('Open-Meteo elevation: bad response');
    }
    values.push(...elev);
    if (res.fetchedAt > fetchedAt) fetchedAt = res.fetchedAt;
  }
  return { values, fetchedAt };
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

/** Fetch everything for one address in parallel. Throws RoadsUnavailableError when no Overpass endpoint answers. */
export async function buildArea(req: AreaRequest, ctx: SourceContext = {}): Promise<AreaData> {
  const { home } = req;
  const country = req.country.toLowerCase();
  const [roads, places, elevation, wind] = await Promise.allSettled([
    fetchRoads(home, ctx),
    fetchPlaces(home, ctx),
    fetchElevation(home, country, ctx),
    fetchWind(home, country, ctx),
  ]);
  if (roads.status === 'rejected') throw new RoadsUnavailableError(roads.reason);

  const fetchedAt: Record<string, string> = { 'Roads: OpenStreetMap (Overpass)': roads.value.fetchedAt };
  const fallbacksUsed: string[] = [];

  let placeList: RawPlace[] = [];
  if (places.status === 'fulfilled') {
    placeList = places.value.places;
    fetchedAt['Places: OpenStreetMap (Overpass)'] = places.value.fetchedAt;
  } else {
    fallbacksUsed.push('Places service: no named destinations, so exit points are used');
  }

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
    roads: roads.value.roads,
    places: placeList,
    elevation: elev.elevation,
    wind: w.wind,
    fetchedAt,
    fallbacksUsed,
  };
}
