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
