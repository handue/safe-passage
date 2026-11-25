import { describe, expect, it } from 'vitest';
import { fallbackPlan, sanitizePlanInput, writePlan } from './plan.ts';

const body = {
  household: { adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 1, cars: 1 },
  tasks: [{ label: 'Gather everyone', minutes: 3 }],
  main: { roadNames: ['Willow Dr', 'Creek Rd', 'Highway 9'], driveMin: 14, destination: 'D1 School' },
  backup: { roadNames: ['Willow Dr', 'Ridge Rd'], driveMin: 20, destination: 'D2 Hall' },
  drill: { neededMin: 25, closeMin: 30, roadName: 'Creek Rd' },
  changes: ['Keep pet carriers by the front door'],
  address: '13390 West Park Ave', phone: '555-0100',
};

describe('plan', () => {
  it('drops fields that must not reach the model', () => {
    const s = sanitizePlanInput(body) as unknown as Record<string, unknown>;
    expect(s.address).toBeUndefined();
    expect(s.phone).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('13390');
  });

  it('builds a fallback fitted to the household', () => {
    const p = fallbackPlan(sanitizePlanInput(body));
    expect(p.source).toBe('fallback');
    expect(p.whenToLeave).toContain('Willow Dr to Creek Rd to Highway 9');
    expect(p.whenToLeave).toContain('If Creek Rd is closed');
    expect(p.goBag).toContain('Mobility aids');
    expect(p.goBag).toContain('Pet carriers, leash, food');
    expect(p.meetingSpot.ifClosed).toBe('D2 Hall, front entrance');
    expect(p.thisWeek).toContain('Drive the backup route once');
  });

  it('names the drill closing road, not the second road of the route', () => {
    const p = fallbackPlan(sanitizePlanInput({ ...body, drill: { neededMin: 25, closeMin: 30, roadName: 'Highway 9', onSharedStretch: false } }));
    expect(p.whenToLeave).toContain('If Highway 9 is closed');
    expect(p.meetingSpot.reason).toContain('for when Highway 9 is closed');
  });

  it('offers no backup meeting spot when the closing road is on the shared stretch', () => {
    const p = fallbackPlan(sanitizePlanInput({ ...body, drill: { neededMin: 25, closeMin: 30, roadName: 'Willow Dr', onSharedStretch: true } }));
    expect(p.meetingSpot.ifClosed).toBe('');
    expect(p.whenToLeave).toContain('Both routes use Willow Dr');
    expect(p.whenToLeave).not.toContain('take Willow Dr to Ridge Rd');
  });

  it('uses the fallback without a key', async () => {
    const p = await writePlan(sanitizePlanInput(body), { key: '' });
    expect(p.source).toBe('fallback');
  });

  it('accepts a valid model reply and retries without reasoning_effort after a 400', async () => {
    const calls: any[] = [];
    const reply = { whenToLeave: 'Leave as soon as officials tell you to.', meetingSpot: { primary: 'D1 School', ifClosed: 'D2 Hall', reason: 'r' }, goBag: ['Water'], thisWeek: [] };
    const fetchImpl = (async (_u: string, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return new Response('bad', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const orig = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const p = await writePlan(sanitizePlanInput(body), { key: 'k' });
      expect(p.source).toBe('ai');
      expect(calls[0].reasoning_effort).toBe('low');
      expect(calls[1].reasoning_effort).toBeUndefined();
      expect(calls[0].model).toBe('muse-spark-1.3');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('falls back on malformed output', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"x":1}' } }] }))) as unknown as typeof fetch;
    try {
      expect((await writePlan(sanitizePlanInput(body), { key: 'k' })).source).toBe('fallback');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
