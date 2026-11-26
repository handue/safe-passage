// Browser-side calls to the local API server (proxied at /api by Vite).
import type { AreaData } from '../engine/types';

export interface GeocodeResult { label: string; lat: number; lon: number; country: string }

export interface PlanRequest {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { label: string; minutes: number }[];
  /** exitPoint: the destination is where a road leaves the area, not a place to meet. */
  main: { roadNames: string[]; driveMin: number; destination: string; exitPoint: boolean } | null;
  backup: { roadNames: string[]; driveMin: number; destination: string; exitPoint: boolean } | null;
  /**
   * onSharedStretch: the backup drives the same closing stretch, so it does not avoid it.
   * backupCut: in this drill the fire also closed the backup before the car could pass.
   */
  drill: { neededMin: number; closeMin: number; roadName: string; onSharedStretch: boolean; backupCut: boolean } | null;
  /** Compass word for the way the backup goes on the road that may close, when both routes use that road; else ''. */
  backupTurn: string;
  changes: string[];
}

export interface PlanResponse {
  source: 'ai' | 'fallback';
  model?: string;
  whenToLeave: string;
  meetingSpot: { primary: string; ifClosed: string; reason: string };
  goBag: string[];
  thisWeek: string[];
  note?: string;
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError('network', 'Could not reach the Safe Passage server.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `http_${res.status}`);
  return body as T;
}

export const DEMO = { label: 'Boulder Creek Library, 13390 West Park Ave, Boulder Creek, CA', lat: 37.1275032, lon: -122.1238109, country: 'us' };

export async function geocode(q: string): Promise<GeocodeResult[]> {
  const { results } = await getJson<{ results: GeocodeResult[] }>(`/api/geocode?q=${encodeURIComponent(q)}`);
  return results;
}

export function fetchArea(place: { lat: number; lon: number; label: string; country: string }, demo = false): Promise<AreaData> {
  const p = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon), label: place.label, country: place.country });
  if (demo) p.set('demo', '1');
  return getJson<AreaData>(`/api/area?${p}`);
}

/** Pass a signal to cancel a request whose inputs are out of date. */
export function requestPlan(body: PlanRequest, signal?: AbortSignal): Promise<PlanResponse> {
  return getJson<PlanResponse>('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
}

// ---------- Other situations, same fire (the AI only picks which ones) ----------

/** What the situation picker gets: counts, task names and minutes, road names and the drill's times. No address or coordinates. */
export interface SituationsRequest {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { id: string; label: string; minutes: number }[];
  start: 'day' | 'night';
  /** closeMin and marginMin are null when the fire never closed the main route. */
  drill: {
    roadName: string;
    closeMin: number | null;
    passMin: number;
    marginMin: number | null;
    outcome: 'never_closed' | 'in_time' | 'short';
    backupRoadNames: string[];
    mainRoadNames: string[];
  };
  available: { kind: string; minParam: number; maxParam: number; defaultParam: number; title: string }[];
}

export interface SituationsResponse {
  situations: { kind: string; param: number; reason: string }[];
  source: 'ai' | 'fallback';
  note?: string;
}

/** Never throws: a network or server error reads as a fallback answer, so the fixed rules stay in use. */
export async function requestSituations(body: SituationsRequest, signal?: AbortSignal): Promise<SituationsResponse> {
  try {
    const res = await getJson<SituationsResponse>('/api/situations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return { situations: Array.isArray(res?.situations) ? res.situations : [], source: res?.source === 'ai' ? 'ai' : 'fallback', note: res?.note };
  } catch {
    return { situations: [], source: 'fallback', note: 'Could not reach the situation picker.' };
  }
}

// ---------- Reference layer (real fires near home; never part of the drill) ----------

export interface RefPerimeter {
  name: string;
  acres: number | null;
  updatedAt: string | null;
  /** Meters from home to the nearest edge; 0 when home is inside. */
  distanceM: number;
  /** Rings of [lon, lat] pairs. */
  rings: [number, number][][];
}

export interface RefDetection {
  lat: number;
  lon: number;
  acquiredAt: string;
  satellite: string;
  confidence: 'low' | 'nominal' | 'high' | 'unknown';
  distanceM: number;
}

export type RefPart<T> =
  | { available: true; items: T[]; fetchedAt: string; source: string }
  | { available: false; reason: 'outside_us' | 'no_key' | 'bad_key' | 'failed'; source: string };

export interface ReferenceData {
  perimeters: RefPart<RefPerimeter>;
  detections: RefPart<RefDetection>;
  fetchedAt: string;
  radiusM: number;
  notes: string[];
}

const referenceByPlace = new Map<string, Promise<ReferenceData>>();
let lastReference: { key: string; data: ReferenceData } | null = null;

const placeKey = (p: { lat: number; lon: number; country: string }) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)},${p.country}`;

/**
 * Real fire perimeters (US) and satellite detections near home, for the reference layer.
 * One request per address per page load; the server also keeps answers for 30 minutes.
 */
export function fetchReference(place: { lat: number; lon: number; country: string }): Promise<ReferenceData> {
  const key = placeKey(place);
  const known = referenceByPlace.get(key);
  if (known) return known;
  const p = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon), country: place.country });
  const req = getJson<ReferenceData>(`/api/reference?${p}`).then((data) => {
    lastReference = { key, data };
    return data;
  });
  // A failed request may be tried again with the next toggle.
  req.catch(() => referenceByPlace.delete(key));
  referenceByPlace.set(key, req);
  return req;
}

/** The reference answer last shown for this address, or null when the layer was not used. */
export function usedReference(place: { lat: number; lon: number; country: string } | null): ReferenceData | null {
  return place && lastReference?.key === placeKey(place) ? lastReference.data : null;
}
