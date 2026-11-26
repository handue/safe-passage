import { describe, expect, it } from 'vitest';
import { deltaWords, nextActionWords, resultWords, shownMargin } from './SituationsSection';
import type { RouteRun } from '../engine/types';

const rr = (closeMin: number, passMin: number): RouteRun =>
  ({
    route: { destinationId: 'd', edgeIds: [], lengthM: 0, driveMin: 0, roadNames: [] },
    departMin: 0,
    legs: [],
    binding: { edgeId: 1, name: 'Highway 9', closeMin, passMin, marginMin: closeMin - passMin, xy: { x: 0, y: 0 } },
    outcome: passMin > closeMin ? 'short' : 'in_time',
    arriveMin: passMin + 2,
  }) as RouteRun;
const open = { ...rr(0, 0), binding: null, outcome: 'never_closed' } as RouteRun;

describe('situation result words', () => {
  it('says short, spare, never closed and no route with an icon', () => {
    expect(resultWords({ run: rr(30, 36), outcome: 'short' })).toMatchObject({ tone: 'short', icon: 'closed', text: '6 min short', shown: -6 });
    expect(resultWords({ run: rr(30, 27), outcome: 'in_time' })).toMatchObject({ tone: 'spare', icon: 'check', text: '3 min to spare', shown: 3 });
    expect(resultWords({ run: open, outcome: 'never_closed' })).toMatchObject({ tone: 'open', text: 'Road never closed in this fire', shown: Infinity });
    expect(resultWords({ run: null, outcome: 'no_route' })).toMatchObject({ tone: 'none', text: 'No route', shown: null });
  });

  it('rounds each T+ value first, like the headline', () => {
    expect(shownMargin(rr(30.4, 36.6))).toBe(-7);
  });

  it('compares with this drill from the numbers shown', () => {
    const base = rr(30, 29);
    expect(deltaWords({ run: rr(30, 36), outcome: 'short' }, base)).toBe('−7 min vs this drill');
    expect(deltaWords({ run: rr(30, 26), outcome: 'in_time' }, base)).toBe('+3 min vs this drill');
    expect(deltaWords({ run: rr(30, 29), outcome: 'in_time' }, base)).toBe('Same as this drill');
    expect(deltaWords({ run: open, outcome: 'never_closed' }, base)).toBe('Better than this drill');
    expect(deltaWords({ run: rr(30, 36), outcome: 'short' }, open)).toBe('Worse than this drill');
    expect(deltaWords({ run: null, outcome: 'no_route' }, base)).toBe('');
  });

  it('words the next action with its gain over the situation', () => {
    const na = { id: 'a', text: 'Leave on a warning', tag: 'calc' as const, marginMin: 2, gainMin: 8, outcome: 'in_time' as const, run: rr(30, 28) };
    expect(nextActionWords({ run: rr(30, 36), outcome: 'short', nextAction: na })).toBe('2 min to spare (+8)');
    expect(nextActionWords({ run: rr(30, 36), outcome: 'short', nextAction: { ...na, marginMin: -1.2, outcome: 'short', run: rr(30, 31.2) } })).toBe('1 min short (+5)');
    expect(nextActionWords({ run: rr(30, 36), outcome: 'short', nextAction: { ...na, marginMin: Infinity, outcome: 'never_closed', run: open } })).toBe('road never closes');
    expect(nextActionWords({ run: rr(30, 36), outcome: 'short', nextAction: null })).toBeNull();
  });

  it('takes the after margin from the rounded T+ values of the action run', () => {
    // Raw margin 2.0 (30.4 - 28.4) but shown T+30 / T+28 -> 2; raw 1.6 (30.4 - 28.8) shows T+30 / T+29 -> 1, not round(1.6) = 2.
    const na = { id: 'a', text: 'Leave on a warning', tag: 'calc' as const, marginMin: 1.6, gainMin: 7.6, outcome: 'in_time' as const, run: rr(30.4, 28.8) };
    expect(nextActionWords({ run: rr(30, 36), outcome: 'short', nextAction: na })).toBe('1 min to spare (+7)');
  });
});
