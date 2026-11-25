// Browser-side calls to the local API server (proxied at /api by Vite).
import type { AreaData } from '../engine/types';

export interface GeocodeResult { label: string; lat: number; lon: number; country: string }

export interface PlanRequest {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { label: string; minutes: number }[];
  main: { roadNames: string[]; driveMin: number; destination: string } | null;
  backup: { roadNames: string[]; driveMin: number; destination: string } | null;
  /** onSharedStretch: the closing road is on the stretch both routes share, so the backup does not avoid it. */
  drill: { neededMin: number; closeMin: number; roadName: string; onSharedStretch: boolean } | null;
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

export function requestPlan(body: PlanRequest): Promise<PlanResponse> {
  return getJson<PlanResponse>('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
