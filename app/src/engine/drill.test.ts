import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph';
import { makeFireGrid } from './fire';
import {
  compareRuns,
  defaultTasks,
  edgeClosures,
  edgeClosuresWithPoints,
  edgesLeavingGrid,
  NIGHT_WAKE_MIN,
  planWaysOut,
  runDrill,
  runRoute,
  tasksMinutes,
} from './drill';
import { routeFromEdges } from './routing';
import type { DrillResult, FireResult, Projection, RawRoadWay, Task, WaysOut } from './types';

// Identity projection: lat = y, lon = x, in meters.
const flat: Projection = {
  origin: { lat: 0, lon: 0 },
  toXY: (p) => ({ x: p.lon, y: p.lat }),
  toLatLon: (p) => ({ lat: p.y, lon: p.x }),
};

function way(id: number, name: string, highway: string, pts: [number, number, number][]): RawRoadWay {
  return {
    id,
    name,
    highway,
    nodeIds: pts.map(([osm]) => osm),
    coords: pts.map(([, x, y]) => ({ lat: y, lon: x })),
  };
}

describe('defaultTasks', () => {
  it('builds the standard list and omits empty tasks', () => {
    const t = defaultTasks({ adults: 2, children: 1, needHelpMoving: 0, dogs: 0, catsAndSmallPets: 0, cars: 1 });
    expect(t.map((x) => x.id)).toEqual(['gather', 'meds', 'docs', 'load']);
    expect(t.map((x) => x.minutes)).toEqual([4, 4, 3, 4]);
    expect(t.every((x) => x.source === 'estimate')).toBe(true);
  });

  it('adds help, pets and ride when they apply', () => {
    const t = defaultTasks({ adults: 1, children: 0, needHelpMoving: 2, dogs: 1, catsAndSmallPets: 2, cars: 0 });
    const byId = Object.fromEntries(t.map((x) => [x.id, x]));
    expect(byId.help.minutes).toBe(12);
    expect(byId.help.label).toBe('Help a person to the car');
    expect(byId.pets.minutes).toBe(3 + 8);
    expect(byId.ride.minutes).toBe(10);
    expect(byId.gather.minutes).toBe(3);
    expect(byId.load.minutes).toBe(3);
  });

  it('tasksMinutes adds the night wake-up', () => {
    const t = defaultTasks({ adults: 2, children: 0, needHelpMoving: 0, dogs: 0, catsAndSmallPets: 0, cars: 1 });
    expect(tasksMinutes(t, 'night') - tasksMinutes(t, 'day')).toBe(NIGHT_WAKE_MIN);
    expect(tasksMinutes([], 'day')).toBe(0);
  });
});

describe('planWaysOut', () => {
  it('uses exit points on main roads when there are no places', () => {
    // Home on a short street joining a primary road that runs 5 km north and 5 km south.
    const g = buildGraph(
      [
        way(1, 'Home St', 'residential', [[1, 0, 0], [2, 300, 0]]),
        way(2, 'Highway 9', 'primary', [[3, 300, 5000], [2, 300, 0], [4, 300, -5000]]),
      ],
      flat,
    );
    const w = planWaysOut(g, { x: 0, y: 0 }, [], flat);
    expect(w.destinations.length).toBe(2);
    expect(w.destinations.every((d) => d.kind === 'exit_point')).toBe(true);
    expect(w.destinations.map((d) => d.label)).toEqual(['D1 Exit point', 'D2 Exit point']);
    expect(w.main).not.toBeNull();
    expect(w.backup).not.toBeNull();
    expect(w.main!.destinationId).not.toBe(w.backup!.destinationId);
    expect(w.sharedRoadNames).toEqual(['Home St']);
    expect(w.sharedFromDoorM).toBeCloseTo(300, 6);
  });

  it('returns an empty plan when there are no roads', () => {
    const w = planWaysOut(buildGraph([], flat), { x: 0, y: 0 }, [], flat);
    expect(w).toEqual({ homeNodeId: -1, destinations: [], main: null, backup: null, sharedFromDoorM: 0, sharedRoadNames: [] });
  });

  it('backup avoids the main route when another road exists', () => {
    // Two parallel roads from home to two destinations in different directions.
    const g = buildGraph(
      [
        way(1, 'East Rd', 'secondary', [[1, 0, 0], [2, 3000, 0]]),
        way(2, 'North Rd', 'tertiary', [[1, 0, 0], [3, 0, 3000]]),
      ],
      flat,
    );
    const places = [
      { id: 'a', name: 'East School', kind: 'school' as const, at: { lat: 0, lon: 3000 } },
      { id: 'b', name: 'North Library', kind: 'library' as const, at: { lat: 3000, lon: 0 } },
    ];
    const w = planWaysOut(g, { x: 0, y: 0 }, places, flat);
    expect(w.main!.destinationId).toBe('a');
    expect(w.backup!.destinationId).toBe('b');
    expect(w.backup!.roadNames).toEqual(['North Rd']);
    expect(w.sharedFromDoorM).toBe(0);
    expect(w.sharedRoadNames).toEqual([]);
  });
});

describe('planWaysOut regressions', () => {
  it('does not use a backup that snaps to the main destination node', () => {
    // Home at a junction: A St east 2.5 km, B St (tertiary) north 5 km.
    const g = buildGraph(
      [
        way(1, 'A St', 'residential', [[1, 0, 0], [2, 2500, 0]]),
        way(2, 'B St', 'tertiary', [[1, 0, 0], [3, 0, 5000]]),
      ],
      flat,
    );
    const places = [
      { id: 'p1', name: 'School', kind: 'school' as const, at: { lat: 50, lon: 2500 } },
      { id: 'p2', name: 'Library', kind: 'library' as const, at: { lat: -80, lon: 2500 } },
    ];
    const w = planWaysOut(g, { x: 0, y: 0 }, places, flat);
    expect(w.main!.roadNames).toEqual(['A St']);
    expect(w.backup!.roadNames).toEqual(['B St']);
    expect(w.backup!.destinationId).toMatch(/^exit-/);
    expect(w.sharedFromDoorM).toBe(0);
  });

  it('leaves no backup rather than repeating the main route', () => {
    const g = buildGraph([way(1, 'A St', 'residential', [[1, 0, 0], [2, 2500, 0]])], flat);
    const places = [
      { id: 'p1', name: 'School', kind: 'school' as const, at: { lat: 50, lon: 2500 } },
      { id: 'p2', name: 'Library', kind: 'library' as const, at: { lat: -80, lon: 2500 } },
    ];
    const w = planWaysOut(g, { x: 0, y: 0 }, places, flat);
    expect(w.main).not.toBeNull();
    expect(w.backup).toBeNull();
    expect(w.sharedFromDoorM).toBe(0);
  });

  it('ignores places closer than 2 km', () => {
    const g = buildGraph(
      [
        way(1, 'East Rd', 'residential', [[1, 0, 0], [2, 1700, 0], [3, 3000, 0]]),
        way(2, 'North Rd', 'residential', [[1, 0, 0], [4, 0, 3000]]),
      ],
      flat,
    );
    const places = [
      { id: 'near', name: 'Near School', kind: 'school' as const, at: { lat: 0, lon: 1700 } },
      { id: 'far', name: 'Far School', kind: 'school' as const, at: { lat: 0, lon: 3000 } },
      { id: 'north', name: 'North Hall', kind: 'townhall' as const, at: { lat: 3000, lon: 0 } },
    ];
    const w = planWaysOut(g, { x: 0, y: 0 }, places, flat);
    expect(w.destinations.map((d) => d.id)).not.toContain('near');
    expect(w.main!.destinationId).toBe('far');
  });
});

describe('runDrill closure point and coverage', () => {
  const grid = makeFireGrid(100, 60);
  const tasks: Task[] = [{ id: 't', label: 'Pack', minutes: 10, source: 'estimate' }];

  function prepared(roads: RawRoadWay[], edgeIds: number[]) {
    const graph = buildGraph(roads, flat);
    const main = routeFromEdges(graph, edgeIds, 'd');
    const waysOut: WaysOut = { homeNodeId: 0, destinations: [], main, backup: null, sharedFromDoorM: 0, sharedRoadNames: [] };
    return { graph, fireGrid: grid, elevationPerCell: null, waysOut };
  }

  it('puts the binding where the fire closes a long road, and the 0.5 mi moment comes first', () => {
    const p = prepared([way(1, 'Ridge Rd', 'residential', [[1, 0, 0], [2, 2800, 0]])], [0]);
    const r = runDrill(p, tasks, {
      ignition: { x: 2700, y: 600 },
      wind: { fromDeg: 0, speedMph: 10, source: 'manual' },
      start: 'day',
      seed: 1,
    });
    const b = r.main!.binding!;
    expect(b.xy.y).toBeCloseTo(0, 6);
    expect(b.xy.x).toBeGreaterThan(2000);
    const near = r.keyMoments.find((m) => m.label.startsWith('Fire within'))!;
    const closes = r.keyMoments.find((m) => m.label === 'Ridge Rd closes')!;
    expect(near.min).toBeLessThanOrEqual(closes.min);
    expect(r.keyMoments.indexOf(near)).toBeLessThan(r.keyMoments.indexOf(closes));
    expect(r.coverage.ignitionInGrid).toBe(true);
    expect(r.coverage.mainUnmodeledEdgeIds).toEqual([]);
  });

  it('flags an off-grid ignition and route legs outside the grid', () => {
    // A spur at x = 2000 makes it a junction, so Long Rd splits into an inside and an outside edge.
    const roads = [
      way(1, 'Long Rd', 'residential', [[1, 0, 0], [2, 2000, 0], [3, 5000, 0]]),
      way(2, 'Spur', 'residential', [[2, 2000, 0], [4, 2000, 500]]),
    ];
    const g = buildGraph(roads, flat);
    const fwd = (x0: number) => g.edges.find((e) => e.shape[0].x === x0 && e.shape[0].y === 0 && e.shape[e.shape.length - 1].x > x0)!.id;
    const inside = fwd(0);
    const outside = fwd(2000);
    const p = prepared(roads, [inside, outside]);
    const r = runDrill(p, tasks, {
      ignition: { x: 3500, y: 0 },
      wind: { fromDeg: 270, speedMph: 10, source: 'manual' },
      start: 'day',
      seed: 1,
    });
    expect(r.coverage.ignitionInGrid).toBe(false);
    expect(r.main!.outcome).toBe('never_closed');
    expect(r.coverage.mainUnmodeledEdgeIds).toEqual([outside]);
    expect(edgesLeavingGrid(p.graph, grid).has(inside)).toBe(false);
  });
});

describe('edgeClosures and runRoute', () => {
  // A 1 km road east along y = 0, inside a 6 km grid.
  const g = buildGraph([way(1, 'Main St', 'residential', [[1, 0, 0], [2, 1000, 0]])], flat);
  const grid = makeFireGrid(100, 60);

  function fireWith(cells: [number, number, number][]): FireResult {
    const ignitionMin = new Float32Array(60 * 60).fill(-1);
    for (const [col, row, min] of cells) ignitionMin[row * 60 + col] = min;
    return { grid, ignitionMin, burnMinutes: 30, horizonMin: 180 };
  }

  it('closes an edge at the first ignition within the buffer', () => {
    // Cell (35, 31) has center (550, 150): 150 m from the road, within 100 + 50.
    // Cell (35, 32) has center (550, 250): too far.
    const c = edgeClosures(g, fireWith([[35, 31, 40], [35, 32, 10]]));
    expect(c.get(0)).toBe(40);
    expect(c.get(1)).toBe(40);
    const none = edgeClosures(g, fireWith([[35, 32, 10]]));
    expect(none.get(0)).toBe(Infinity);
    // Cached cell lists still give fresh results for a new fire.
    expect(edgeClosures(g, fireWith([[30, 30, 5]])).get(0)).toBe(5);
  });

  it('records where each edge closes and runRoute uses it for the binding', () => {
    // Cell (37, 31) center (750, 150) ignites first; nearest road point is (750, 0).
    const { closures, points } = edgeClosuresWithPoints(g, fireWith([[37, 31, 12], [32, 30, 40]]));
    expect(closures.get(0)).toBe(12);
    expect(points.get(0)).toEqual({ x: 750, y: 0 });
    const run = runRoute(g, routeFromEdges(g, [0], 'd'), 0, closures, 180, points);
    expect(run.binding!.xy).toEqual({ x: 750, y: 0 });
    expect(edgeClosuresWithPoints(g, fireWith([])).points.size).toBe(0);
  });

  it('computes legs, binding and outcome', () => {
    const route = routeFromEdges(g, [0], 'd');
    const closures = new Map([[0, 20]]);
    const ok = runRoute(g, route, 10, closures, 180);
    expect(ok.outcome).toBe('in_time');
    expect(ok.legs[0].exitMin).toBeCloseTo(10 + g.edges[0].minutes, 9);
    expect(ok.binding!.xy.x).toBeCloseTo(500, 6);
    expect(ok.binding!.marginMin).toBeCloseTo(20 - ok.legs[0].exitMin, 9);
    expect(ok.arriveMin).toBeCloseTo(10 + route.driveMin, 9);

    expect(runRoute(g, route, 19, closures, 180).outcome).toBe('short');
    const open = runRoute(g, route, 10, new Map([[0, Infinity]]), 180);
    expect(open.outcome).toBe('never_closed');
    expect(open.binding).toBeNull();
    expect(open.legs[0].closeMin).toBe(Infinity);
  });
});

describe('compareRuns', () => {
  const base = {
    setup: { ignition: { x: 1, y: 2 }, wind: { fromDeg: 90, speedMph: 10, source: 'manual' }, start: 'day', seed: 1 },
    tasksMin: 30,
    main: null,
  } as unknown as DrillResult;

  it('detects a different fire and reports null margins without a binding', () => {
    const after = { ...base, tasksMin: 20, setup: { ...base.setup, start: 'night' } } as DrillResult;
    expect(compareRuns(base, after)).toEqual({ sameFire: false, savedMin: 10, beforeMargin: null, afterMargin: null });
    expect(compareRuns(base, base).sameFire).toBe(true);
  });
});
