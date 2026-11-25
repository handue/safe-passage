// Loading orchestration: address search, then one area request, then the engine prepares the area.
// While the area request runs, the server's /api/area-status says which parts are done; the steps follow it.
// The store has no "cancel" action, so a cancelled load ends as load/error with code "cancelled".
import type { Dispatch } from 'react';
import type { Action, LoadStep, MatchPrecision } from './state';
import { ApiError, geocode, type GeocodeResult } from './api';
import type { AreaData } from '../engine/types';

/** Longest address the server accepts (server/index.ts MAX_QUERY_CHARS). */
export const MAX_QUERY_CHARS = 200;

/** The client gives up on the area request after this long and offers Retry and the demo. */
/** Longer than the server's Overpass budget (110 s), so the server's own answer arrives first. */
export const CLIENT_CAP_MS = 120000;

/** A wait in words for copy: 120000 -> "2 minutes", 90000 -> "90 seconds". */
export function capWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`;
  return `${s} seconds`;
}

/** How often the loading screen asks the server which parts are done. */
const POLL_MS = 1000;

/**
 * Loading steps in the order they usually finish: terrain and wind answer in about a second,
 * roads and places take longest. Each step has a label while working and one when done.
 */
export const LOAD_STEPS = [
  { working: 'Finding your address', done: 'Found your address' },
  { working: 'Reading terrain and wind', done: 'Read terrain and wind' },
  { working: 'Loading nearby roads and places', done: 'Loaded nearby roads and places' },
  { working: 'Finding ways out', done: 'Found ways out' },
];

/** Present tense while working or waiting, past tense once done. */
export function stepText(step: LoadStep): string {
  const s = LOAD_STEPS.find((x) => x.done === step.label);
  if (!s) return step.label;
  return step.state === 'done' ? s.done : s.working;
}

export type Place = GeocodeResult & { precision?: MatchPrecision };

/** Results with the same label (ignoring case and spacing) are one choice for the user. */
export function uniqueByLabel(results: Place[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const r of results) {
    const k = r.label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Last comma part before the country, e.g. "California 95969" -> "california". */
function regionOf(label: string): string {
  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  const region = parts.length >= 2 ? parts[parts.length - 2] : parts[0] ?? '';
  return region.replace(/[\d-]+/g, '').trim().toLowerCase();
}

/**
 * True when the matches are too spread out to tell apart: the query names no town (no comma),
 * or the matches lie in more than one country or state.
 */
export function isGenericMatch(query: string, results: Place[]): boolean {
  if (results.length < 2) return false;
  if (!query.includes(',')) return true;
  if (new Set(results.map((r) => r.country)).size > 1) return true;
  return new Set(results.map((r) => regionOf(r.label))).size > 1;
}

/** Progress of one area load, as /api/area-status returns it. */
export interface AreaStatus {
  roads: string;
  places: string;
  terrain: string;
  wind: string;
  mapAttempt: number;
  mapServer: 'main' | 'backup' | 'cache' | null;
  mapBusy: boolean;
  done: boolean;
  elapsedMs: number;
  error?: string;
}

const settled = (s: string) => s === 'done' || s === 'failed';

/** Which step is working, from the server's status (1: terrain and wind, 2: roads and places). */
export function stepIndexFromStatus(st: AreaStatus): number {
  return settled(st.terrain) && settled(st.wind) ? 2 : 1;
}

/** What the loading screen shows besides the steps. Read with useLoadProgress. */
export interface LoadProgress {
  /** Browser time the load started (ms), for the elapsed seconds. */
  startedAt: number;
  /** Last status from the server, or null before the first answer. */
  status: AreaStatus | null;
  /** Why the map data failed: 'busy', 'timeout' or 'failed', when the server said. */
  reason: string | null;
}

/** One calm line about the map server while roads load, or null. */
export function mapNote(p: LoadProgress, elapsedS: number): string | null {
  const st = p.status;
  if (st?.mapServer === 'backup') return 'The main map data server did not answer, so we are trying a backup server.';
  if (st?.mapBusy) return 'The map data server is busy. We are waiting a few seconds and trying again.';
  if (elapsedS >= 20) return 'Still loading road data. The map data server may be busy.';
  return null;
}

interface Job {
  id: number;
  place: Place;
  demo: boolean;
  /** When the address was looked up (browser time); null for the demo, which needs no lookup. */
  geocodedAt: string | null;
  /** True until the loading screen moves on by itself once. */
  autoAdvance: boolean;
  abort: AbortController;
}

let nextId = 1;
let current: Job | null = null;
let last: Job | null = null;
let loaded: Job | null = null;
let lastSearchAt: string | null = null;

let progress: LoadProgress = { startedAt: 0, status: null, reason: null };
const listeners = new Set<() => void>();
function setProgress(p: Partial<LoadProgress>): void {
  progress = { ...progress, ...p };
  for (const l of listeners) l();
}
export function subscribeProgress(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export function getProgress(): LoadProgress {
  return progress;
}

/** Short pause so each step is seen; labels only change after the work they name is done. */
const pause = () => new Promise<void>((r) => setTimeout(r, 160));

/** Looks up an address. Remembers when, for "How this plan was made". Same labels are merged. */
export async function searchAddress(q: string): Promise<Place[]> {
  if (q.length > MAX_QUERY_CHARS) throw new ApiError('query_too_long');
  const results = await geocode(q);
  lastSearchAt = new Date().toISOString();
  return uniqueByLabel(results as Place[]);
}

class AreaError extends ApiError {
  readonly reason: string | null;
  constructor(code: string, reason: string | null) {
    super(code);
    this.reason = reason;
  }
}

/** GET /api/area with a status key and an abort signal. */
async function requestArea(place: Place, demo: boolean, key: string, signal: AbortSignal): Promise<AreaData> {
  const p = new URLSearchParams({ lat: String(place.lat), lon: String(place.lon), label: place.label, country: place.country, key });
  if (demo) p.set('demo', '1');
  let res: Response;
  try {
    res = await fetch(`/api/area?${p}`, { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new AreaError('network', null);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as { error?: string; reason?: string };
    throw new AreaError(b.error ?? `http_${res.status}`, b.reason ?? null);
  }
  return body as AreaData;
}

async function readStatus(key: string): Promise<AreaStatus | null> {
  try {
    const res = await fetch(`/api/area-status?key=${key}`);
    return res.ok ? ((await res.json()) as AreaStatus) : null;
  } catch {
    return null;
  }
}

export async function startLoad(dispatch: Dispatch<Action>, place: Place, demo: boolean): Promise<void> {
  if (current) current.abort.abort();
  const job: Job = { id: nextId++, place, demo, geocodedAt: demo ? null : lastSearchAt, autoAdvance: true, abort: new AbortController() };
  current = job;
  last = job;
  const live = () => current?.id === job.id;

  setProgress({ startedAt: Date.now(), status: null, reason: null });
  dispatch({ type: 'load/start', steps: LOAD_STEPS.map((s) => s.done) });
  // The search already matched this address, so "Found your address" is done before the "Using:" line shows.
  dispatch({ type: 'load/step', index: 1 });
  dispatch({ type: 'entry/set', patch: { matched: { label: place.label, precision: place.precision } } });

  const key = `l${job.id}x${Math.random().toString(36).slice(2, 10)}`;
  let step = 1;
  const poll = setInterval(() => {
    void readStatus(key).then((st) => {
      if (!st || !live()) return;
      setProgress({ status: st });
      const i = stepIndexFromStatus(st);
      if (i > step) {
        step = i;
        dispatch({ type: 'load/step', index: i });
      }
    });
  }, POLL_MS);
  let timedOut = false;
  const cap = setTimeout(() => {
    timedOut = true;
    job.abort.abort();
  }, CLIENT_CAP_MS);

  let area;
  try {
    area = await requestArea(place, demo, key, job.abort.signal);
  } catch (e) {
    if (!live()) return;
    current = null;
    if (timedOut) {
      dispatch({ type: 'load/error', code: 'too_slow', message: 'No answer in time' });
      return;
    }
    const code = e instanceof ApiError ? e.code : 'unknown';
    setProgress({ reason: e instanceof AreaError ? e.reason : null });
    dispatch({ type: 'load/error', code, message: e instanceof Error ? e.message : String(e) });
    return;
  } finally {
    clearInterval(poll);
    clearTimeout(cap);
  }
  if (!live()) return;
  if (step < 2) {
    dispatch({ type: 'load/step', index: 2 });
    await pause();
    if (!live()) return;
  }
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
  current.abort.abort();
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
