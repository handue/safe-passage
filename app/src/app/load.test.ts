import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_CAP_MS,
  capWords,
  LOAD_STEPS,
  MAX_QUERY_CHARS,
  cancelLoad,
  getProgress,
  isGenericMatch,
  mapNote,
  searchAddress,
  startLoad,
  stepIndexFromStatus,
  stepText,
  uniqueByLabel,
  type AreaStatus,
  type Place,
} from './load';
import type { Action } from './state';

const place = (label: string, country = 'us'): Place => ({ label, lat: 1, lon: 2, country });

const status = (p: Partial<AreaStatus>): AreaStatus => ({
  roads: 'working',
  places: 'working',
  terrain: 'working',
  wind: 'working',
  mapAttempt: 1,
  mapServer: 'main',
  mapBusy: false,
  done: false,
  elapsedMs: 0,
  ...p,
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('step labels', () => {
  it('uses the present tense while working or waiting and the past tense when done', () => {
    const roads = LOAD_STEPS[2];
    expect(stepText({ label: roads.done, state: 'working' })).toBe('Loading nearby roads and places');
    expect(stepText({ label: roads.done, state: 'waiting' })).toBe('Loading nearby roads and places');
    expect(stepText({ label: roads.done, state: 'done' })).toBe('Loaded nearby roads and places');
  });

  it('moves to roads only once terrain and wind have settled', () => {
    expect(stepIndexFromStatus(status({}))).toBe(1);
    expect(stepIndexFromStatus(status({ terrain: 'done' }))).toBe(1);
    expect(stepIndexFromStatus(status({ terrain: 'done', wind: 'failed' }))).toBe(2);
  });
});

describe('pick list', () => {
  it('merges matches with the same label', () => {
    const r = uniqueByLabel([place('Main Street, Toronto'), place('main street,  toronto'), place('Main St, Riverside, CA')]);
    expect(r.map((x) => x.label)).toEqual(['Main Street, Toronto', 'Main St, Riverside, CA']);
  });

  it('calls matches generic when the query names no town or they are in different places', () => {
    const two = [place('Main Street, Toronto, Ontario, Canada', 'ca'), place('Main Street, Riverside, California, United States')];
    expect(isGenericMatch('Main Street', two)).toBe(true);
    expect(isGenericMatch('Main Street, somewhere', two)).toBe(true);
    const sameState = [place('1 Oak St, Paradise, California 95969, United States'), place('1 Oak St, Magalia, California 95954, United States')];
    expect(isGenericMatch('1 Oak St, CA', sameState)).toBe(false);
    expect(isGenericMatch('Main Street', [two[0]])).toBe(false);
  });

  it('refuses a query over the limit without calling the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(searchAddress('x'.repeat(MAX_QUERY_CHARS + 1))).rejects.toMatchObject({ code: 'query_too_long' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the server code for a rejected query through, and merges duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'query_rejected' }), { status: 400 })));
    await expect(searchAddress('abc')).rejects.toMatchObject({ code: 'query_rejected' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ results: [place('A, B'), place('A, B'), place('C, D')] }), { status: 200 })),
    );
    expect((await searchAddress('abc')).length).toBe(2);
  });
});

describe('map server note', () => {
  const base = { startedAt: 0, reason: null };
  it('says nothing early, then explains a slow, busy or backup server', () => {
    expect(mapNote({ ...base, status: status({}) }, 5)).toBeNull();
    expect(mapNote({ ...base, status: null }, 25)).toMatch(/Still loading road data/);
    expect(mapNote({ ...base, status: status({ mapBusy: true }) }, 5)).toMatch(/busy/);
    expect(mapNote({ ...base, status: status({ mapServer: 'backup', mapBusy: true }) }, 5)).toMatch(/backup server/);
  });
});

describe('startLoad', () => {
  it('gives up after the client cap with a too_slow error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/area-status')) return Promise.resolve(new Response('{}', { status: 404 }));
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }),
    );
    const actions: Action[] = [];
    const done = startLoad((a) => actions.push(a), place('1 Oak St, Paradise, CA'), false);
    await vi.advanceTimersByTimeAsync(CLIENT_CAP_MS + 500);
    await done;
    const last = actions[actions.length - 1];
    expect(last).toMatchObject({ type: 'load/error', code: 'too_slow' });
    expect(actions).toContainEqual({ type: 'entry/set', patch: { matched: { label: '1 Oak St, Paradise, CA', precision: undefined } } });
  });

  it('keeps the server reason for roads_unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/area-status')) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({ error: 'roads_unavailable', reason: 'busy' }), { status: 503 });
      }),
    );
    const actions: Action[] = [];
    await startLoad((a) => actions.push(a), place('Big Sur'), false);
    expect(actions[actions.length - 1]).toMatchObject({ type: 'load/error', code: 'roads_unavailable' });
    expect(getProgress().reason).toBe('busy');
  });

  it('cancel aborts the request', async () => {
    let aborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/area-status')) return Promise.resolve(new Response('{}', { status: 404 }));
        return new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }),
        );
      }),
    );
    const actions: Action[] = [];
    const dispatch = (a: Action) => actions.push(a);
    const done = startLoad(dispatch, place('X'), false);
    await new Promise((r) => setTimeout(r, 200));
    cancelLoad(dispatch);
    await done;
    expect(aborted).toBe(true);
    expect(actions.filter((a) => a.type === 'load/error')).toEqual([{ type: 'load/error', code: 'cancelled', message: 'Cancelled' }]);
  });
});

describe('capWords', () => {
  it('words the client cap for copy', () => {
    expect(capWords(CLIENT_CAP_MS)).toBe('2 minutes');
    expect(capWords(60000)).toBe('1 minute');
    expect(capWords(75000)).toBe('75 seconds');
  });
});
