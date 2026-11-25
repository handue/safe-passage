import { describe, expect, it } from 'vitest';
import { makeProjection } from './geo';
import { prepareArea } from './area';
import { compareRuns, defaultTasks, runDrill } from './drill';
import type { AreaData, DrillSetup, RawRoadWay, Task, XY } from './types';

// Synthetic area around a home at (0, 0):
//   Ridge Rd (tertiary) west to a library at (-3500, 400)
//   Willow Dr (residential) north from home to a junction J at (0, 400)
//   Creek Rd (secondary) east from J to a school at (3000, 400)
const home = { lat: 37.17, lon: -122.12 };
const proj = makeProjection(home);

function way(id: number, name: string, highway: string, pts: [number, XY][]): RawRoadWay {
  return {
    id,
    name,
    highway,
    nodeIds: pts.map(([osm]) => osm),
    coords: pts.map(([, xy]) => proj.toLatLon(xy)),
  };
}

function syntheticArea(): AreaData {
  return {
    home,
    addressLabel: 'Test home',
    country: 'us',
    roads: [
      way(1, 'Willow Dr', 'residential', [[1, { x: 0, y: 0 }], [2, { x: 0, y: 200 }], [3, { x: 0, y: 400 }]]),
      way(2, 'Creek Rd', 'secondary', [[3, { x: 0, y: 400 }], [10, { x: 1500, y: 400 }], [11, { x: 3000, y: 400 }]]),
      way(3, 'Ridge Rd', 'tertiary', [[3, { x: 0, y: 400 }], [20, { x: -1800, y: 400 }], [21, { x: -3500, y: 400 }]]),
    ],
    places: [
      { id: 'p-school', name: 'Lincoln Elementary School', kind: 'school', at: proj.toLatLon({ x: 3000, y: 450 }) },
      { id: 'p-lib', name: 'Ridge Library', kind: 'library', at: proj.toLatLon({ x: -3500, y: 420 }) },
      { id: 'p-near', name: 'Too Close Hall', kind: 'townhall', at: proj.toLatLon({ x: 300, y: 400 }) },
    ],
    elevation: null,
    wind: null,
    fetchedAt: {},
    fallbacksUsed: [],
  };
}

const task = (minutes: number): Task[] => [{ id: 'x', label: 'Pack', minutes, source: 'estimate' }];

// Fire south-east of home with wind from the south: it runs north onto Creek Rd.
const upwindFire: DrillSetup = {
  ignition: { x: 1500, y: -1800 },
  wind: { fromDeg: 180, speedMph: 20, source: 'manual' },
  start: 'day',
  seed: 42,
};

describe('prepareArea + runDrill end to end', () => {
  const prepared = prepareArea(syntheticArea());

  it('plans a main route east and a backup west sharing Willow Dr', () => {
    const w = prepared.waysOut;
    expect(w.main?.destinationId).toBe('p-school');
    expect(w.backup?.destinationId).toBe('p-lib');
    expect(w.main?.roadNames).toEqual(['Willow Dr', 'Creek Rd']);
    expect(w.backup?.roadNames).toEqual(['Willow Dr', 'Ridge Rd']);
    expect(w.sharedFromDoorM).toBeCloseTo(400, 0);
    expect(w.sharedRoadNames).toEqual(['Willow Dr']);
    expect(w.destinations.map((d) => d.label)).toEqual(['D1 School', 'D2 Ridge Library']);
    expect(prepared.elevationPerCell).toBeNull();
  });

  it('the same fire closes the main route: a long prep is short, a quick prep is in time', () => {
    const slow = runDrill(prepared, task(120), upwindFire);
    const fast = runDrill(prepared, task(5), upwindFire);
    expect(slow.main?.outcome).toBe('short');
    expect(slow.main?.binding?.name).toBe('Creek Rd');
    expect(fast.main?.outcome).toBe('in_time');

    expect(slow.bottlenecks.map((b) => b.kind)).toEqual(['road_closed', 'one_way_out', 'longest_task']);
    expect(slow.bottlenecks[0].detail).toMatch(/^Creek Rd at T\+\d+$/);
    expect(slow.bottlenecks[1].detail).toBe('Willow Dr, first 0.2 mi');
    expect(fast.bottlenecks.map((b) => b.kind)).toEqual(['one_way_out', 'longest_task']);

    const mins = slow.keyMoments.map((m) => m.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    expect(slow.keyMoments.map((m) => m.label)).toContain('Creek Rd closes');
    expect(slow.keyMoments.find((m) => m.label === 'Your car leaves home')?.min).toBe(120);

    const cmp = compareRuns(slow, fast);
    expect(cmp.sameFire).toBe(true);
    expect(cmp.savedMin).toBe(115);
    expect(cmp.beforeMargin!).toBeLessThan(0);
    expect(cmp.afterMargin!).toBeGreaterThanOrEqual(0);
  });

  it('a fire blowing away from all roads never closes the route', () => {
    const r = runDrill(prepared, task(30), {
      ignition: { x: 0, y: -2800 },
      wind: { fromDeg: 0, speedMph: 20, source: 'manual' },
      start: 'night',
      seed: 7,
    });
    expect(r.main?.outcome).toBe('never_closed');
    expect(r.backup?.outcome).toBe('never_closed');
    expect(r.main?.binding).toBeNull();
    expect(r.tasksMin).toBe(33);
    expect(r.keyMoments).toEqual([
      { label: 'Order to leave', min: 0 },
      { label: 'Your car leaves home', min: 33 },
    ]);
  });

  it('is deterministic for the same inputs', () => {
    const a = runDrill(prepareArea(syntheticArea()), task(20), upwindFire);
    const b = runDrill(prepareArea(syntheticArea()), task(20), upwindFire);
    expect(Array.from(a.fire.ignitionMin)).toEqual(Array.from(b.fire.ignitionMin));
    expect([...a.closures]).toEqual([...b.closures]);
    expect(a.main).toEqual(b.main);
    expect(a.keyMoments).toEqual(b.keyMoments);
    expect(compareRuns(a, { ...b, setup: { ...b.setup, seed: 43 } }).sameFire).toBe(false);
  });

  it('default tasks work as drill input', () => {
    const tasks = defaultTasks({ adults: 2, children: 1, needHelpMoving: 0, dogs: 1, catsAndSmallPets: 0, cars: 1 });
    const r = runDrill(prepared, tasks, upwindFire);
    expect(r.tasksMin).toBe(4 + 3 + 4 + 3 + 4);
    expect(r.main).not.toBeNull();
  });
});
