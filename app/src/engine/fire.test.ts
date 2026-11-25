import { describe, expect, it } from 'vitest';
import type { ElevationGrid, FireParams, FireResult, Wind } from './types';
import {
  burnStateAt,
  cellCenter,
  cellOf,
  elevationForCells,
  firstIgnitionWithin,
  isInGrid,
  isWaterAt,
  isWaterCell,
  makeFireGrid,
  simulateFire,
  waterMask,
} from './fire';

const calm: Wind = { fromDeg: 0, speedMph: 0, source: 'manual' };

function params(over: Partial<FireParams> = {}): FireParams {
  return { ignition: { x: 0, y: 0 }, wind: calm, seed: 1, horizonMin: 180, stepMin: 1, elevationPerCell: null, ...over };
}

// Farthest burned cell center from the ignition along a unit direction, by minute.
function reach(result: FireResult, dir: { x: number; y: number }, minute: number): number {
  const { grid, ignitionMin } = result;
  let best = 0;
  for (let i = 0; i < ignitionMin.length; i++) {
    const ign = ignitionMin[i];
    if (ign < 0 || ign > minute) continue;
    const c = cellCenter(grid, i % grid.size, Math.floor(i / grid.size));
    best = Math.max(best, c.x * dir.x + c.y * dir.y);
  }
  return best;
}

describe('grid helpers', () => {
  it('centers the grid on home', () => {
    const g = makeFireGrid();
    expect(g.originXY).toEqual({ x: -3000, y: -3000 });
    expect(cellOf(g, { x: 0, y: 0 })).toEqual({ col: 30, row: 30 });
    expect(cellOf(g, { x: -3000, y: -3000 })).toEqual({ col: 0, row: 0 });
    expect(cellOf(g, { x: 3000, y: 0 })).toBeNull();
    expect(cellCenter(g, 0, 0)).toEqual({ x: -2950, y: -2950 });
    expect(isInGrid(g, { x: 2999, y: 0 })).toBe(true);
    expect(isInGrid(g, { x: 3500, y: 0 })).toBe(false);
  });

  it('an off-grid ignition simulates no fire', () => {
    const r = simulateFire(makeFireGrid(), params({ ignition: { x: 3500, y: 0 } }));
    expect(r.ignitionMin.every((v) => v === -1)).toBe(true);
  });

  it('interpolates elevation bilinearly and clamps at edges', () => {
    const g = makeFireGrid(100, 4); // centers at -150,-50,50,150
    const elev: ElevationGrid = { rows: 2, cols: 2, originXY: { x: -100, y: -100 }, spacing: 200, values: [0, 100, 0, 100] };
    const e = elevationForCells(g, elev)!;
    expect(Array.from(e.slice(0, 4))).toEqual([0, 25, 75, 100]);
    expect(elevationForCells(g, null)).toBeNull();
  });
});

describe('simulateFire', () => {
  const grid = makeFireGrid();

  it('is reproducible for a seed and varies across seeds', () => {
    const a = simulateFire(grid, params({ seed: 42 }));
    const b = simulateFire(grid, params({ seed: 42 }));
    const c = simulateFire(grid, params({ seed: 43 }));
    expect(Array.from(a.ignitionMin)).toEqual(Array.from(b.ignitionMin));
    expect(Array.from(a.ignitionMin)).not.toEqual(Array.from(c.ignitionMin));
    expect(a.ignitionMin[30 * 60 + 30]).toBe(0);
  });

  it('spreads at least 3x farther downwind than upwind', () => {
    // Wind from the west blows east.
    const r = simulateFire(grid, params({ wind: { fromDeg: 270, speedMph: 25, source: 'manual' } }));
    const down = reach(r, { x: 1, y: 0 }, 60);
    const up = reach(r, { x: -1, y: 0 }, 60);
    expect(down).toBeGreaterThan(3 * Math.max(up, 50));
  });

  it('runs faster uphill than downhill', () => {
    // Ground rises to the north: 20% grade.
    const elev = new Float32Array(60 * 60);
    for (let row = 0; row < 60; row++) for (let col = 0; col < 60; col++) elev[row * 60 + col] = 0.2 * cellCenter(grid, col, row).y;
    const r = simulateFire(grid, params({ elevationPerCell: elev }));
    expect(reach(r, { x: 0, y: 1 }, 90)).toBeGreaterThan(1.5 * reach(r, { x: 0, y: -1 }, 90));
  });

  it('spreads roughly symmetrically with no wind on flat ground', () => {
    const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
    const sums = [0, 0, 0, 0];
    for (let seed = 1; seed <= 5; seed++) {
      const r = simulateFire(grid, params({ seed }));
      dirs.forEach((d, k) => (sums[k] += reach(r, d, 60)));
    }
    const min = Math.min(...sums);
    const max = Math.max(...sums);
    expect(min).toBeGreaterThan(0);
    expect(max / min).toBeLessThan(1.3);
  });

  it('stops at the horizon and returns -1 for an ignition outside the grid', () => {
    const r = simulateFire(grid, params({ horizonMin: 20 }));
    expect(Math.max(...r.ignitionMin)).toBeLessThanOrEqual(20);
    const out = simulateFire(grid, params({ ignition: { x: 9000, y: 0 } }));
    expect(out.ignitionMin.every((v) => v === -1)).toBe(true);
  });

  it('runs a 60x60, 180-step strong-wind fire well under 200 ms', () => {
    const p = params({ wind: { fromDeg: 225, speedMph: 30, source: 'manual' } });
    simulateFire(grid, p); // warm up
    const t0 = performance.now();
    simulateFire(grid, p);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('queries', () => {
  const grid = makeFireGrid();
  const r = simulateFire(grid, params({ seed: 7 }));

  it('reports burn state over time', () => {
    const i = 30 * 60 + 30;
    expect(burnStateAt(r, i, -1)).toBe('unburned');
    expect(burnStateAt(r, i, 0)).toBe('burning');
    expect(burnStateAt(r, i, 29.9)).toBe('burning');
    expect(burnStateAt(r, i, 30)).toBe('burned');
    expect(burnStateAt(r, 0, 100)).toBe('unburned');
  });

  it('finds the earliest ignition within a radius', () => {
    expect(firstIgnitionWithin(r, { x: 50, y: 50 }, 10)).toBe(0);
    const near = firstIgnitionWithin(r, { x: 500, y: 0 }, 100);
    expect(near).toBeGreaterThan(0);
    expect(firstIgnitionWithin(r, { x: 50000, y: 0 }, 100)).toBe(Infinity);
  });
});

describe('sea cells (coastal grid)', () => {
  // South half of a 60x60 grid is sea (0 m), north half is land at 40 m.
  const grid = makeFireGrid(100, 60);
  const coast = new Float32Array(60 * 60);
  for (let row = 0; row < 60; row++) for (let col = 0; col < 60; col++) coast[row * 60 + col] = row < 30 ? 0 : 40;

  it('marks sea cells and nothing when elevation is missing or all at sea level', () => {
    const mask = waterMask(coast)!;
    expect(mask[0]).toBe(1);
    expect(mask[59 * 60]).toBe(0);
    expect(isWaterCell(coast, 10)).toBe(true);
    expect(isWaterAt(grid, coast, { x: 0, y: -1000 })).toBe(true);
    expect(isWaterAt(grid, coast, { x: 0, y: 1000 })).toBe(false);
    expect(isWaterAt(grid, null, { x: 0, y: -1000 })).toBe(false);
    expect(waterMask(null)).toBeNull();
    // All cells at 0 m reads as a failed elevation service, not an all-sea area.
    expect(waterMask(new Float32Array(60 * 60))).toBeNull();
  });

  it('a land fire blowing out to sea stops at the coast', () => {
    const r = simulateFire(grid, params({
      ignition: { x: 0, y: 1000 },
      wind: { fromDeg: 0, speedMph: 25, source: 'manual' },
      elevationPerCell: coast,
    }));
    let land = 0;
    for (let i = 0; i < r.ignitionMin.length; i++) {
      const row = Math.floor(i / 60);
      if (row < 30) expect(r.ignitionMin[i]).toBe(-1);
      else if (r.ignitionMin[i] >= 0) land++;
    }
    expect(land).toBeGreaterThan(50);
  });

  it('an ignition on the sea gives no fire', () => {
    const r = simulateFire(grid, params({ ignition: { x: 0, y: -2000 }, elevationPerCell: coast }));
    expect(Array.from(r.ignitionMin).every((v) => v === -1)).toBe(true);
  });
});
