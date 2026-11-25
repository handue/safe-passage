// Reference layer: real fires near home, shown beside the drill and never mixed into it.
// - US current fire perimeters from NIFC / WFIGS (ArcGIS FeatureServer, no key).
// - NASA FIRMS VIIRS active-fire detections (needs a free MAP_KEY in FIRMS_MAP_KEY).
// Answers are kept in memory for 30 minutes, so a toggle never queries a service twice in a row.
// Kept out of the disk cache on purpose: an old answer about real fires should not be replayed,
// and the FIRMS URL carries the key.

import { USER_AGENT } from './sources.ts';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Half the side of the query box around home, in meters (about 50 km each way). */
export const REFERENCE_RADIUS_M = 50000;
export const REFERENCE_TTL_MS = 30 * 60 * 1000;
/** A failed service is not asked again for this long. */
const FAILURE_TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 20000;
/** Days of FIRMS detections (the API counts back from today, UTC). */
export const FIRMS_DAYS = 2;
export const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'] as const;
const MAX_PERIMETERS = 40;
const MAX_DETECTIONS = 500;

export const WFIGS_QUERY_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';
export const FIRMS_AREA_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

export const PERIMETER_SOURCE = 'NIFC WFIGS Interagency Perimeters (Current)';
export const DETECTION_SOURCE = 'NASA FIRMS VIIRS (NOAA-20, NOAA-21), near real time';

export interface LonLat { lon: number; lat: number }

export interface Perimeter {
  name: string;
  /** Mapped acres, or null when the record has none. */
  acres: number | null;
  /** When the perimeter record was last updated (ISO), or null. */
  updatedAt: string | null;
  /** Meters from home to the nearest edge; 0 when home is inside. */
  distanceM: number;
  /** Rings of [lon, lat] pairs, simplified by the service. */
  rings: [number, number][][];
}

export interface Detection {
  lat: number;
  lon: number;
  /** Satellite overpass time (ISO, UTC). */
  acquiredAt: string;
  satellite: string;
  /** FIRMS VIIRS confidence: low, nominal or high. */
  confidence: 'low' | 'nominal' | 'high' | 'unknown';
  distanceM: number;
}

export type Part<T> =
  | { available: true; items: T[]; fetchedAt: string; source: string }
  | { available: false; reason: 'outside_us' | 'no_key' | 'bad_key' | 'failed'; source: string };

export interface ReferenceData {
  perimeters: Part<Perimeter>;
  detections: Part<Detection>;
  fetchedAt: string;
  radiusM: number;
  notes: string[];
}

export interface ReferenceOptions {
  fetcher?: Fetcher;
  /** FIRMS MAP_KEY; defaults to process.env.FIRMS_MAP_KEY. Pass '' to mean "no key". */
  firmsKey?: string;
  now?: () => number;
}

// ---------- Geometry ----------

const M_PER_DEG_LAT = 111320;

/** Box of about radiusM around home: [west, south, east, north] in degrees. */
export function envelope(home: LonLat, radiusM = REFERENCE_RADIUS_M): [number, number, number, number] {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = radiusM / (M_PER_DEG_LAT * Math.cos((home.lat * Math.PI) / 180));
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return [r(home.lon - dLon), r(home.lat - dLat), r(home.lon + dLon), r(home.lat + dLat)];
}

function toXY(home: LonLat, p: [number, number]): { x: number; y: number } {
  return { x: (p[0] - home.lon) * M_PER_DEG_LAT * Math.cos((home.lat * Math.PI) / 180), y: (p[1] - home.lat) * M_PER_DEG_LAT };
}

export function metersBetween(home: LonLat, p: LonLat): number {
  const q = toXY(home, [p.lon, p.lat]);
  return Math.hypot(q.x, q.y);
}

/**
 * Meters from home to the nearest edge of the polygon (0 when home is inside).
 * Inside uses the even-odd rule over all rings, so holes count as outside.
 */
export function distanceToPolygonM(home: LonLat, rings: [number, number][][]): number {
  let inside = false;
  let best = Infinity;
  for (const ring of rings) {
    const pts = ring.map((p) => toXY(home, p));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j];
      const b = pts[i];
      if (a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      // Distance from the origin (home) to segment a-b.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
      best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
    }
  }
  return inside ? 0 : best;
}

// ---------- NIFC / WFIGS perimeters ----------

export function perimeterQueryUrl(home: LonLat): string {
  const box = envelope(home);
  const p = new URLSearchParams({
    where: '1=1',
    geometry: box.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'poly_IncidentName,attr_IncidentName,poly_GISAcres,attr_IncidentSize,poly_DateCurrent',
    returnGeometry: 'true',
    outSR: '4326',
    // About 50 m: enough for a map of a few kilometers, much smaller to send.
    maxAllowableOffset: '0.0005',
    geometryPrecision: '5',
    resultRecordCount: String(MAX_PERIMETERS),
    f: 'json',
  });
  return `${WFIGS_QUERY_URL}?${p}`;
}

interface EsriFeature {
  attributes?: Record<string, unknown>;
  geometry?: { rings?: number[][][] };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Turns an ArcGIS query answer into perimeters, nearest first. Throws when the answer is an error. */
export function parsePerimeters(body: string, home: LonLat): Perimeter[] {
  const json = JSON.parse(body) as { features?: EsriFeature[]; error?: { message?: string } };
  if (json.error || !Array.isArray(json.features)) throw new Error(`WFIGS error: ${json.error?.message ?? 'no features'}`);
  const out: Perimeter[] = [];
  for (const f of json.features) {
    const a = f.attributes ?? {};
    const rings = (f.geometry?.rings ?? [])
      .map((r) => r.filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]] as [number, number]))
      .filter((r) => r.length >= 3);
    if (rings.length === 0) continue;
    const updated = num(a.poly_DateCurrent);
    out.push({
      name: str(a.poly_IncidentName) ?? str(a.attr_IncidentName) ?? 'Unnamed fire',
      acres: num(a.poly_GISAcres) ?? num(a.attr_IncidentSize),
      updatedAt: updated !== null ? new Date(updated).toISOString() : null,
      distanceM: Math.round(distanceToPolygonM(home, rings)),
      rings,
    });
  }
  return out.sort((x, y) => x.distanceM - y.distanceM);
}

// ---------- NASA FIRMS detections ----------

export function firmsUrl(key: string, source: string, home: LonLat): string {
  return `${FIRMS_AREA_URL}/${encodeURIComponent(key)}/${source}/${envelope(home).join(',')}/${FIRMS_DAYS}`;
}

/** Raised when FIRMS says the MAP_KEY is not valid. */
export class BadKeyError extends Error {}

function confidenceWord(c: string): Detection['confidence'] {
  const v = c.trim().toLowerCase();
  if (v === 'l' || v === 'low') return 'low';
  if (v === 'n' || v === 'nominal') return 'nominal';
  if (v === 'h' || v === 'high') return 'high';
  return 'unknown';
}

/** FIRMS area CSV -> detections. Throws BadKeyError for a key complaint, Error for anything else that is not the CSV. */
export function parseFirmsCsv(body: string, home: LonLat): Detection[] {
  const text = body.trim();
  if (text === '') return [];
  if (!text.startsWith('latitude') && /map_key/i.test(text)) throw new BadKeyError('FIRMS rejected the MAP_KEY');
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (name: string) => head.indexOf(name);
  const iLat = col('latitude');
  const iLon = col('longitude');
  const iDate = col('acq_date');
  const iTime = col('acq_time');
  if (iLat < 0 || iLon < 0 || iDate < 0 || iTime < 0) throw new Error(`FIRMS answer was not detection data: ${text.slice(0, 80)}`);
  const iSat = col('satellite');
  const iConf = col('confidence');
  const out: Detection[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    const hhmm = (c[iTime] ?? '').trim().padStart(4, '0');
    const at = Date.parse(`${(c[iDate] ?? '').trim()}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(at)) continue;
    out.push({
      lat,
      lon,
      acquiredAt: new Date(at).toISOString(),
      satellite: iSat >= 0 ? (c[iSat] ?? '').trim() : '',
      confidence: iConf >= 0 ? confidenceWord(c[iConf] ?? '') : 'unknown',
      distanceM: Math.round(metersBetween(home, { lat, lon })),
    });
  }
  return out;
}

// ---------- Fetch with a 30-minute memory cache ----------

interface Entry<T> { at: number; ttl: number; value: Promise<T> }
const memo = new Map<string, Entry<unknown>>();

/** Shares one call per key: a fresh answer for 30 minutes, a failure for 2. */
function remember<T>(key: string, now: number, run: () => Promise<T>): Promise<T> {
  const hit = memo.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const entry: Entry<T> = { at: now, ttl: REFERENCE_TTL_MS, value: run() };
  entry.value.catch(() => {
    entry.ttl = FAILURE_TTL_MS;
  });
  memo.set(key, entry as Entry<unknown>);
  return entry.value;
}

/** For tests: forget every remembered answer. */
export function clearReferenceCache(): void {
  memo.clear();
}

async function getText(fetcher: Fetcher, url: string): Promise<{ status: number; body: string }> {
  const res = await fetcher(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: await res.text() };
}

/** Same box key for homes a few hundred meters apart, so nearby lookups share an answer. */
const boxKey = (home: LonLat) => `${home.lat.toFixed(2)},${home.lon.toFixed(2)}`;

async function loadPerimeters(home: LonLat, fetcher: Fetcher, now: number): Promise<Part<Perimeter>> {
  try {
    const { body, fetchedAt } = await remember(`wfigs:${boxKey(home)}`, now, async () => {
      const { status, body } = await getText(fetcher, perimeterQueryUrl(home));
      if (status < 200 || status >= 300) throw new Error(`WFIGS HTTP ${status}`);
      parsePerimeters(body, home); // an error answer is not remembered as good
      return { body, fetchedAt: new Date(now).toISOString() };
    });
    return { available: true, items: parsePerimeters(body, home), fetchedAt, source: PERIMETER_SOURCE };
  } catch (err) {
    console.warn(`Reference perimeters failed: ${String(err)}`);
    return { available: false, reason: 'failed', source: PERIMETER_SOURCE };
  }
}

async function loadDetections(home: LonLat, key: string, fetcher: Fetcher, now: number): Promise<Part<Detection>> {
  if (!key) return { available: false, reason: 'no_key', source: DETECTION_SOURCE };
  try {
    const { bodies, fetchedAt } = await remember(`firms:${boxKey(home)}`, now, async () => {
      const bodies: string[] = [];
      // One source after the other, never in parallel.
      for (const source of FIRMS_SOURCES) {
        const { status, body } = await getText(fetcher, firmsUrl(key, source, home));
        if (/invalid map_key/i.test(body)) throw new BadKeyError('FIRMS rejected the MAP_KEY');
        if (status < 200 || status >= 300) throw new Error(`FIRMS HTTP ${status}`);
        parseFirmsCsv(body, home); // an error answer is not remembered as good
        bodies.push(body);
      }
      return { bodies, fetchedAt: new Date(now).toISOString() };
    });
    const items = bodies.flatMap((b) => parseFirmsCsv(b, home)).sort((a, b) => a.distanceM - b.distanceM);
    return { available: true, items: items.slice(0, MAX_DETECTIONS), fetchedAt, source: DETECTION_SOURCE };
  } catch (err) {
    // Never log the error text in full: it could echo the request URL, which carries the key.
    console.warn(`Reference detections failed: ${err instanceof BadKeyError ? 'bad key' : (err as Error)?.name ?? 'error'}`);
    return { available: false, reason: err instanceof BadKeyError ? 'bad_key' : 'failed', source: DETECTION_SOURCE };
  }
}

/** Perimeters (US only) and satellite detections within about 50 km of home. Never throws. */
export async function fetchReference(home: LonLat, country: string, opts: ReferenceOptions = {}): Promise<ReferenceData> {
  const fetcher = opts.fetcher ?? fetch;
  const now = (opts.now ?? Date.now)();
  const key = (opts.firmsKey ?? process.env.FIRMS_MAP_KEY ?? '').trim();
  const isUS = country.toLowerCase() === 'us';
  const notes: string[] = [];

  const perimeters: Part<Perimeter> = isUS
    ? await loadPerimeters(home, fetcher, now)
    : { available: false, reason: 'outside_us', source: PERIMETER_SOURCE };
  const detections = await loadDetections(home, key, fetcher, now);

  if (!isUS) notes.push('NIFC fire perimeters cover the US only, so they were not requested for this address.');
  if (detections.available) notes.push(`Satellite detections are heat seen from orbit in the last ${FIRMS_DAYS * 24} hours. A detection is not a confirmed fire.`);
  notes.push('Answers are reused for 30 minutes.');
  return { perimeters, detections, fetchedAt: new Date(now).toISOString(), radiusM: REFERENCE_RADIUS_M, notes };
}
