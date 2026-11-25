// Loading orchestration: address search, then one area request, then the engine prepares the area.
// The store has no "cancel" action, so a cancelled load ends as load/error with code "cancelled".
import type { Dispatch } from 'react';
import type { Action } from './state';
import { ApiError, fetchArea, geocode, type GeocodeResult } from './api';

export const LOAD_STEPS = ['Found your address', 'Loaded nearby roads', 'Reading terrain and wind', 'Finding ways out'];

export type Place = GeocodeResult;

interface Job {
  id: number;
  place: Place;
  demo: boolean;
  /** When the address was looked up (browser time); null for the demo, which needs no lookup. */
  geocodedAt: string | null;
  /** True until the loading screen moves on by itself once. */
  autoAdvance: boolean;
}

let nextId = 1;
let current: Job | null = null;
let last: Job | null = null;
let loaded: Job | null = null;
let lastSearchAt: string | null = null;

/** Short pause so each step is seen; labels only change after the work they name is done. */
const pause = () => new Promise<void>((r) => setTimeout(r, 160));

/** Looks up an address. Remembers when, for "How this plan was made". */
export async function searchAddress(q: string): Promise<Place[]> {
  const results = await geocode(q);
  lastSearchAt = new Date().toISOString();
  return results;
}

export async function startLoad(dispatch: Dispatch<Action>, place: Place, demo: boolean): Promise<void> {
  const job: Job = { id: nextId++, place, demo, geocodedAt: demo ? null : lastSearchAt, autoAdvance: true };
  current = job;
  last = job;
  const live = () => current?.id === job.id;

  dispatch({ type: 'load/start', steps: LOAD_STEPS });
  await pause();
  if (!live()) return;
  dispatch({ type: 'load/step', index: 1 });

  let area;
  try {
    area = await fetchArea(place, demo);
  } catch (e) {
    if (!live()) return;
    current = null;
    const code = e instanceof ApiError ? e.code : 'unknown';
    dispatch({ type: 'load/error', code, message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!live()) return;
  dispatch({ type: 'load/step', index: 2 });
  await pause();
  if (!live()) return;
  dispatch({ type: 'load/step', index: 3 });
  await pause();
  if (!live()) return;
  current = null;
  loaded = job;
  // The reducer runs prepareArea (road graph, fire grid, ways out) and the ignition suggestions.
  dispatch({ type: 'load/done', area, isDemo: demo });
}

export function cancelLoad(dispatch: Dispatch<Action>): void {
  if (!current) return;
  current = null;
  dispatch({ type: 'load/error', code: 'cancelled', message: 'Cancelled' });
}

/** Runs the last load again (after an error or from the fallback box). */
export function retryLoad(dispatch: Dispatch<Action>): boolean {
  if (!last) return false;
  void startLoad(dispatch, last.place, last.demo);
  return true;
}

export function isLoading(): boolean {
  return current !== null;
}

/** Was the last load the demo? Null when nothing has been started. */
export function lastWasDemo(): boolean | null {
  return last ? last.demo : null;
}

/** True once per finished load: lets the loading screen move on by itself only right after a load. */
export function consumeAutoAdvance(): boolean {
  if (!loaded || !loaded.autoAdvance) return false;
  loaded.autoAdvance = false;
  return true;
}

/** Facts about the area now loaded, for "How this plan was made". */
export function loadedInfo(): { demo: boolean; geocodedAt: string | null } | null {
  return loaded ? { demo: loaded.demo, geocodedAt: loaded.geocodedAt } : null;
}
