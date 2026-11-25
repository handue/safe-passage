import { describe, expect, it } from 'vitest';
import { makeProjection } from '../engine/geo';
import type { ReferenceData } from '../app/api';
import { referenceFetchedLine, referenceLines, refLayerFor } from './HomeMapScreen';
import { refFetchedCell } from './HowMadeScreen';

const home = { lat: 37.1275, lon: -122.1238 };
const when = () => 'Nov 24, 6:00 PM';
const src = 'test';

function data(over: Partial<ReferenceData>): ReferenceData {
  return {
    perimeters: { available: true, items: [], fetchedAt: '2026-11-25T09:00:00Z', source: src },
    detections: { available: false, reason: 'no_key', source: src },
    fetchedAt: '2026-11-25T09:00:00Z',
    radiusM: 50000,
    notes: [],
    ...over,
  };
}

const perim = (name: string, distanceM: number, acres: number | null = 1234.6) => ({
  name, acres, distanceM, updatedAt: '2026-11-24T18:00:00Z', rings: [[[home.lon, home.lat], [home.lon + 0.01, home.lat], [home.lon, home.lat + 0.01]]] as [number, number][][],
});

describe('reference panel lines', () => {
  it('no perimeters, no key', () => {
    const l = referenceLines(data({}), 'km', when);
    expect(l.perimeters).toBe('No current perimeters within 50 km.');
    expect(l.detections).toBe('Satellite detections need a free NASA FIRMS key.');
    expect(l.detectionsHint).toMatch(/FIRMS_MAP_KEY/);
  });

  it('nearest perimeter with distance in the household units, acres and update time', () => {
    const d = data({ perimeters: { available: true, items: [perim('Timber', 3219), perim('Far', 60000)], fetchedAt: 'x', source: src } });
    expect(referenceLines(d, 'mi', when).perimeters).toBe('Nearest current perimeter: Timber, 2.0 mi away (1,235 acres, updated Nov 24, 6:00 PM).');
    const two = data({ perimeters: { available: true, items: [perim('Timber', 3219, null), perim('Next', 9000)], fetchedAt: 'x', source: src } });
    expect(referenceLines(two, 'km', when).perimeters).toBe('Nearest current perimeter: Timber, 3.2 km away (updated Nov 24, 6:00 PM). 2 perimeters within 50 km.');
    const inside = data({ perimeters: { available: true, items: [perim('Timber', 0)], fetchedAt: 'x', source: src } });
    expect(referenceLines(inside, 'mi', when).perimeters).toMatch(/^Your address is inside the mapped perimeter of the Timber fire/);
  });

  it('outside the US, failures and detections counted within the radius', () => {
    const d = data({
      perimeters: { available: false, reason: 'outside_us', source: src },
      detections: {
        available: true,
        fetchedAt: 'x',
        source: src,
        items: [
          { lat: 0, lon: 0, acquiredAt: 'x', satellite: 'N20', confidence: 'high', distanceM: 4000 },
          { lat: 0, lon: 0, acquiredAt: 'x', satellite: 'N20', confidence: 'low', distanceM: 70000 },
        ],
      },
    });
    const l = referenceLines(d, 'km', when);
    expect(l.perimeters).toMatch(/US only/);
    expect(l.detections).toMatch(/^1 satellite heat detection within 50 km in the last 48 hours/);
    const failed = data({ perimeters: { available: false, reason: 'failed', source: src }, detections: { available: false, reason: 'failed', source: src } });
    expect(referenceLines(failed, 'mi', when).perimeters).toMatch(/did not answer/);
    expect(referenceLines(failed, 'mi', when).detections).toMatch(/did not answer/);
  });

  it('projects rings and points to local XY, dropping far ones', () => {
    const proj = makeProjection(home);
    const d = data({ perimeters: { available: true, items: [perim('Near', 100), perim('Far', 60000)], fetchedAt: 'x', source: src } });
    const layer = refLayerFor(d, proj);
    expect(layer.perimeters).toHaveLength(1);
    expect(layer.perimeters[0][0][0].x).toBeCloseTo(0, 6);
    expect(layer.perimeters[0][0][1].x).toBeGreaterThan(800);
    expect(layer.detections).toEqual([]);
  });
});

describe('reference fetch times and reasons', () => {
  const fmt = (iso: string) => iso.slice(11, 16);
  it('the panel shows the part fetch times, the same ones How-made shows', () => {
    const d = data({ fetchedAt: '2026-11-25T09:46:00Z', perimeters: { available: true, items: [], fetchedAt: '2026-11-25T09:42:00Z', source: src } });
    expect(referenceFetchedLine(d, fmt)).toBe('Fetched 09:42.');
    expect(refFetchedCell(d.perimeters, true)).toEqual({ iso: '2026-11-25T09:42:00Z' });
    const both = data({ ...d, detections: { available: true, items: [], fetchedAt: '2026-11-25T09:44:00Z', source: src } });
    expect(referenceFetchedLine(both, fmt)).toBe('Perimeters fetched 09:42; satellite detections fetched 09:44.');
    const none = data({ perimeters: { available: false, reason: 'outside_us', source: src }, fetchedAt: '2026-11-25T09:46:00Z' });
    expect(referenceFetchedLine(none, fmt)).toBe('Checked 09:46.');
  });

  it('How-made gives the real reason a part is missing', () => {
    expect(refFetchedCell({ available: false, reason: 'no_key', source: src }, true)).toEqual({ text: 'not used (no key)' });
    expect(refFetchedCell({ available: false, reason: 'bad_key', source: src }, true)).toEqual({ text: 'not used (key not accepted)' });
    expect(refFetchedCell({ available: false, reason: 'failed', source: src }, true)).toEqual({ text: 'not used (service did not answer)' });
    expect(refFetchedCell({ available: false, reason: 'outside_us', source: src }, true)).toEqual({ text: 'not used (outside the US)' });
    expect(refFetchedCell(null, true)).toEqual({ text: 'not used (layer off)' });
    expect(refFetchedCell(null, false)).toEqual({ text: 'no address yet' });
  });
});
