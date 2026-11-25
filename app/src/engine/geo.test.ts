import { describe, expect, it } from 'vitest';
import {
  bearingDeg,
  compassName,
  dist,
  nearestPointOnPolyline,
  makeProjection,
  pointSegmentDistance,
  polylineLength,
  samplePolyline,
  windToVector,
} from './geo';
import type { LatLon } from './types';

const home: LatLon = { lat: 37.25, lon: -122.03 };

function haversineM(a: LatLon, b: LatLon): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('makeProjection', () => {
  const proj = makeProjection(home);

  it('maps the origin to (0, 0)', () => {
    const p = proj.toXY(home);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0, 9);
  });

  it('round-trips XY -> lat/lon -> XY within 0.5 m out to 10 km', () => {
    for (let x = -10000; x <= 10000; x += 2500) {
      for (let y = -10000; y <= 10000; y += 2500) {
        const back = proj.toXY(proj.toLatLon({ x, y }));
        expect(dist(back, { x, y })).toBeLessThan(0.5);
      }
    }
  });

  it('round-trips lat/lon -> XY -> lat/lon within 0.5 m', () => {
    const p: LatLon = { lat: home.lat + 0.07, lon: home.lon - 0.09 };
    const back = proj.toLatLon(proj.toXY(p));
    expect(haversineM(p, back)).toBeLessThan(0.5);
  });

  it('agrees with great-circle distance within 0.5% inside 10 km', () => {
    const p: LatLon = { lat: home.lat + 0.05, lon: home.lon + 0.06 };
    const xy = proj.toXY(p);
    const flat = Math.hypot(xy.x, xy.y);
    const gc = haversineM(home, p);
    expect(Math.abs(flat - gc) / gc).toBeLessThan(0.005);
  });

  it('points east for larger longitude and north for larger latitude', () => {
    const e = proj.toXY({ lat: home.lat, lon: home.lon + 0.01 });
    const n = proj.toXY({ lat: home.lat + 0.01, lon: home.lon });
    expect(e.x).toBeGreaterThan(0);
    expect(Math.abs(e.y)).toBeLessThan(1e-9);
    expect(n.y).toBeCloseTo(1113.2, 6);
  });
});

describe('distances', () => {
  it('dist is Euclidean', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('pointSegmentDistance handles interior, ends and degenerate segments', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(pointSegmentDistance({ x: 5, y: 3 }, a, b)).toBeCloseTo(3);
    expect(pointSegmentDistance({ x: -3, y: 4 }, a, b)).toBeCloseTo(5);
    expect(pointSegmentDistance({ x: 13, y: 4 }, a, b)).toBeCloseTo(5);
    expect(pointSegmentDistance({ x: 3, y: 4 }, a, a)).toBeCloseTo(5);
  });

  it('polylineLength sums segments', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
    expect(polylineLength([{ x: 1, y: 1 }])).toBe(0);
    expect(polylineLength([])).toBe(0);
  });
});

describe('samplePolyline', () => {
  it('includes both endpoints and spaces samples by stepM', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }];
    const s = samplePolyline(pts, 4);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 10, y: 5 });
    // samples at 0, 4, 8, 12 (=10,2), then end at 15
    expect(s.length).toBe(5);
    expect(s[3].x).toBeCloseTo(10);
    expect(s[3].y).toBeCloseTo(2);
  });

  it('does not duplicate the end when length is a multiple of step', () => {
    const s = samplePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 5);
    expect(s).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]);
  });

  it('handles short lines, single points and empty input', () => {
    expect(samplePolyline([{ x: 0, y: 0 }, { x: 1, y: 0 }], 50)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(samplePolyline([{ x: 2, y: 2 }], 10)).toEqual([{ x: 2, y: 2 }]);
    expect(samplePolyline([], 10)).toEqual([]);
  });
});

describe('bearings and compass', () => {
  const o = { x: 0, y: 0 };
  it('gives cardinal bearings', () => {
    expect(bearingDeg(o, { x: 0, y: 100 })).toBeCloseTo(0);
    expect(bearingDeg(o, { x: 100, y: 0 })).toBeCloseTo(90);
    expect(bearingDeg(o, { x: 0, y: -100 })).toBeCloseTo(180);
    expect(bearingDeg(o, { x: -100, y: 0 })).toBeCloseTo(270);
    expect(bearingDeg(o, { x: 100, y: 100 })).toBeCloseTo(45);
  });

  it('names 8-point compass directions with wrap-around', () => {
    expect(compassName(0)).toBe('north');
    expect(compassName(44)).toBe('northeast');
    expect(compassName(90)).toBe('east');
    expect(compassName(135)).toBe('southeast');
    expect(compassName(180)).toBe('south');
    expect(compassName(225)).toBe('southwest');
    expect(compassName(270)).toBe('west');
    expect(compassName(315)).toBe('northwest');
    expect(compassName(350)).toBe('north');
    expect(compassName(-90)).toBe('west');
    expect(compassName(720)).toBe('north');
  });
});

describe('windToVector', () => {
  it('wind from 315 (northwest) blows toward the southeast', () => {
    const v = windToVector(315);
    expect(v.x).toBeGreaterThan(0);
    expect(v.y).toBeLessThan(0);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    expect(compassName(bearingDeg({ x: 0, y: 0 }, v))).toBe('southeast');
  });

  it('wind from north blows south', () => {
    const v = windToVector(0);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(-1);
  });
});

describe('nearestPointOnPolyline', () => {
  it('projects onto the closest segment and clamps to ends', () => {
    const line = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }];
    expect(nearestPointOnPolyline({ x: 300, y: 50 }, line)).toEqual({ x: 300, y: 0 });
    expect(nearestPointOnPolyline({ x: 1200, y: 600 }, line)).toEqual({ x: 1000, y: 600 });
    expect(nearestPointOnPolyline({ x: -50, y: -50 }, line)).toEqual({ x: 0, y: 0 });
    expect(nearestPointOnPolyline({ x: 5, y: 5 }, [])).toEqual({ x: 5, y: 5 });
  });
});
