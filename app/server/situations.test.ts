import { describe, expect, it } from 'vitest';
import { cleanPicks, MAX_REASON_CHARS, pickSituations, sanitizeSituationsInput } from './situations.ts';

const available = [
  { kind: 'late_order', minParam: 5, maxParam: 30, defaultParam: 10, title: 'Order comes late' },
  { kind: 'road_blocked', minParam: 0, maxParam: 0, defaultParam: 0, title: 'Main route blocked' },
  { kind: 'night', minParam: 1, maxParam: 15, defaultParam: 3, title: 'Night start' },
  { kind: 'adult_away', minParam: 1.2, maxParam: 2, defaultParam: 1.5, title: 'One adult away' },
  { kind: 'pet_hides', minParam: 5, maxParam: 30, defaultParam: 10, title: 'A pet hides' },
];

const body = {
  household: { adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 0, cars: 1, secret: 'x' },
  tasks: [{ id: 'pets', label: 'Get the pets', minutes: 6, extra: 1 }],
  start: 'day',
  drill: { roadName: 'Creek Rd', closeMin: 30, passMin: 25, marginMin: 5, outcome: 'in_time', backupRoadNames: ['Ridge Rd'], mainRoadNames: ['Willow Dr', 'Creek Rd'] },
  available,
  address: '13390 West Park Ave', lat: 37.3, lon: -122.0, home: { lat: 37.3, lon: -122.0 },
};

const reply = (situations: unknown) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ situations }) } }] }), { status: 200 });

describe('situations', () => {
  it('drops fields that must not reach the model', () => {
    const s = sanitizeSituationsInput(body) as unknown as Record<string, any>;
    expect(s.address).toBeUndefined();
    expect(s.lat).toBeUndefined();
    expect(s.home).toBeUndefined();
    expect(s.household.secret).toBeUndefined();
    expect(s.tasks[0].extra).toBeUndefined();
    const text = JSON.stringify(s);
    expect(text).not.toContain('13390');
    expect(text).not.toContain('37.3');
    expect(Object.keys(s).sort()).toEqual(['available', 'drill', 'household', 'start', 'tasks']);
  });

  it('drops reasons written in app jargon, keeps the pick', () => {
    const picks = cleanPicks([
      { kind: 'road_blocked', param: 0, reason: 'Backup list shares Central Avenue and other main roads.' },
      { kind: 'night', param: 3, reason: 'Your margin is small.' },
      { kind: 'pet_hides', param: 10, reason: 'Your two cats may hide when people rush.' },
    ], sanitizeSituationsInput(body).available);
    expect(picks.map((p) => p.reason)).toEqual(['', '', 'Your two cats may hide when people rush.']);
  });

  it('keeps the engine outcome words and blanks unknown ones', () => {
    for (const o of ['in_time', 'short', 'never_closed']) expect(sanitizeSituationsInput({ ...body, drill: { ...body.drill, outcome: o } }).drill.outcome).toBe(o);
    expect(sanitizeSituationsInput({ ...body, drill: { ...body.drill, outcome: 'passed' } }).drill.outcome).toBe('');
  });

  it('drops unknown and duplicate kinds from available; keeps Infinity margins as null', () => {
    const s = sanitizeSituationsInput({ ...body, available: [...available, { kind: 'meteor', minParam: 1, maxParam: 2, defaultParam: 1 }, available[0]], drill: { ...body.drill, marginMin: Infinity, closeMin: null } });
    expect(s.available.map((a) => a.kind)).toEqual(['late_order', 'road_blocked', 'night', 'adult_away', 'pet_hides']);
    expect(s.drill.marginMin).toBeNull();
    expect(s.drill.closeMin).toBeNull();
  });

  it('clamps params, drops unknown and duplicate kinds, strips reasons with digits', () => {
    const picks = cleanPicks([
      { kind: 'late_order', param: 99, reason: 'The order to leave could come late for this home.' },
      { kind: 'meteor', param: 1, reason: 'Not a kind.' },
      { kind: 'late_order', param: 10, reason: 'Duplicate.' },
      { kind: 'adult_away', param: 0.5, reason: 'One person needs help moving.' },
      { kind: 'pet_hides', param: 12, reason: 'Your dog may hide for 10 minutes.' },
      { kind: 'night', param: 'abc', reason: 'A night start adds wake-up time. And more.' },
    ], sanitizeSituationsInput(body).available);
    expect(picks.map((p) => p.kind)).toEqual(['late_order', 'adult_away', 'pet_hides', 'night']);
    expect(picks[0].param).toBe(30);
    expect(picks[1].param).toBe(1.2);
    expect(picks[2]).toEqual({ kind: 'pet_hides', param: 12, reason: '' });
    expect(picks[3].param).toBe(3);
    expect(picks[3].reason).toBe('A night start adds wake-up time.');
  });

  it('keeps reasons to one short sentence', () => {
    const long = 'word '.repeat(60).trim();
    const [p] = cleanPicks([{ kind: 'night', param: 3, reason: long }], sanitizeSituationsInput(body).available);
    expect(p.reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(p.reason.endsWith('.')).toBe(true);
  });

  it('falls back without calling the model when there is no key', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return reply([]); }) as unknown as typeof fetch;
    const prev = process.env.MODEL_API_KEY;
    delete process.env.MODEL_API_KEY;
    try {
      const out = await pickSituations(sanitizeSituationsInput(body), { fetchImpl });
      expect(out).toEqual({ situations: [], source: 'fallback', note: 'No MODEL_API_KEY set' });
      expect(called).toBe(false);
    } finally {
      if (prev !== undefined) process.env.MODEL_API_KEY = prev;
    }
  });

  it('falls back when fewer than three valid picks remain', async () => {
    const fetchImpl = (async () => reply([
      { kind: 'late_order', param: 10, reason: 'A.' },
      { kind: 'no_car', param: 10, reason: 'Not available for this household.' },
      { kind: 'late_order', param: 12, reason: 'Duplicate.' },
      { kind: 'meteor', param: 1, reason: 'Unknown.' },
    ])) as unknown as typeof fetch;
    const out = await pickSituations(sanitizeSituationsInput(body), { key: 'k', fetchImpl });
    expect(out.source).toBe('fallback');
    expect(out.situations).toEqual([]);
    expect(out.note).toBeTruthy();
  });

  it('accepts a valid reply and retries without reasoning_effort after a 400', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (_u: string, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return new Response('bad', { status: 400 });
      return reply([
        { kind: 'adult_away', param: 1.5, reason: 'One person needs help moving, so a lone adult is slower.' },
        { kind: 'pet_hides', param: 10, reason: 'A dog can hide when there is smoke.' },
        { kind: 'late_order', param: 10, reason: 'The order to leave could come late.' },
      ]);
    }) as unknown as typeof fetch;
    const out = await pickSituations(sanitizeSituationsInput(body), { key: 'k', fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0].reasoning_effort).toBe('low');
    expect(calls[1].reasoning_effort).toBeUndefined();
    expect(calls[0].model).toBe('muse-spark-1.3');
    expect(calls[0].response_format.json_schema.strict).toBe(true);
    expect(calls[0].messages[1].content).not.toContain('13390');
    expect(out.source).toBe('ai');
    expect(out.situations.map((s) => s.kind)).toEqual(['adult_away', 'pet_hides', 'late_order']);
  });

  it('never throws: API errors and bad JSON fall back', async () => {
    const e500 = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    expect((await pickSituations(sanitizeSituationsInput(body), { key: 'k', fetchImpl: e500 })).note).toBe('Model API returned 500');
    const bad = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] }), { status: 200 })) as unknown as typeof fetch;
    expect((await pickSituations(sanitizeSituationsInput(body), { key: 'k', fetchImpl: bad })).source).toBe('fallback');
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect((await pickSituations(sanitizeSituationsInput(body), { key: 'k', fetchImpl: boom })).note).toBe('Model API call failed');
  });
});
