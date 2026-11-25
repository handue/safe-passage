import { describe, expect, it } from 'vitest';
import type { Route, RouteRun } from '../engine/types';
import { destinationFireText, distinctiveRoad, fireCaptionFor, verdictOf, wayOutKey, wayOutName } from './ResultsScreen';
import { minutesUntil, reached, shortBy, spare } from './DrillRunningScreen';
import { pickRefusal } from './DrillSetupScreen';
import { fmtT } from '../ui/Tag';

const A: Route = { destinationId: 'd1', edgeIds: [0, 1, 2], lengthM: 3000, driveMin: 9, roadNames: ['West Park Avenue', 'Skyway', 'Clark Road'] };
const B: Route = { destinationId: 'd2', edgeIds: [0, 3, 4], lengthM: 3200, driveMin: 11, roadNames: ['West Park Avenue', 'Black Olive Drive', 'Clark Road'] };
const ways = { main: A, backup: B };

function runOf(route: Route, binding: RouteRun['binding'], outcome: RouteRun['outcome'], arriveMin = 30): RouteRun {
  return { route, departMin: 20, legs: [], binding, outcome, arriveMin };
}

describe('one name per way out', () => {
  it('names each route by the first road the other does not use', () => {
    expect(distinctiveRoad(A, B)).toBe('Skyway');
    expect(distinctiveRoad(B, A)).toBe('Black Olive Drive');
    expect(wayOutName(ways, A)).toBe('Way out A via Skyway');
    expect(wayOutName(ways, B)).toBe('Way out B via Black Olive Drive');
  });

  it('gives a route the same name wherever it appears, even as a copy', () => {
    expect(wayOutName(ways, { ...B, roadNames: [...B.roadNames], edgeIds: [...B.edgeIds] })).toBe(wayOutName(ways, B));
    expect(wayOutKey(ways, { ...A, edgeIds: [9] })).toBeNull();
  });

  it('falls back to the last named road when both use the same roads', () => {
    const same: Route = { ...B, roadNames: A.roadNames };
    expect(distinctiveRoad(same, A)).toBe('Clark Road');
    expect(distinctiveRoad({ ...A, roadNames: ['Unnamed road'] }, null)).toBe('unnamed roads');
  });
});

describe('rounding is the same on running and results', () => {
  const binding = { edgeId: 1, name: 'Skyway', closeMin: 109.4, passMin: 28.6, marginMin: 80.8, xy: { x: 0, y: 0 } };

  it('counts down to the shown T+ value', () => {
    // Pass at 28.6 shows T+29; at minute 0 the countdown says 29 (it used to round up to 29 or 30 inconsistently).
    expect(fmtT(binding.passMin)).toBe('T+29');
    expect(minutesUntil(binding.passMin, 0)).toBe(29);
    expect(minutesUntil(binding.passMin, 28)).toBe(1);
    expect(reached(binding.passMin, 28)).toBe(false);
    expect(reached(binding.passMin, 29)).toBe(true);
    // Countdown plus spare equals the closing countdown.
    expect(minutesUntil(binding.closeMin, 0) - minutesUntil(binding.passMin, 0)).toBe(80);
  });

  it('spare and short use the rounded T+ values, like results', () => {
    const run = runOf(A, binding, 'in_time');
    expect(spare(binding.closeMin, binding.passMin)).toBe('80 min to spare');
    expect(verdictOf(run).text).toBe('80 minutes to spare');
    const tight = { ...binding, closeMin: 20.4, passMin: 20.6, marginMin: -0.2 };
    expect(shortBy(tight.passMin, tight.closeMin)).toBe('1 min short on this plan');
    expect(verdictOf(runOf(A, tight, 'short')).text).toBe('1 minute short');
    const zero = { ...binding, closeMin: 20.4, passMin: 20.45, marginMin: -0.05 };
    expect(verdictOf(runOf(A, zero, 'short')).text).toBe('under 1 minute short');
  });
});

describe('results captions and warnings', () => {
  it('says which minute the map shows', () => {
    const b = { edgeId: 1, name: 'Skyway', closeMin: 56, passMin: 28, marginMin: 28, xy: { x: 0, y: 0 } };
    expect(fireCaptionFor(runOf(A, b, 'in_time'))).toBe('Fire shown at T+28, when you pass Skyway');
    expect(fireCaptionFor(runOf(A, { ...b, closeMin: 20 }, 'short'))).toBe('Fire shown at T+28, when you would reach Skyway');
    expect(fireCaptionFor(runOf(A, null, 'never_closed', 37))).toBe('Fire shown at T+37, when you arrive');
  });

  it('warns when the fire reaches the destination', () => {
    const base = runOf(A, null, 'never_closed', 37);
    expect(destinationFireText({ ...base, destinationFire: { fireMin: 30, beforeArrival: true, inGrid: true } }, 'D1 School')).toMatch(/reaches D1 School at T\+30, before you would arrive at T\+37/);
    expect(destinationFireText({ ...base, destinationFire: { fireMin: 50, beforeArrival: false, inGrid: true } }, 'D1 School')).toMatch(/after you would arrive/);
    expect(destinationFireText({ ...base, destinationFire: { fireMin: Infinity, beforeArrival: false, inGrid: true } }, 'D1')).toBeNull();
    expect(destinationFireText({ ...base, destinationFire: { fireMin: Infinity, beforeArrival: false, inGrid: false } }, 'D1')).toBeNull();
    expect(destinationFireText(base, 'D1')).toBeNull();
  });
});

describe('drill setup picks', () => {
  it('refuses sea and outside points with a message', () => {
    expect(pickRefusal('water')).toMatch(/sea/);
    expect(pickRefusal('outside')).toMatch(/outside the area/);
    expect(pickRefusal('ok')).toBeNull();
  });
});
