import { describe, expect, it } from 'vitest';
import { makeProjection } from '../engine/geo';
import { prepareArea } from '../engine/area';
import type { AreaData, RawRoadWay, XY } from '../engine/types';
import {
  destMarks,
  fmtDistance,
  inFrame,
  layoutMap,
  makeView,
  mapName,
  abbreviateRoad,
  closureMarkerAt,
  overlaps,
  seaLayer,
  shortClosure,
  shortName,
  type Box,
  type LayoutInput,
  type MapLayout,
} from './MapView';

// Same synthetic area as the engine tests: home at (0, 0), a school 3 km east,
// a library 3.5 km west (outside the 6 km fire square).
const home = { lat: 37.17, lon: -122.12 };
const proj = makeProjection(home);

function way(id: number, name: string, highway: string, pts: [number, XY][]): RawRoadWay {
  return { id, name, highway, nodeIds: pts.map(([osm]) => osm), coords: pts.map(([, xy]) => proj.toLatLon(xy)) };
}

function area(elevation: AreaData['elevation'] = null): AreaData {
  return {
    home,
    addressLabel: 'Test home',
    country: 'us',
    roads: [
      way(1, 'Willow Dr', 'residential', [[1, { x: 0, y: 0 }], [2, { x: 0, y: 200 }], [3, { x: 0, y: 400 }]]),
      way(2, 'Creek Rd', 'secondary', [[3, { x: 0, y: 400 }], [10, { x: 1500, y: 400 }], [11, { x: 3000, y: 400 }]]),
      way(3, 'Ridge Rd', 'tertiary', [[3, { x: 0, y: 400 }], [20, { x: -1800, y: 400 }], [21, { x: -6500, y: 400 }]]),
    ],
    places: [
      { id: 'p-school', name: 'Lincoln Elementary School', kind: 'school', at: proj.toLatLon({ x: 3000, y: 450 }) },
      { id: 'p-lib', name: 'Ridge Library', kind: 'library', at: proj.toLatLon({ x: -6500, y: 420 }) },
    ],
    elevation,
    wind: null,
    fetchedAt: {},
    fallbacksUsed: [],
  };
}

/** Elevation that is sea (0 m) south of y = -1500 and rising land north of it. */
function coastalElevation(): NonNullable<AreaData['elevation']> {
  const rows = 41;
  const cols = 41;
  const spacing = 200;
  const originXY = { x: -4000, y: -4000 };
  const values: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const y = originXY.y + r * spacing;
      values.push(y < -1500 ? 0 : 5 + (y + 1500) * 0.05);
    }
  }
  return { rows, cols, originXY, spacing, values };
}

const U = 1000 / 640; // SVG units per CSS pixel on a 640 px map

function baseInput(overrides: Partial<LayoutInput> = {}): LayoutInput {
  const prepared = prepareArea(area());
  const view = makeView(prepared, 1);
  return {
    view,
    u: U,
    units: 'mi',
    home: { x: 500, y: 500 },
    dests: [],
    closure: null,
    ignition: null,
    wind: undefined,
    caption: null,
    notes: [],
    cornerNotes: [],
    grid: { x: 54, y: 54, w: 892 },
    sea: [],
    routeLabels: [],
    roadNames: [],
    fireCentroid: null,
    ...overrides,
  };
}

/** Every label box is inside the frame and overlaps no marker and no other label. */
function expectNoOverlap(layout: MapLayout) {
  const labels: Box[] = layout.labels.map((l) => l.box);
  if (layout.wind?.text) labels.push(layout.wind.text.box);
  if (layout.caption) labels.push(layout.caption.box);
  for (let i = 0; i < labels.length; i++) {
    for (const m of layout.markers) expect(overlaps(labels[i], m)).toBe(false);
    for (let j = i + 1; j < labels.length; j++) expect(overlaps(labels[i], labels[j])).toBe(false);
  }
}

describe('map helpers', () => {
  it('formats distances in miles or kilometers', () => {
    expect(fmtDistance(10139, 'mi')).toBe('6.3 mi');
    expect(fmtDistance(9500, 'km')).toBe('9.5 km');
    expect(fmtDistance(25000, 'km')).toBe('25 km');
  });

  it('shortens long names at a word boundary and names exit points by their road', () => {
    expect(shortName('Blue Mountains Cultural Centre and Gallery', 16)).toBe('Blue Mountains…');
    expect(shortName('Ridge Library', 16)).toBe('Ridge Library');
    const exit = { id: 'e', label: 'D1 Exit point', name: 'where Pacific Coast Highway leaves the area', kind: 'exit_point' as const, xy: { x: 0, y: 0 }, nodeId: 0 };
    expect(mapName(exit)).toBe('Pacific Coast Hwy exit');
    expect(abbreviateRoad('Las Virgenes Road')).toBe('Las Virgenes Rd');
  });

  it('shortens a closure label to its time', () => {
    expect(shortClosure('Pacific Coast Highway closes T+36')).toBe('Closes T+36');
    expect(shortClosure('Pacific Coast Highway closed T+22')).toBe('Closed T+22');
  });
});

describe('destination markers', () => {
  const prepared = prepareArea(area());

  it('draws an in-frame destination on its real point', () => {
    const view = makeView(prepared, 1);
    const marks = destMarks(prepared, view, U, [{ which: 'main', style: 'main' }, { which: 'backup', style: 'backup' }]);
    const school = marks.find((m) => m.name.startsWith('Lincoln'));
    expect(school?.onMap).toBe(true);
  });

  it('puts an off-map destination on the frame edge where the route leaves, with an arrow outward', () => {
    const view = makeView(prepared, 1);
    const marks = destMarks(prepared, view, U, [{ which: 'main', style: 'main' }, { which: 'backup', style: 'backup' }]);
    const lib = marks.find((m) => m.name === 'Ridge Library');
    expect(lib).toBeDefined();
    expect(lib!.onMap).toBe(false);
    // Left frame edge is x = 0 in SVG units; the marker sits just inside it.
    expect(lib!.x).toBeGreaterThan(0);
    expect(lib!.x).toBeLessThan(40 * U);
    expect(lib!.dir!.x).toBeLessThan(-0.9);
    // Route length, not straight line: the library is 6.5 km west plus the 400 m north.
    expect(lib!.awayM).toBeGreaterThan(6500);
  });

  it('uses the whole wide frame: a point beyond the square but inside the frame is on the map', () => {
    const view = makeView(prepared, 3);
    expect(inFrame(view, { x: -4500, y: 0 })).toBe(true);
    const marks = destMarks(prepared, view, U, [{ which: 'backup', style: 'backup' }]);
    expect(marks[0].onMap).toBe(true);
  });
});

describe('label layout', () => {
  it('labels an off-map destination with its distance and never says "off map"', () => {
    const prepared = prepareArea(area());
    const view = makeView(prepared, 1);
    const dests = destMarks(prepared, view, U, [{ which: 'main', style: 'main' }, { which: 'backup', style: 'backup' }]);
    const layout = layoutMap(baseInput({ view, dests, wind: { fromDeg: 180, speedMph: 9, source: 'manual' } }));
    const texts = layout.labels.map((l) => l.text);
    expect(texts.some((t) => /Ridge Library, 4\.\d mi away/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes('Lincoln Elementary School (candidate)'))).toBe(true);
    expect(texts.join(' ')).not.toContain('off map');
    expectNoOverlap(layout);
  });

  it('keeps a destination label next to its own marker', () => {
    const dests = [{ id: 'd', code: 'D1', name: 'Leura Public School', onMap: true, x: 560, y: 495, dir: null, awayM: 900 }];
    const layout = layoutMap(baseInput({ dests }));
    const label = layout.labels.find((l) => l.text.startsWith('Leura'))!;
    const cx = (label.box.x0 + label.box.x1) / 2;
    const cy = (label.box.y0 + label.box.y1) / 2;
    // Nearer to D1 than to Home.
    expect(Math.hypot(cx - 560, cy - 495)).toBeLessThan(Math.hypot(cx - 500, cy - 500));
    expectNoOverlap(layout);
  });

  it('moves labels clear of a crowded home: closure ring on home, a destination and notes beside it', () => {
    const layout = layoutMap(
      baseInput({
        closure: { x: 520, y: 505, label: 'Pacific Coast Highway closes T+22' },
        dests: [{ id: 'd', code: 'D1', name: 'Pacific Coast Highway exit', onMap: false, x: 600, y: 500, dir: { x: 1, y: 0 }, awayM: 9500 }],
        notes: [{ x: 520, y: 505, text: 'Before: T+33, after it closed', cls: 't-closed' }],
        wind: { fromDeg: 135, speedMph: 9, source: 'manual' },
        cornerNotes: ['Fire not modeled outside the dashed square'],
        caption: 'Fire shown at T+28',
        fireCentroid: { x: 530, y: 470 },
        roadNames: [{ text: 'Pacific Coast Highway', pts: [{ x: 300, y: 520 }, { x: 700, y: 520 }] }],
      }),
    );
    expect(layout.labels.some((l) => l.text === 'Home')).toBe(true);
    expect(layout.caption?.text).toBe('Fire shown at T+28');
    expectNoOverlap(layout);
  });

  it('moves the wind block away from a destination in the top-right corner', () => {
    const fx1 = 1000;
    const layout = layoutMap(
      baseInput({
        wind: { fromDeg: 135, speedMph: 9, source: 'manual' },
        dests: [{ id: 'd', code: 'D1', name: 'Hall', onMap: true, x: fx1 - 50 * U, y: 80 * U, dir: null, awayM: 3000 }],
      }),
    );
    expect(layout.wind?.text?.text).toBe('Wind from southeast 9 mph');
    expect(layout.wind!.ax).toBeLessThan(500);
    expectNoOverlap(layout);
  });

  it('shortens or drops the ignition label instead of drawing it over a road name', () => {
    const layout = layoutMap(
      baseInput({
        ignition: { points: [], selected: { x: 300, y: 300, text: 'Your ignition point', suggestion: false } },
        roadNames: [{ text: 'West Park Avenue', pts: [{ x: 200, y: 352 }, { x: 400, y: 352 }] }],
      }),
    );
    expect(layout.labels.some((l) => l.cls === 't-fire')).toBe(true);
    expectNoOverlap(layout);
  });

  it('labels an exit point the same way with or without room, never "(candidate)"', () => {
    const exit = { id: 'd', code: 'D1', name: 'Pacific Coast Hwy exit', onMap: false, x: 700, y: 300, dir: { x: 1, y: 0 }, awayM: 10139, exit: true };
    const layout = layoutMap(baseInput({ dests: [exit] }));
    const t = layout.labels.find((l) => l.text.startsWith('Pacific'))!.text;
    expect(t).toBe('Pacific Coast Hwy exit, 6.3 mi');
    const onMap = layoutMap(baseInput({ dests: [{ ...exit, onMap: true, x: 700, dir: null }] }));
    expect(onMap.labels.some((l) => l.text === 'Pacific Coast Hwy exit')).toBe(true);
    expect(onMap.labels.some((l) => l.text.includes('candidate'))).toBe(false);
  });

  it('moves a closure ring off the Home ring, and leaves a far one in place', () => {
    const near = closureMarkerAt({ x: 500, y: 500 }, { x: 505, y: 500 }, 1);
    expect(near.moved).toBe(true);
    expect(Math.hypot(near.x - 500, near.y - 500)).toBeGreaterThanOrEqual(44);
    expect(near.y).toBe(500); // along the line from home through the closure
    expect(closureMarkerAt({ x: 500, y: 500 }, { x: 600, y: 500 }, 1)).toEqual({ x: 600, y: 500, moved: false });
  });

  it('uses km and km/h with metric units', () => {
    const layout = layoutMap(
      baseInput({
        units: 'km',
        wind: { fromDeg: 0, speedMph: 25, source: 'manual' },
        dests: [{ id: 'd', code: 'D1', name: 'Hall', onMap: false, x: 960, y: 500, dir: { x: 1, y: 0 }, awayM: 9500 }],
      }),
    );
    expect(layout.wind?.text?.text).toBe('Wind from north 40 km/h');
    expect(layout.labels.some((l) => l.text === 'Hall, 9.5 km away')).toBe(true);
  });
});

describe('sea layer', () => {
  it('draws the sea, a coastline and a Sea label point in the water', () => {
    const prepared = prepareArea(area(coastalElevation()));
    const view = makeView(prepared, 1);
    const sea = seaLayer(prepared, view);
    expect(sea).not.toBeNull();
    expect(sea!.fill.length).toBeGreaterThan(0);
    expect(sea!.coast.length).toBeGreaterThan(0);
    expect(sea!.labelAt[0].y).toBeLessThan(-1500);
  });

  it('draws no sea without elevation data or when nothing is at sea level', () => {
    const flat = prepareArea(area());
    expect(seaLayer(flat, makeView(flat, 1))).toBeNull();
    const e = coastalElevation();
    const land = prepareArea(area({ ...e, values: e.values.map((v) => v + 10) }));
    expect(seaLayer(land, makeView(land, 1))).toBeNull();
  });
});
