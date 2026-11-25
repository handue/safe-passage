import { describe, expect, it } from 'vitest';
import { checkIgnitionPoint, suggestIgnitions } from './ignition';
import { makeFireGrid, cellCenter } from './fire';
import { bearingDeg } from './geo';
import type { Wind, XY } from './types';

const home: XY = { x: 0, y: 0 };
const grid = makeFireGrid(100, 60);
const westWind: Wind = { fromDeg: 270, speedMph: 15, source: 'manual' };
const calm: Wind = { fromDeg: 0, speedMph: 0, source: 'manual' };

function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Elevation that rises toward the given compass direction at `gradient` m per m. */
function tilted(towardDeg: number, gradient: number): Float32Array {
  const out = new Float32Array(grid.size * grid.size);
  const rad = (towardDeg * Math.PI) / 180;
  for (let row = 0; row < grid.size; row++) {
    for (let col = 0; col < grid.size; col++) {
      const c = cellCenter(grid, col, row);
      out[row * grid.size + col] = 500 + gradient * (c.x * Math.sin(rad) + c.y * Math.cos(rad));
    }
  }
  return out;
}

describe('suggestIgnitions', () => {
  it('returns 3 points with labels and reasons', () => {
    const picks = suggestIgnitions(grid, null, westWind, home, []);
    expect(picks).toHaveLength(3);
    for (const p of picks) {
      expect(p.label).toMatch(/^\d\.\d km (north|northeast|east|southeast|south|southwest|west|northwest)$/);
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it('with wind from the west, the best point is west of home', () => {
    const [best] = suggestIgnitions(grid, null, westWind, home, []);
    expect(best.xy.x).toBeLessThan(-1500);
    expect(Math.abs(best.xy.y)).toBeLessThan(1);
    expect(best.label).toMatch(/west$/);
    expect(best.reason).toBe('Upwind of your home');
  });

  it('picks are at least 60 degrees apart', () => {
    const picks = suggestIgnitions(grid, tilted(30, 0.05), westWind, home, [home, { x: 0, y: 1500 }]);
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const a = bearingDeg(home, picks[i].xy);
        const b = bearingDeg(home, picks[j].xy);
        expect(angleBetween(a, b)).toBeGreaterThanOrEqual(60 - 1e-9);
      }
    }
  });

  it('flat vs sloped ground changes the picks', () => {
    const flat = suggestIgnitions(grid, null, calm, home, []);
    // Ground rises toward the north, so fire would run uphill from the south.
    const sloped = suggestIgnitions(grid, tilted(0, 0.05), calm, home, []);
    expect(sloped.map((p) => p.xy)).not.toEqual(flat.map((p) => p.xy));
    expect(sloped[0].label).toMatch(/south$/);
    expect(sloped[0].reason).toBe('Downhill of your home');
    expect(flat[0].reason).toMatch(/Little wind or slope/);
  });

  it('the main route pulls the best point toward it', () => {
    // Calm air, ground rising to the north; route runs north from home.
    const route = [home, { x: 0, y: 3000 }];
    const picks = suggestIgnitions(grid, tilted(0, 0.05), calm, home, route);
    expect(picks).toHaveLength(3);
    expect(picks[0].label).toMatch(/south/);
  });

  it('keeps candidates 300 m inside a small grid', () => {
    const small = makeFireGrid(100, 50); // 2500 m half-width: 2400 m ring is too close to the edge
    const picks = suggestIgnitions(small, null, westWind, home, []);
    const half = 2500;
    for (const p of picks) {
      expect(Math.abs(p.xy.x)).toBeLessThanOrEqual(half - 300 + 1e-6);
      expect(Math.abs(p.xy.y)).toBeLessThanOrEqual(half - 300 + 1e-6);
    }
    expect(picks).toHaveLength(3);
  });

  it('is deterministic', () => {
    const a = suggestIgnitions(grid, tilted(45, 0.03), westWind, home, [home, { x: 800, y: 900 }]);
    const b = suggestIgnitions(grid, tilted(45, 0.03), westWind, home, [home, { x: 800, y: 900 }]);
    expect(a).toEqual(b);
  });
});

import { suggestIgnitions as suggest2 } from './ignition';
import { makeFireGrid as grid2 } from './fire';
it('keeps suggested points away from the routes', () => {
  const route = [{ x: 0, y: 0 }, { x: -3000, y: 0 }];
  const picks = suggest2(grid2(100, 60), null, { fromDeg: 270, speedMph: 20, source: 'manual' }, { x: 0, y: 0 }, route);
  for (const p of picks) {
    const d = p.xy.x <= 0 && p.xy.x >= -3000 ? Math.abs(p.xy.y) : Math.hypot(p.xy.x - Math.min(0, Math.max(-3000, p.xy.x)), p.xy.y);
    expect(d).toBeGreaterThanOrEqual(800);
  }
});

describe('coastal grid', () => {
  // South half of the grid is sea (0 m); the land rises gently to the north.
  const coast = new Float32Array(60 * 60);
  for (let row = 0; row < 60; row++) {
    for (let col = 0; col < 60; col++) coast[row * 60 + col] = row < 30 ? 0 : 5 + (row - 30) * 2;
  }
  const isSea = (p: XY) => p.y < 0;

  it('never suggests a point on the sea, even when wind blows from the sea', () => {
    const fromSouth: Wind = { fromDeg: 180, speedMph: 25, source: 'manual' };
    const picks = suggestIgnitions(grid, coast, fromSouth, { x: 0, y: 100 }, [{ x: 0, y: 100 }, { x: 0, y: 1500 }]);
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) expect(isSea(p.xy)).toBe(false);
    for (const p of picks) expect(checkIgnitionPoint(grid, coast, p.xy)).toBe('ok');
  });

  it('checkIgnitionPoint refuses water and points outside the area', () => {
    expect(checkIgnitionPoint(grid, coast, { x: 0, y: -1500 })).toBe('water');
    expect(checkIgnitionPoint(grid, coast, { x: 0, y: 1500 })).toBe('ok');
    expect(checkIgnitionPoint(grid, coast, { x: 5000, y: 0 })).toBe('outside');
    expect(checkIgnitionPoint(grid, null, { x: 0, y: -1500 })).toBe('ok');
  });
});
