import { describe, expect, it } from 'vitest';
import demoArea from '../../server/demo-area.json';
import { prepareArea } from './area';
import { defaultTasks, runDrill } from './drill';
import { suggestIgnitions } from './ignition';
import { runWithDriveScale } from './situations';
import { FIRE_RUNS, fireSeeds, firmness, marginOfRun, marginText, rangeOf, rangeText, type RunMargin } from './spread';
import type { AreaData, Route, Wind } from './types';
import { timedMinutes, clockText } from '../ui/clock';
import { fixedTasks } from '../app/state';

const area = demoArea as unknown as AreaData;
const prepared = prepareArea(area);
const wind: Wind = { fromDeg: 45, speedMph: 25, source: 'manual' };
const shape = (r: Route | null) => (r ? r.edgeIds.flatMap((id) => prepared.graph.edges[id].shape) : []);
const ignition = suggestIgnitions(prepared.fireGrid, prepared.elevationPerCell, wind, prepared.homeXY, shape(prepared.waysOut.main), [shape(prepared.waysOut.backup)])[0].xy;
const tasks = defaultTasks({ adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 1, cars: 1 });
const base = runDrill(prepared, tasks, { ignition, wind, start: 'day', seed: 1 });

const m = (outcome: RunMargin['outcome'], signed: number | null, raw = signed ?? Infinity): RunMargin => ({ outcome, signed, raw });

describe('fire runs and evacuation traffic (demo address)', () => {
  const f = firmness(prepared, base, tasks);

  it('runs the same fire FIRE_RUNS times, starting with the drill on screen', () => {
    expect(f.runs).toBe(FIRE_RUNS);
    expect(f.seeds[0]).toBe(base.setup.seed);
    expect(new Set(f.seeds).size).toBe(FIRE_RUNS);
    expect(f.fire.total).toBe(FIRE_RUNS);
  });

  it('the on-screen run lies inside the range', () => {
    const own = marginOfRun(base.main)!;
    expect(f.fire.worst!.raw).toBeLessThanOrEqual(own.raw);
    expect(f.fire.best!.raw).toBeGreaterThanOrEqual(own.raw);
  });

  it('is the same as running each seed by hand', () => {
    const seeds = fireSeeds(1);
    const raws = seeds.map((seed) => marginOfRun(runDrill(prepared, tasks, { ...base.setup, seed }).main)!.raw);
    expect(f.fire.worst!.raw).toBeCloseTo(Math.min(...raws), 9);
    expect(f.fire.best!.raw).toBeCloseTo(Math.max(...raws), 9);
  });

  it('traffic never leaves more time than free-flow driving on the same fire', () => {
    expect(f.trafficScale).toBe(1.5);
    expect(f.traffic.worst!.raw).toBeLessThanOrEqual(f.fire.worst!.raw);
    expect(f.traffic.short).toBeGreaterThanOrEqual(f.fire.short);
  });

  it('a drive scale of 1 is the drill itself', () => {
    const r = runWithDriveScale(prepared, base, tasks, 1)!;
    expect(r.binding!.marginMin).toBeCloseTo(base.main!.binding!.marginMin, 9);
  });

  it('counts timed and estimated tasks', () => {
    const timed = tasks.map((t, i) => (i < 2 ? { ...t, source: 'timed' as const } : t));
    const g = firmness(prepared, base, timed, 1.5, 2);
    expect(g.timedTasks).toBe(2);
    expect(g.estimatedTasks).toBe(tasks.length - 2);
  });
});

describe('range words', () => {
  it('orders by raw margin and counts short and open runs', () => {
    const r = rangeOf([m('in_time', 4, 4.2), m('short', -2, -1.6), m('never_closed', null), null, m('in_time', 0, 0.3)]);
    expect(r.total).toBe(4);
    expect(r.short).toBe(1);
    expect(r.open).toBe(1);
    expect(r.worst!.signed).toBe(-2);
    expect(r.best!.signed).toBe(4);
    expect(rangeText(r)).toBe('from 2 min short to 4 min to spare');
  });

  it('shortens a range that stays on one side', () => {
    expect(rangeText(rangeOf([m('in_time', 8), m('in_time', 16)]))).toBe('8 to 16 min to spare');
    expect(rangeText(rangeOf([m('short', -3), m('short', -1)]))).toBe('1 to 3 min short');
    expect(rangeText(rangeOf([m('in_time', 0, 0.2), m('in_time', 5)]))).toBe('from under 1 min to spare to 5 min to spare');
  });

  it('orders by the shown (rounded) value, so a range never reads backwards', () => {
    // raw -0.3 rounds to 0, raw -0.2 rounds to -1: by raw the -1 run would be "best".
    expect(rangeText(rangeOf([m('short', 0, -0.3), m('short', -1, -0.2)]))).toBe('from 1 min short to under 1 min short');
    expect(rangeText(rangeOf([m('in_time', 2, 1.4), m('in_time', 1, 1.5)]))).toBe('1 to 2 min to spare');
  });

  it('says "under 1 min" for a rounded zero, with the outcome word', () => {
    expect(marginText(m('short', 0, -0.2))).toBe('under 1 min short');
    expect(marginText(m('in_time', 0, 0.2))).toBe('under 1 min to spare');
  });

  it('one value for every run, and nothing when no run closed the road', () => {
    expect(rangeText(rangeOf([m('in_time', 3), m('in_time', 3)]))).toBe('3 min to spare in every run');
    expect(rangeText(rangeOf([m('in_time', 3), m('never_closed', null)]))).toBe('3 min to spare in every run that closed the road');
    expect(rangeText(rangeOf([m('never_closed', null)]))).toBeNull();
  });
});

describe('stopwatch minutes', () => {
  it('rounds to the nearest minute, at least 1', () => {
    expect(timedMinutes(5)).toBe(1);
    expect(timedMinutes(89)).toBe(1);
    expect(timedMinutes(90)).toBe(2);
    expect(timedMinutes(7 * 60 + 10)).toBe(7);
  });

  it('shows m:ss', () => {
    expect(clockText(0)).toBe('0:00');
    expect(clockText(247.9)).toBe('4:07');
  });

  it('a fixed task becomes an estimate again', () => {
    const timed = tasks.map((t) => ({ ...t, source: 'timed' as const }));
    const out = fixedTasks(timed, { taskMinutes: { pets: 2 }, switchMainRoute: false });
    expect(out.find((t) => t.id === 'pets')!.source).toBe('estimate');
    expect(out.filter((t) => t.source === 'timed').length).toBe(timed.length - 1);
  });
});
