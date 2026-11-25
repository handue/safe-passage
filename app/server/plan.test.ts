import { describe, expect, it } from 'vitest';
import { backupSentence, fallbackPlan, sanitizePlanInput, withBackupSentence, writePlan } from './plan.ts';

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

  it('never says "If X is closed, take X" when the backup also uses X', () => {
    const shared = { ...body, main: { ...body.main, roadNames: ['Willow Dr', 'Great Western Hwy', 'Highway 9'] }, backup: { ...body.backup, roadNames: ['Willow Dr', 'Great Western Hwy', 'Bathurst Rd'] } };
    const drill = { neededMin: 25, closeMin: 30, roadName: 'Great Western Hwy', onSharedStretch: false, backupCut: false };
    const turn = fallbackPlan(sanitizePlanInput({ ...shared, drill, backupTurn: 'west' }));
    expect(turn.whenToLeave).not.toMatch(/If Great Western Hwy is closed, take [^.]*Great Western Hwy/);
    expect(turn.whenToLeave).toContain('turn west on Great Western Hwy');
    expect(turn.whenToLeave).toContain('take Willow Dr, then turn west on Great Western Hwy, then take Bathurst Rd toward D2 Hall');
    expect(turn.meetingSpot.ifClosed).toBe('D2 Hall, front entrance');
    // No turn known: say both routes use it, and offer no backup spot.
    const noTurn = fallbackPlan(sanitizePlanInput({ ...shared, drill, backupTurn: '' }));
    expect(noTurn.whenToLeave).toContain('Both routes use Great Western Hwy. If it is closed, follow official directions.');
    expect(noTurn.meetingSpot.ifClosed).toBe('');
  });

  it('says both routes were closed when the backup is cut in this drill', () => {
    const p = fallbackPlan(sanitizePlanInput({ ...body, drill: { neededMin: 25, closeMin: 30, roadName: 'Creek Rd', onSharedStretch: false, backupCut: true } }));
    expect(p.whenToLeave).toContain('closed both routes');
    expect(p.whenToLeave).toContain('follow official directions');
    expect(p.whenToLeave).not.toContain('take Willow Dr to Ridge Rd');
    expect(p.meetingSpot.ifClosed).toBe('');
    // The plan page shows the "agree on a spot" note itself, so the reason does not repeat it.
    expect(p.meetingSpot.reason).not.toContain('no backup meeting spot');
  });

  it('gives no front entrance for an exit point', () => {
    const p = fallbackPlan(sanitizePlanInput({
      ...body,
      main: { ...body.main, destination: 'D1 Exit point', exitPoint: true },
      backup: { ...body.backup, destination: 'D2 Exit point', exitPoint: true },
    }));
    expect(p.meetingSpot.primary).toBe('');
    expect(p.meetingSpot.ifClosed).toBe('');
    expect(p.meetingSpot.reason).toContain('not a place to wait');
    expect(JSON.stringify(p)).not.toContain('front entrance');
  });

  it('accepts only compass words for the backup turn', () => {
    expect(sanitizePlanInput({ ...body, backupTurn: 'west' }).backupTurn).toBe('west');
    expect(sanitizePlanInput({ ...body, backupTurn: '<b>left</b>' }).backupTurn).toBe('');
  });

  it('replaces the writer\'s closed-road sentences with the calculated one', () => {
    const input = sanitizePlanInput({ ...body, drill: { neededMin: 25, closeMin: 30, roadName: 'Willow Dr', onSharedStretch: false, backupCut: true } });
    const text = 'Leave as soon as officials tell you to. Take Willow Dr to Creek Rd. If Willow Dr is closed, take Willow Dr to Ridge Rd.';
    const out = withBackupSentence(text, input);
    expect(out).toBe(`Leave as soon as officials tell you to. Take Willow Dr to Creek Rd. ${backupSentence(input)}`);
    expect(out).not.toContain('take Willow Dr to Ridge Rd');
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
      expect(p.whenToLeave).toContain('If Creek Rd is closed, take Willow Dr to Ridge Rd toward D2 Hall.');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('stops the model call when the caller aborts', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = ((_u: string, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as unknown as typeof fetch;
    try {
      const ac = new AbortController();
      const pending = writePlan(sanitizePlanInput(body), { key: 'k', signal: ac.signal });
      ac.abort();
      const p = await pending;
      expect(p.source).toBe('fallback');
      expect(p.note).toBe('Request cancelled');
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
