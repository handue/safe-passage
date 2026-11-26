import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestInterpretSituation, type InterpretRequest } from './api';

const body: InterpretRequest = {
  text: 'We also have a horse trailer to hitch',
  household: { adults: 2, children: 0, needHelpMoving: 0, dogs: 0, catsAndSmallPets: 0, cars: 1 },
  tasks: [],
  available: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('requestInterpretSituation', () => {
  it('posts JSON to the reader and keeps only the known fields', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', title: 'Trailer', parts: { situations: 'bad', addTasks: [{ label: 'Hitch', minutes: 15 }] }, cannotModel: '', extra: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const res = await requestInterpretSituation(body);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/interpret-situation');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(res).toEqual({ status: 'ok', title: 'Trailer', parts: { situations: [], addTasks: [{ label: 'Hitch', minutes: 15 }], taskMinutes: {} }, cannotModel: '', note: undefined });
  });

  it('reads a network error or an odd status as a fallback, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect((await requestInterpretSituation(body)).status).toBe('fallback');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'weird' }), { status: 200 })));
    expect((await requestInterpretSituation(body)).status).toBe('fallback');
  });
});
