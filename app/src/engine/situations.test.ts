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
  autoPickKinds,
  clampParam,
  defaultSituations,
  emptyParts,
  passCount,
  rebaseCustomParts,
  runCustomSituation,
  runCustomSituations,
  runSituations,
  sanitizeCustomParts,
  type CustomParts,
  type CustomSituation,
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

  it('auto picks leave out slow_traffic, which is shown with every result; typed situations keep it', () => {
    const { prepared, base } = setup();
    expect(autoPickKinds(HH, prepared, base)).toEqual(['night', 'late_order', 'adult_away', 'no_car', 'road_blocked', 'pet_hides']);
    expect(applicableKinds(HH, prepared, base)).toContain('slow_traffic');
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
    expect(d.map((s) => s.kind)).toEqual(['late_order', 'road_blocked', 'night', 'adult_away', 'pet_hides', 'no_car']);
    expect(d.every((s) => s.source === 'rules' && s.param === SITUATIONS[s.kind].defaultParam)).toBe(true);
    const small = defaultSituations({ ...HH, adults: 1, dogs: 0 }, prepared, base);
    expect(small.map((s) => s.kind)).toEqual(['late_order', 'road_blocked', 'night', 'no_car']);
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

// ---------- Custom situations ----------

const parts = (p: Partial<CustomParts>): CustomParts => ({ situations: [], addTasks: [], taskMinutes: {}, ...p });
const custom = (p: Partial<CustomParts>, title = 'Harder day'): CustomSituation => ({ id: 'c1', text: 'typed text', title, parts: parts(p), titleSource: 'ai' });
function runC(p: Partial<CustomParts>, opts?: Parameters<typeof setup>[0]) {
  const { prepared, base, tasks } = setup(opts);
  return runCustomSituation(prepared, base, tasks, custom(p));
}

describe('runCustomSituation', () => {
  it('stacks several parts together: task changes, adult away, late order; best action is measured', () => {
    const r = runC({
      situations: [{ kind: 'late_order', param: 5 }, { kind: 'adult_away', param: 1.5 }],
      addTasks: [{ label: 'Hitch the horse trailer', minutes: 3 }],
      taskMinutes: { meds: 0 },
    });
    // gather 6, pets 9, docs 3, load 6, trailer 3 (not multiplied) = 27; meds removed.
    expect(Object.fromEntries(r.tasks.map((t) => [t.id, t.minutes]))).toEqual({ gather: 6, pets: 9, docs: 3, load: 6, 'added-1': 3 });
    expect(r.tasks.find((t) => t.id === 'added-1')!.label).toBe('Hitch the horse trailer');
    expect(r.tasksMin).toBe(27);
    expect(r.departMin).toBe(32);
    expect(r.route).toBe('main');
    expect(r.outcome).toBe('short');
    expect(r.marginMin).toBe(-7);
    expect(r.deltaMin).toBe(-11);
    // leave on warning +5 (calc), shorten pets 9 -> 3 +6 (est), backup at 32: 40 - 38 = 2 -> +9 (calc).
    expect(r.nextAction).toMatchObject({ id: 'switch_backup', tag: 'calc', marginMin: 2, gainMin: 9, outcome: 'in_time' });
    expect(r.nextAction!.run.route).toBe(backupRoute);
    expect(r.info.title).toBe('Harder day');
    expect(r.info.assumption(0)).toBe(
      'Leave 5 min after the fire starts, when the order comes; one adult is away, so gathering, helping, pets and loading take 1.5 times longer; skip: Gather medications; added task: Hitch the horse trailer (3 min).',
    );
    expect(r.custom!.parts.addTasks).toEqual([{ label: 'Hitch the horse trailer', minutes: 3 }]);
  });

  it('effects stack in a fixed order whatever order the parts come in', () => {
    const a = runC({ situations: [{ kind: 'adult_away', param: 1.5 }, { kind: 'pet_hides', param: 10 }] });
    const b = runC({ situations: [{ kind: 'pet_hides', param: 10 }, { kind: 'adult_away', param: 1.5 }] });
    // pets: (6 + 10) * 1.5 = 24
    expect(a.tasks.find((t) => t.id === 'pets')!.minutes).toBe(24);
    expect(a.tasksMin).toBe(43);
    expect(b.tasksMin).toBe(43);
    expect(b.marginMin).toBe(a.marginMin);
  });

  it('road_blocked + late_order: backup driven after the delay; leaving on a warning is the best action', () => {
    const r = runC({ situations: [{ kind: 'road_blocked', param: 0 }, { kind: 'late_order', param: 10 }] });
    expect(r.route).toBe('backup');
    expect(r.run!.route).toBe(backupRoute);
    expect(r.departMin).toBe(31);
    expect(r.marginMin).toBe(3);
    expect(r.deltaMin).toBe(-1);
    // shorten pets +4 (est), leave on warning +10 (calc); no route switch offered off a blocked main.
    expect(r.nextAction).toMatchObject({ id: 'leave_on_warning', tag: 'calc', marginMin: 13, gainMin: 10 });
    expect(r.nextAction!.run.route).toBe(backupRoute);
    expect(r.info.assumption(0)).toBe(
      'East Rd is blocked from the start, so you take the backup route; leave 10 min after the fire starts, when the order comes.',
    );
  });

  it('changes and removes existing tasks (0 removes); switching route is offered when it helps', () => {
    const r = runC({ taskMinutes: { pets: 0, load: 12 } });
    expect(r.tasks.map((t) => t.id)).toEqual(['gather', 'meds', 'docs', 'load']);
    expect(r.tasks.find((t) => t.id === 'load')!.minutes).toBe(12);
    expect(r.tasksMin).toBe(23);
    expect(r.marginMin).toBe(2);
    expect(r.deltaMin).toBe(-2);
    // shorten load 12 -> 4: +8 (est); backup at 23: 40 - 29 = 11: +9 (calc).
    expect(r.nextAction).toMatchObject({ id: 'switch_backup', text: 'Take the backup route on North Rd', tag: 'calc', gainMin: 9 });
    expect(r.info.assumption(0)).toBe('Skip: Find pet carriers and pets; Load the car takes 12 min.');
  });

  it('an added task can be the one to shorten (est), with a plain "Shorten:" text', () => {
    const r = runC({ addTasks: [{ label: 'Hitch the horse trailer', minutes: 30 }] }, { backup: null });
    expect(r.tasksMin).toBe(51);
    expect(r.marginMin).toBe(-26);
    expect(r.nextAction).toMatchObject({ id: 'shorten:added-1', text: 'Shorten: Hitch the horse trailer', tag: 'est', gainMin: 20 });
  });

  it('added task ids skip ids the household already uses', () => {
    const tasks: Task[] = [...TASKS, { id: 'added-1', label: 'Old', minutes: 1, source: 'estimate' }];
    const r = runC({ addTasks: [{ label: 'A', minutes: 2 }, { label: 'B', minutes: 2 }] }, { tasks });
    expect(r.tasks.map((t) => t.id).slice(-3)).toEqual(['added-1', 'added-2', 'added-3']);
  });

  it('pet_hides after the pets task was removed adds a pets task with the extra minutes', () => {
    const r = runC({ situations: [{ kind: 'pet_hides', param: 10 }], taskMinutes: { pets: 0 } });
    expect(r.tasks.filter((t) => t.id === 'pets').map((t) => t.minutes)).toEqual([10]);
  });

  it('a one-part custom row computes the same times as the catalog row', () => {
    const { prepared, base, tasks } = setup();
    const kinds: SituationKind[] = ['night', 'late_order', 'adult_away', 'no_car', 'slow_traffic', 'road_blocked', 'pet_hides'];
    for (const kind of kinds) {
      const param = SITUATIONS[kind].defaultParam;
      const [cat] = runSituations(prepared, base, tasks, [spec(kind, param)]);
      const c = runCustomSituation(prepared, base, tasks, custom({ situations: [{ kind, param }] }));
      expect({ kind, t: c.tasksMin, d: c.departMin, m: c.marginMin, route: c.route, o: c.outcome }).toEqual({
        kind,
        t: cat.tasksMin,
        d: cat.departMin,
        m: cat.marginMin,
        route: cat.route,
        o: cat.outcome,
      });
      expect(cat.custom).toBeUndefined();
      // Custom rows consider more actions, so they never do worse than the catalog's best.
      expect(c.nextAction?.gainMin ?? 0).toBeGreaterThanOrEqual(cat.nextAction?.gainMin ?? 0);
    }
  });

  it('all seven kinds at once, on the same fire (no new simulation)', () => {
    vi.mocked(simulateFire).mockClear();
    const { prepared, base, tasks } = setup();
    const all: CustomParts['situations'] = (['night', 'late_order', 'adult_away', 'no_car', 'slow_traffic', 'road_blocked', 'pet_hides'] as SituationKind[]).map(
      (kind) => ({ kind, param: SITUATIONS[kind].defaultParam }),
    );
    const [r] = runCustomSituations(prepared, base, tasks, [custom({ situations: all })]);
    expect(simulateFire).not.toHaveBeenCalled();
    // gather 6, pets (6+10)*1.5 = 24, meds 4, docs 3, load 6, ride 10 = 53; + wake 3; + order 10.
    expect(r.tasksMin).toBe(56);
    expect(r.departMin).toBe(66);
    expect(r.route).toBe('backup');
    // North Rd closing at 40 can only come from base.closures (the empty fire gives no closures).
    expect(r.run!.binding!.closeMin).toBe(40);
    expect(r.run!.arriveMin).toBeCloseTo(66 + 6 * 1.5, 9);
    expect(r.outcome).toBe('short');
    // pets 24 -> 3 (a third of the 6 before it hid = 2, then still 1.5 times longer with one adult away)
    // gains 21, more than leaving on a warning (10).
    expect(r.nextAction).toMatchObject({ id: 'pets_inside', tag: 'est', gainMin: 21 });
  });

  it('pets_inside keeps the one-adult-away slowdown when both are in one row', () => {
    const tasks: Task[] = [
      { id: 'gather', label: 'Gather everyone', minutes: 4, source: 'estimate' },
      { id: 'pets', label: 'Find pet carriers and pets', minutes: 9, source: 'estimate' },
    ];
    const big = new Map([[0, Infinity], [1, 100], [2, 110], [3, 100]]) as EdgeClosures;
    const { prepared, base } = setup({ tasks, closures: big });
    const r = runCustomSituation(prepared, base, tasks, custom({ situations: [{ kind: 'pet_hides', param: 10 }, { kind: 'adult_away', param: 2 }] }));
    // gather 4*2 = 8, pets (9+10)*2 = 38.
    expect(r.tasksMin).toBe(46);
    // pets 9 -> 3 before the slowdown, then 3*2 = 6: 38 -> 6 gains 32 (not 35, which would drop the slowdown).
    expect(r.nextAction).toMatchObject({ id: 'pets_inside', gainMin: 32 });
  });

  it('empty parts run this drill unchanged', () => {
    const r = runC({});
    expect(r.tasksMin).toBe(21);
    expect(r.marginMin).toBe(4);
    expect(r.deltaMin).toBe(0);
    expect(r.info.assumption(0)).toBe('Nothing changes from this drill.');
    expect(r.nextAction).toMatchObject({ id: 'switch_backup', gainMin: 9 });
  });

  it('sanitizes the parts it runs with and falls back to a plain title', () => {
    const { prepared, base, tasks } = setup();
    const c: CustomSituation = { id: 'x', text: 't', title: '  ', titleSource: 'user', parts: parts({ situations: [{ kind: 'late_order', param: 99 }], taskMinutes: { nope: 3 } }) };
    const r = runCustomSituation(prepared, base, tasks, c);
    expect(r.custom!.parts).toEqual({ situations: [{ kind: 'late_order', param: 30 }], addTasks: [], taskMinutes: {} });
    expect(r.departMin).toBe(51);
    expect(r.info.title).toBe('Your situation');
    expect(r.info).toMatchObject({ paramUnit: 'min', paramLabel: '', defaultParam: 0, minParam: 0, maxParam: 0 });
  });

  it('passCount counts custom rows when passed in', () => {
    const { prepared, base, tasks } = setup();
    const cat = runSituations(prepared, base, tasks, [spec('night'), spec('late_order')]);
    const mine = runCustomSituations(prepared, base, tasks, [custom({ taskMinutes: { load: 1 } }), custom({ situations: [{ kind: 'late_order', param: 30 }] })]);
    expect(mine.map((r) => r.outcome)).toEqual(['in_time', 'short']);
    expect(passCount(cat, mine)).toEqual({ pass: 2, total: 4 });
    expect(passCount(cat)).toEqual({ pass: 1, total: 2 });
  });
});

describe('rebaseCustomParts (Fix screen)', () => {
  const help: Task[] = [
    { id: 'gather', label: 'Gather everyone', minutes: 4, source: 'estimate' },
    { id: 'help', label: 'Help someone who needs it', minutes: 6, source: 'estimate' },
  ];
  it('a Fix to the same task reaches a typed task change, by the same ratio', () => {
    const fixed = help.map((t) => (t.id === 'help' ? { ...t, minutes: 2 } : t));
    const p = parts({ taskMinutes: { help: 10 } });
    // 10 * 2/6 = 3.3 -> 3: the same "a third" the row's next action measured.
    expect(rebaseCustomParts(p, help, fixed).taskMinutes).toEqual({ help: 3 });
    const { prepared, base } = setup({ tasks: help });
    const before = runCustomSituation(prepared, base, help, custom({ taskMinutes: { help: 10 } }));
    const after = runCustomSituation(prepared, base, fixed, custom(rebaseCustomParts(p, help, fixed)));
    expect(before.tasks.find((t) => t.id === 'help')!.minutes).toBe(10);
    expect(after.tasks.find((t) => t.id === 'help')!.minutes).toBe(3);
    expect(after.tasksMin).toBe(before.tasksMin - 7);
  });
  it('keeps the parts when nothing changed, a removed task stays removed', () => {
    const p = parts({ taskMinutes: { help: 0, gather: 8 } });
    expect(rebaseCustomParts(p, help, help)).toBe(p);
    const fixed = help.map((t) => ({ ...t, minutes: 1 }));
    expect(rebaseCustomParts(p, help, fixed).taskMinutes).toEqual({ help: 0, gather: 2 });
  });
});

describe('sanitizeCustomParts', () => {
  it('takes numbers out of added task labels (only the engine shows numbers)', () => {
    const p = sanitizeCustomParts({ addTasks: [{ label: 'Drive 20 miles to the barn', minutes: 15 }, { label: '30', minutes: 5 }] }, TASKS);
    expect(p.addTasks).toEqual([{ label: 'Drive to the barn', minutes: 15 }]);
  });

  it('whitelists kinds, dedupes (first wins) and clamps params', () => {
    const p = sanitizeCustomParts(
      {
        situations: [
          { kind: 'fly', param: 3 },
          { kind: '__proto__', param: 3 },
          { kind: 'constructor', param: 3 },
          { kind: 'late_order', param: 99 },
          { kind: 'late_order', param: 7 },
          { kind: 'road_blocked', param: 5 },
          { kind: 'adult_away', param: 'lots' },
          { kind: 'slow_traffic', param: 1.57 },
          'night',
          null,
        ],
        extra: 'dropped',
      },
      TASKS,
    );
    expect(p.situations).toEqual([
      { kind: 'late_order', param: 30 },
      { kind: 'road_blocked', param: 0 },
      { kind: 'adult_away', param: 1.5 },
      { kind: 'slow_traffic', param: 1.6 },
    ]);
    expect(p).not.toHaveProperty('extra');
  });

  it('caps added tasks at 3, rounds and clamps minutes to 1..60, trims labels to 60 characters', () => {
    const long = 'x'.repeat(80);
    const p = sanitizeCustomParts(
      {
        addTasks: [
          { label: '   ', minutes: 5 },
          { label: 'No minutes', minutes: '5' },
          { label: '  Hitch   the trailer ', minutes: 2.6 },
          { label: long, minutes: 99 },
          { label: 'Zero', minutes: 0 },
          { label: 'Fourth', minutes: 5 },
        ],
      },
      TASKS,
    );
    expect(p.addTasks).toEqual([
      { label: 'Hitch the trailer', minutes: 3 },
      { label: 'x'.repeat(60), minutes: 60 },
      { label: 'Zero', minutes: 1 },
    ]);
  });

  it('keeps only known task ids, clamps minutes to 0..60 and drops no-op changes', () => {
    const p = sanitizeCustomParts({ taskMinutes: { nope: 3, meds: -5, load: 99, docs: 3, gather: 'x', pets: 2.4 } }, TASKS);
    expect(p.taskMinutes).toEqual({ meds: 0, load: 60, pets: 2 });
  });

  it('returns empty parts for junk', () => {
    for (const raw of [null, undefined, 'text', 3, [], { situations: 'x', addTasks: {}, taskMinutes: [] }]) {
      const p = sanitizeCustomParts(raw, TASKS);
      expect(p).toEqual({ situations: [], addTasks: [], taskMinutes: {} });
      expect(emptyParts(p)).toBe(true);
    }
    expect(emptyParts(parts({ taskMinutes: { meds: 0 } }))).toBe(false);
    expect(emptyParts(parts({ addTasks: [{ label: 'a', minutes: 1 }] }))).toBe(false);
    expect(emptyParts(parts({ situations: [{ kind: 'road_blocked', param: 0 }] }))).toBe(false);
  });
});
