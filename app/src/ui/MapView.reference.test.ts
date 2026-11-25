import { describe, expect, it } from 'vitest';
import { makeProjection } from '../engine/geo';
import { prepareArea } from '../engine/area';
import type { AreaData, XY } from '../engine/types';
import { boxCrossesLines, layoutMap, makeView, overlaps, refAreaCells, refInView, REF_PERIMETER_LABELS, type LayoutInput } from './MapView';

const home = { lat: 37.17, lon: -122.12 };
const proj = makeProjection(home);
const area: AreaData = {
  home,
  addressLabel: 'Test',
  country: 'us',
  roads: [{ id: 1, name: 'A Rd', highway: 'primary', nodeIds: [1, 2], coords: [proj.toLatLon({ x: 0, y: 0 }), proj.toLatLon({ x: 3000, y: 0 })] }],
  places: [],
  elevation: null,
  wind: null,
  fetchedAt: {},
  fallbacksUsed: [],
};
const prepared = prepareArea(area);
const view = makeView(prepared, 1);
const square = (cx: number, cy: number, h: number): XY[] => [
  { x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h },
];

describe('reference layer in the map view', () => {
  it('keeps perimeters and detections in view, labels the nearest edge point', () => {
    const near = [square(1500, 0, 300)];
    const far = [square(30000, 0, 300)];
    const shown = refInView(view, { perimeters: [far, near], detections: [{ x: 100, y: 100 }, { x: 40000, y: 0 }] }, { x: 0, y: 0 }, 0);
    expect(shown.perimeters).toEqual([near]);
    expect(shown.detections).toEqual([{ x: 100, y: 100 }]);
    expect(shown.labelAt).toEqual({ x: 1200, y: -300 });
  });

  it('a perimeter around the whole view is drawn, with no edge point to label', () => {
    const shown = refInView(view, { perimeters: [[square(0, 0, 20000)]], detections: [] }, { x: 0, y: 0 }, 0);
    expect(shown.perimeters).toHaveLength(1);
    expect(shown.labelAt).toBeNull();
  });

  const base = (over: Partial<LayoutInput>): LayoutInput => ({
    view, u: 1.5, units: 'mi', home: { x: 500, y: 500 }, dests: [], closure: null, ignition: null, wind: undefined, caption: null, notes: [],
    cornerNotes: [], grid: { x: 50, y: 50, w: 900 }, sea: [], routeLabels: [], roadNames: [], fireCentroid: null, ...over,
  });

  it('marks the visible part of a perimeter as cells, clipped to the frame', () => {
    const [cells] = refAreaCells([[square(900, 100, 200)]], 0, 1000, 20);
    expect(cells.length).toBeGreaterThan(50);
    expect(cells.every((c) => c.x1 <= 1000 && c.y0 >= 0)).toBe(true);
    const [none] = refAreaCells([[square(5000, 5000, 100)]], 0, 1000, 20);
    expect(none).toHaveLength(0);
  });

  it('places the perimeter label next to the visible part, off the shape', () => {
    const cells = refAreaCells([[square(700, 300, 80)]], 0, 1000, 24);
    const layout = layoutMap(base({ refCells: cells }));
    const label = layout.labels.find((l) => l.cls === 't-ref');
    expect(label && REF_PERIMETER_LABELS.includes(label.text)).toBe(true);
    const b = label!.box;
    expect(cells[0].some((c) => overlaps(b, c))).toBe(false);
    // Within a line or so of the shape's bounding box.
    expect(b.x1).toBeGreaterThan(600);
    expect(b.x0).toBeLessThan(800);
    expect(b.y1).toBeGreaterThan(200);
    expect(b.y0).toBeLessThan(420);
  });

  it('never puts the perimeter label across a route', () => {
    const cells = refAreaCells([[square(700, 300, 80)]], 0, 1000, 24);
    const routeLines = [[{ x: 0, y: 410 }, { x: 1000, y: 410 }], [{ x: 0, y: 190 }, { x: 1000, y: 190 }], [{ x: 590, y: 0 }, { x: 590, y: 1000 }], [{ x: 810, y: 0 }, { x: 810, y: 1000 }]];
    const label = layoutMap(base({ refCells: cells, routeLines })).labels.find((l) => l.cls === 't-ref');
    if (label) expect(boxCrossesLines(label.box, routeLines)).toBe(false);
  });

  it('drops the label when only a sliver of the perimeter is visible', () => {
    const cells = refAreaCells([[square(1010, 500, 20)]], 0, 1000, 24);
    expect(layoutMap(base({ refCells: cells })).labels.find((l) => l.cls === 't-ref')).toBeUndefined();
  });

  it('keeps the wind arrow and other labels off the perimeter', () => {
    const cells = refAreaCells([[square(930, 70, 90)]], 0, 1000, 24);
    const layout = layoutMap(base({ refCells: cells, wind: { fromDeg: 45, speedMph: 25, source: 'manual' }, cornerNotes: ['Fire not modeled outside the dashed square'] }));
    expect(layout.wind?.arrow).toBe(true);
    const arrow = { x0: layout.wind!.ax - 39, y0: layout.wind!.ay - 39, x1: layout.wind!.ax + 39, y1: layout.wind!.ay + 39 };
    expect(cells[0].some((c) => overlaps(arrow, c))).toBe(false);
    for (const l of layout.labels) expect(cells[0].some((c) => overlaps(l.box, c))).toBe(false);
  });
});
