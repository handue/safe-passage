import { describe, expect, it, vi } from 'vitest';

vi.mock('./fire', async (importOriginal) => {
  const m = await importOriginal<typeof import('./fire')>();
  return { ...m, simulateFire: vi.fn(m.simulateFire) };
});

import { makeFireGrid, simulateFire } from './fire';
import { runRoute, type DrillRun, type HouseholdCounts, type PreparedForDrill } from './drill';
import { routeFromEdges } from './routing';
import type { EdgeClosures, FireResult, GraphEdge, RoadGraph, Route, Task, XY } from './types';
import {
  CHANGE_TEXT,
  SITUATIONS,
  applicableKinds,
  clampParam,
  defaultSituations,
  passCount,
  runSituations,
  type SituationKind,
  type SituationSpec,
} from './situations';

// Home (node 0) -> node 1 on Home St (2 min), then East Rd to node 2 (3 min, main)
// or North Rd to node 3 (4 min, backup). Edge 3 is East Rd driven back (2 -> 1).
const XYS: XY[] = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }, { x: 1000, y: 1000 }];
function edge(id: number, from: number, to: number, name: string, minutes: number): GraphEdge {
  return { id, from, to, name, highway: 'residential', lengthM: 1000, minutes, shape: [XYS[from], XYS[to]] };
}
const graph: RoadGraph = {
  nodes: XYS.map((xy, id) => ({ id, xy, osmId: id + 1 })),
  edges: [edge(0, 0, 1, 'Home St', 2), edge(1, 1, 2, 'East Rd', 3), edge(2, 1, 3, 'North Rd', 4), edge(3, 2, 1, 'East Rd', 3)],
  adjacency: [[0], [1, 2], [3], []],
};
const mainRoute = routeFromEdges(graph, [0, 1], 'east');
const backupRoute = routeFromEdges(graph, [0, 2], 'north');

const grid = makeFireGrid(100, 60);
// An empty fire: if anything re-derived closures from it, every road would read "never closed".
const fire: FireResult = { grid, ignitionMin: new Float32Array(60 * 60).fill(-1), burnMinutes: 30, horizonMin: 180 };
const CLOSURES: EdgeClosures = new Map([[0, Infinity], [1, 30], [2, 40], [3, 30]]);

const TASKS: Task[] = [
  { id: 'gather', label: 'Gather everyone', minutes: 4, source: 'estimate' },
  { id: 'pets', label: 'Find pet carriers and pets', minutes: 6, source: 'estimate' },
  { id: 'meds', label: 'Gather medications', minutes: 4, source: 'estimate' },
  { id: 'docs', label: 'Documents, phones, chargers', minutes: 3, source: 'estimate' },
  { id: 'load', label: 'Load the car', minutes: 4, source: 'estimate' },
]; // 21 min

const HH: HouseholdCounts = { adults: 2, children: 1, needHelpMoving: 0, dogs: 1, catsAndSmallPets: 0, cars: 1 };

function setup(opts: { backup?: Route | null; closures?: EdgeClosures; start?: 'day' | 'night'; tasks?: Task[] } = {}) {
  const backup = opts.backup === undefined ? backupRoute : opts.backup;
  const closures = opts.closures ?? CLOSURES;
  const start = opts.start ?? 'day';
  const tasks = opts.tasks ?? TASKS;
  const prepared: PreparedForDrill = {
    graph,
    fireGrid: grid,
    elevationPerCell: null,
    waysOut: { homeNodeId: 0, destinations: [], main: mainRoute, backup, sharedFromDoorM: 1000, sharedRoadNames: ['Home St'] },
  };
  const tasksMin = tasks.reduce((s, t) => s + t.minutes, 0) + (start === 'night' ? 3 : 0);
  const base: DrillRun = {
    setup: { ignition: { x: 500, y: 500 }, wind: { fromDeg: 0, speedMph: 10, source: 'manual' }, start, seed: 1 },
    fire,
    closures,
    tasksMin,
    main: runRoute(graph, mainRoute, tasksMin, closures, 180),
    backup: backup ? runRoute(graph, backup, tasksMin, closures, 180) : null,
    bottlenecks: [],
    keyMoments: [],
    coverage: { ignitionInGrid: true, mainUnmodeledEdgeIds: [], backupUnmodeledEdgeIds: [] },
  };
  return { prepared, base, tasks };
}

const spec = (kind: SituationKind, param = SITUATIONS[kind].defaultParam): SituationSpec => ({ kind, param, source: 'rules' });

function one(kind: SituationKind, param?: number, opts?: Parameters<typeof setup>[0]) {
  const { prepared, base, tasks } = setup(opts);
  return runSituations(prepared, base, tasks, [spec(kind, param)])[0];
}

describe('base drill sanity', () => {
  it('main has 4 min to spare at East Rd', () => {
    const { base } = setup();
    expect(base.main!.binding!.name).toBe('East Rd');
    expect(base.main!.binding!.marginMin).toBe(4);
  });
});

describe('situation semantics', () => {
  it('night adds the wake-up minutes and shortens the slowest task', () => {
    const r = one('night', 3);
    expect(r.tasksMin).toBe(24);
    expect(r.departMin).toBe(24);
    expect(r.route).toBe('main');
    expect(r.marginMin).toBe(1);
    expect(r.deltaMin).toBe(-3);
    expect(r.nextAction).toMatchObject({ id: 'shorten:pets', text: CHANGE_TEXT.pets, tag: 'est', marginMin: 5, gainMin: 4, outcome: 'in_time' });
  });

  it('night says to pack the go-bag before bed when the slowest task is a bag task', () => {
    const tasks: Task[] = [{ id: 'meds', label: 'Gather medications', minutes: 9, source: 'estimate' }];
    const r = one('night', 3, { tasks });
    expect(r.nextAction!.text).toBe('Pack the go-bag before bed on red flag nights');
  });

  it('night replaces the base wake-up when the drill already starts at night', () => {
    const r = one('night', 10, { start: 'night' });
    expect(r.tasksMin).toBe(31);
  });

  it('late_order delays the departure; leaving on a warning gains exactly the delay (calc)', () => {
    const r = one('late_order', 10);
    expect(r.tasksMin).toBe(21);
    expect(r.departMin).toBe(31);
    expect(r.outcome).toBe('short');
    expect(r.marginMin).toBe(-6);
    expect(r.deltaMin).toBe(-10);
    expect(r.run!.binding!.name).toBe('East Rd');
    expect(r.nextAction).toMatchObject({ id: 'leave_on_warning', tag: 'calc', gainMin: 10, marginMin: 4, outcome: 'in_time' });
  });

  it('adult_away multiplies gather, help, pets and load only', () => {
    const r = one('adult_away', 1.5);
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t.minutes]));
    expect(by).toEqual({ gather: 6, pets: 9, meds: 4, docs: 3, load: 6 });
    expect(r.tasksMin).toBe(28);
    expect(r.marginMin).toBe(-3);
    expect(r.nextAction).toMatchObject({ id: 'shorten:pets', tag: 'est', gainMin: 6 });
  });

  it('no_car adds or replaces the ride task', () => {
    const r = one('no_car', 10);
    expect(r.tasks.filter((t) => t.id === 'ride')).toEqual([{ id: 'ride', label: 'Reach a ride', minutes: 10, source: 'estimate' }]);
    expect(r.tasksMin).toBe(31);
    expect(r.nextAction).toMatchObject({ id: 'shorten:ride', text: CHANGE_TEXT.ride, tag: 'est', gainMin: 7 });
    const withRide = [...TASKS, { id: 'ride', label: 'Reach a ride', minutes: 20, source: 'estimate' as const }];
    const r2 = one('no_car', 12, { tasks: withRide });
    expect(r2.tasks.filter((t) => t.id === 'ride').map((t) => t.minutes)).toEqual([12]);
    expect(r2.tasksMin).toBe(33);
  });

  it('slow_traffic scales drive times without changing the graph, and switches route when that is better', () => {
    const before = graph.edges.map((e) => e.minutes);
    const r = one('slow_traffic', 1.5);
    expect(graph.edges.map((e) => e.minutes)).toEqual(before);
    expect(r.route).toBe('main');
    expect(r.run!.binding!.passMin).toBeCloseTo(28.5, 9);
    expect(r.marginMin).toBeCloseTo(1.5, 9);
    expect(r.run!.arriveMin).toBeCloseTo(28.5, 9);
    expect(r.run!.route).toBe(mainRoute);
    // Backup under the same slowdown: 21 + 3 + 6 = 30, closes 40 -> 10 to spare.
    expect(r.nextAction).toMatchObject({ id: 'switch_backup', tag: 'calc', text: 'Take the backup route on North Rd' });
    expect(r.nextAction!.marginMin).toBeCloseTo(10, 9);
    expect(r.nextAction!.gainMin).toBeCloseTo(8.5, 9);
  });

  it('slow_traffic shortens the slowest task when there is no better route', () => {
    const r = one('slow_traffic', 2, { backup: null });
    expect(r.nextAction).toMatchObject({ id: 'shorten:pets', tag: 'est', gainMin: 4 });
  });

  it('road_blocked drives the backup with normal timing and names the blocked road', () => {
    const r = one('road_blocked');
    expect(r.route).toBe('backup');
    expect(r.run!.route).toBe(backupRoute);
    expect(r.departMin).toBe(21);
    expect(r.marginMin).toBe(13);
    expect(r.deltaMin).toBe(9);
    expect(r.info.assumption(0)).toBe('East Rd is blocked from the start, so you take the backup route.');
    expect(SITUATIONS.road_blocked.assumption(0)).not.toContain('East Rd');
    expect(r.nextAction).toMatchObject({ id: 'shorten:pets', tag: 'est', gainMin: 4 });
  });

  it('road_blocked without a backup has no route', () => {
    const r = one('road_blocked', 0, { backup: null });
    expect(r).toMatchObject({ route: null, run: null, outcome: 'no_route', marginMin: null, deltaMin: null, nextAction: null });
  });

  it('pet_hides adds minutes to the pets task; keeping pets inside cuts it to a third of the original', () => {
    const r = one('pet_hides', 10);
    expect(r.tasks.find((t) => t.id === 'pets')!.minutes).toBe(16);
    expect(r.tasksMin).toBe(31);
    expect(r.marginMin).toBe(-6);
    expect(r.nextAction).toMatchObject({ id: 'pets_inside', tag: 'est', marginMin: 8, gainMin: 14 });
  });

  it('clamps the param it runs with', () => {
    const r = one('late_order', 99);
    expect(r.spec.param).toBe(30);
    expect(r.departMin).toBe(51);
  });

  it('never_closed: Infinity margin, no change, nothing to do', () => {
    const open: EdgeClosures = new Map([[0, Infinity], [1, Infinity], [2, Infinity], [3, Infinity]]);
    const r = one('late_order', 10, { closures: open });
    expect(r.outcome).toBe('never_closed');
    expect(r.marginMin).toBe(Infinity);
    expect(r.deltaMin).toBe(0);
    expect(r.nextAction).toBeNull();
  });

  it('gain is Infinity when the action makes the route never close', () => {
    // North Rd never closes, so switching to the backup in slow traffic removes the closure.
    const northOpen: EdgeClosures = new Map([[0, Infinity], [1, 30], [2, Infinity], [3, 30]]);
    const r = one('slow_traffic', 1.5, { closures: northOpen });
    expect(r.nextAction).toMatchObject({ id: 'switch_backup', tag: 'calc', marginMin: Infinity, gainMin: Infinity, outcome: 'never_closed' });
  });

  it('uses the same fire: no new simulation, closures come from base.closures', () => {
    vi.mocked(simulateFire).mockClear();
    const { prepared, base, tasks } = setup();
    const kinds: SituationKind[] = ['night', 'late_order', 'adult_away', 'no_car', 'slow_traffic', 'road_blocked', 'pet_hides'];
    const results = runSituations(prepared, base, tasks, kinds.map((k) => spec(k)));
    expect(simulateFire).not.toHaveBeenCalled();
    expect(results).toHaveLength(7);
    // The empty fire would give no closures; East Rd closing at 30 can only come from base.closures.
    expect(results[0].run!.binding!.closeMin).toBe(30);
    expect(results[0].run!.destinationFire).toEqual({ fireMin: Infinity, beforeArrival: false, inGrid: true });
  });
});

describe('applicableKinds and defaultSituations', () => {
  it('includes everything for a full household on a day drill', () => {
    const { prepared, base } = setup();
    expect(applicableKinds(HH, prepared, base)).toEqual(['night', 'late_order', 'adult_away', 'no_car', 'slow_traffic', 'road_blocked', 'pet_hides']);
  });

  it('drops kinds that cannot apply', () => {
    const { prepared, base } = setup({ start: 'night' });
    const h = { ...HH, adults: 1, cars: 0, dogs: 0, catsAndSmallPets: 0 };
    expect(applicableKinds(h, prepared, base)).toEqual(['late_order', 'slow_traffic', 'road_blocked']);
  });

  it('road_blocked needs a main-only edge, comparing segments in both directions', () => {
    // A backup that drives every main segment (East Rd backwards) leaves nothing main-only.
    const covering = routeFromEdges(graph, [0, 3], 'x');
    const { prepared, base } = setup({ backup: covering });
    expect(applicableKinds(HH, prepared, base)).not.toContain('road_blocked');
    const none = setup({ backup: null });
    expect(applicableKinds(HH, none.prepared, none.base)).toContain('road_blocked');
  });

  it('rules pick up to 6 in priority order with default params', () => {
    const { prepared, base } = setup();
    const d = defaultSituations(HH, prepared, base);
    expect(d.map((s) => s.kind)).toEqual(['late_order', 'road_blocked', 'night', 'adult_away', 'pet_hides', 'slow_traffic']);
    expect(d.every((s) => s.source === 'rules' && s.param === SITUATIONS[s.kind].defaultParam)).toBe(true);
    const small = defaultSituations({ ...HH, adults: 1, dogs: 0 }, prepared, base);
    expect(small.map((s) => s.kind)).toEqual(['late_order', 'road_blocked', 'night', 'slow_traffic', 'no_car']);
  });
});

describe('clampParam', () => {
  it('clamps, rounds and defaults', () => {
    expect(clampParam('late_order', 2)).toBe(5);
    expect(clampParam('late_order', 12.4)).toBe(12);
    expect(clampParam('night', 100)).toBe(15);
    expect(clampParam('adult_away', 1.57)).toBe(1.6);
    expect(clampParam('slow_traffic', 9)).toBe(3);
    expect(clampParam('pet_hides', Number.NaN)).toBe(10);
    expect(clampParam('road_blocked', 5)).toBe(0);
  });
});

describe('passCount', () => {
  it('counts results that are not short and have a route', () => {
    const { prepared, base, tasks } = setup({ backup: null });
    const results = runSituations(prepared, base, tasks, [spec('night'), spec('late_order'), spec('road_blocked'), spec('slow_traffic', 1.2)]);
    expect(results.map((r) => r.outcome)).toEqual(['in_time', 'short', 'no_route', 'in_time']);
    expect(passCount(results)).toEqual({ pass: 2, total: 4 });
    expect(passCount([])).toEqual({ pass: 0, total: 0 });
  });
});

describe('road names when both routes share a road', () => {
  // Main: Home St, then Oak Ave 1 -> 2. Backup: Home St, Oak Ave 1 -> 3 (another stretch), Pine Rd 3 -> 4.
  const P: XY[] = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 }, { x: 1000, y: 1000 }, { x: 1000, y: 2000 }];
  const e = (id: number, from: number, to: number, name: string): GraphEdge => ({ id, from, to, name, highway: 'residential', lengthM: 1000, minutes: 2, shape: [P[from], P[to]] });
  const g: RoadGraph = {
    nodes: P.map((xy, id) => ({ id, xy, osmId: id + 1 })),
    edges: [e(0, 0, 1, 'Home St'), e(1, 1, 2, 'Oak Ave'), e(2, 1, 3, 'Oak Ave'), e(3, 3, 4, 'Pine Rd')],
    adjacency: [[0], [1, 2], [], [3], []],
  };
  const main = routeFromEdges(g, [0, 1], 'east');
  const backup = routeFromEdges(g, [0, 2, 3], 'north');
  const closures: EdgeClosures = new Map([[0, Infinity], [1, 30], [2, Infinity], [3, Infinity]]);
  const prepared: PreparedForDrill = {
    graph: g,
    fireGrid: grid,
    elevationPerCell: null,
    waysOut: { homeNodeId: 0, destinations: [], main, backup, sharedFromDoorM: 1000, sharedRoadNames: ['Home St'] },
  };
  const base: DrillRun = {
    setup: { ignition: { x: 500, y: 500 }, wind: { fromDeg: 0, speedMph: 10, source: 'manual' }, start: 'day', seed: 1 },
    fire,
    closures,
    tasksMin: 21,
    main: runRoute(g, main, 21, closures, 180),
    backup: runRoute(g, backup, 21, closures, 180),
    bottlenecks: [],
    keyMoments: [],
    coverage: { ignitionInGrid: true, mainUnmodeledEdgeIds: [], backupUnmodeledEdgeIds: [] },
  };

  it('road_blocked says only a stretch of the shared road is blocked, and names the backup-only road', () => {
    const [r] = runSituations(prepared, base, TASKS, [spec('road_blocked')]);
    expect(r.info.assumption(0)).toBe('A stretch of Oak Ave on the main route is blocked from the start, so you take the backup route by Pine Rd.');
  });

  it('slow_traffic names a road the main route does not use', () => {
    const [r] = runSituations(prepared, base, TASKS, [spec('slow_traffic', 3)]);
    expect(r.nextAction?.text).toBe('Take the backup route on Pine Rd');
  });
});
