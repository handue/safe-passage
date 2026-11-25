// Simplified cellular-automaton fire spread for drills. Not a forecast.
import type { ElevationGrid, FireGrid, FireParams, FireResult, XY } from './types';
import { mulberry32 } from './rng';
import { windToVector } from './geo';

/** Tuning constants for the drill fire model. Rates in m/min, times in minutes. */
export const FIRE_CONSTANTS = {
  /** Spread rate on flat ground with no wind, before fuel noise (m/min). */
  baseRateMPerMin: 6,
  /** Wind factor = exp(windCoef * speedMph * cos(angle to wind)). */
  windCoef: 0.08,
  /** Slope factor = exp(slopeCoef * rise / run), clamped below. */
  slopeCoef: 3.5,
  slopeFactorMin: 0.3,
  slopeFactorMax: 6,
  /** How long a cell burns (and can spread) after it ignites. */
  burnMinutes: 30,
  /** Per-cell fuel noise range, drawn once per cell from the seed. */
  cellNoiseMin: 0.7,
  cellNoiseMax: 1.3,
  defaultCellM: 100,
  defaultSize: 60,
  defaultHorizonMin: 180,
} as const;

export function makeFireGrid(cellM: number = FIRE_CONSTANTS.defaultCellM, size: number = FIRE_CONSTANTS.defaultSize): FireGrid {
  const half = (cellM * size) / 2;
  return { cellM, size, originXY: { x: -half, y: -half } };
}

export function cellOf(grid: FireGrid, xy: XY): { col: number; row: number } | null {
  const col = Math.floor((xy.x - grid.originXY.x) / grid.cellM);
  const row = Math.floor((xy.y - grid.originXY.y) / grid.cellM);
  if (col < 0 || row < 0 || col >= grid.size || row >= grid.size) return null;
  return { col, row };
}

/** True when xy falls inside the fire grid. simulateFire returns an empty fire for an ignition outside it. */
export function isInGrid(grid: FireGrid, xy: XY): boolean {
  return cellOf(grid, xy) !== null;
}

export function cellCenter(grid: FireGrid, col: number, row: number): XY {
  return {
    x: grid.originXY.x + (col + 0.5) * grid.cellM,
    y: grid.originXY.y + (row + 0.5) * grid.cellM,
  };
}

/** Bilinear sample of the elevation grid at every fire cell center (clamped at the edges). */
export function elevationForCells(grid: FireGrid, elev: ElevationGrid | null): Float32Array | null {
  if (!elev || elev.rows < 1 || elev.cols < 1 || elev.values.length < elev.rows * elev.cols) return null;
  const out = new Float32Array(grid.size * grid.size);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  for (let row = 0; row < grid.size; row++) {
    for (let col = 0; col < grid.size; col++) {
      const c = cellCenter(grid, col, row);
      const fx = clamp((c.x - elev.originXY.x) / elev.spacing, 0, elev.cols - 1);
      const fy = clamp((c.y - elev.originXY.y) / elev.spacing, 0, elev.rows - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, elev.cols - 1);
      const y1 = Math.min(y0 + 1, elev.rows - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const v = (r: number, k: number) => elev.values[r * elev.cols + k];
      const south = v(y0, x0) * (1 - tx) + v(y0, x1) * tx;
      const north = v(y1, x0) * (1 - tx) + v(y1, x1) * tx;
      out[row * grid.size + col] = south * (1 - ty) + north * ty;
    }
  }
  return out;
}

/**
 * Cells at or below this elevation count as sea and never burn.
 * Only the sea is found this way: lakes, rivers and reservoirs above sea level still burn.
 */
export const WATER_MAX_ELEV_M = 0.5;

/**
 * 1 = water (sea) cell, 0 = land, per fire cell. Null when there is no elevation, or when every
 * cell is at sea level, which reads as a failed elevation service rather than an all-sea area.
 */
export function waterMask(elevationPerCell: Float32Array | null): Uint8Array | null {
  if (!elevationPerCell || elevationPerCell.length === 0) return null;
  const mask = new Uint8Array(elevationPerCell.length);
  let water = 0;
  for (let i = 0; i < elevationPerCell.length; i++) {
    if (elevationPerCell[i] <= WATER_MAX_ELEV_M) {
      mask[i] = 1;
      water++;
    }
  }
  if (water === 0 || water === elevationPerCell.length) return null;
  return mask;
}

/** True when the fire cell at cellIndex is sea. False with no elevation data. */
export function isWaterCell(elevationPerCell: Float32Array | null, cellIndex: number): boolean {
  const mask = waterMask(elevationPerCell);
  return mask !== null && mask[cellIndex] === 1;
}

/** True when xy lies in a sea cell of the grid. Points outside the grid return false (check isInGrid). */
export function isWaterAt(grid: FireGrid, elevationPerCell: Float32Array | null, xy: XY): boolean {
  const c = cellOf(grid, xy);
  if (!c || !elevationPerCell || elevationPerCell.length !== grid.size * grid.size) return false;
  return isWaterCell(elevationPerCell, c.row * grid.size + c.col);
}

// 8 neighbor offsets (dcol, drow).
const NEIGHBORS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

export function simulateFire(grid: FireGrid, params: FireParams): FireResult {
  const C = FIRE_CONSTANTS;
  const n = grid.size;
  const count = n * n;
  const rand = mulberry32(params.seed);
  const ignitionMin = new Float32Array(count).fill(-1);
  const result: FireResult = { grid, ignitionMin, burnMinutes: C.burnMinutes, horizonMin: params.horizonMin };

  // Fuel noise first, row-major, so the RNG sequence is fixed.
  const noise = new Float32Array(count);
  for (let i = 0; i < count; i++) noise[i] = C.cellNoiseMin + (C.cellNoiseMax - C.cellNoiseMin) * rand();

  const start = cellOf(grid, params.ignition);
  // Off-grid ignition: no fire is simulated. Callers check isInGrid first (runDrill reports it in coverage).
  if (!start) return result;

  const elev = params.elevationPerCell && params.elevationPerCell.length === count ? params.elevationPerCell : null;
  // Sea cells never ignite and never spread. An ignition on water gives no fire.
  const water = waterMask(elev);
  if (water && water[start.row * n + start.col] === 1) return result;

  // Per-direction distance and wind factor (same for every cell).
  const w = windToVector(params.wind.fromDeg);
  const dist = new Float64Array(8);
  const windFactor = new Float64Array(8);
  for (let k = 0; k < 8; k++) {
    const [dc, dr] = NEIGHBORS[k];
    const len = Math.hypot(dc, dr);
    dist[k] = grid.cellM * len;
    const cos = (w.x * dc + w.y * dr) / len;
    windFactor[k] = Math.exp(C.windCoef * params.wind.speedMph * cos);
  }

  const step = params.stepMin;

  // survive[j] = product of (1 - p_i) over burning neighbors this step; stamp marks candidates.
  const survive = new Float64Array(count);
  const stamp = new Int32Array(count).fill(-1);
  const candidates = new Int32Array(count);

  let burning: number[] = [start.row * n + start.col];
  ignitionMin[burning[0]] = 0;

  for (let s = 0; burning.length > 0; s++) {
    const t = s * step;
    const tEnd = t + step;
    if (tEnd > params.horizonMin) break;

    let nCand = 0;
    for (const i of burning) {
      const col = i % n;
      const row = (i - col) / n;
      for (let k = 0; k < 8; k++) {
        const c2 = col + NEIGHBORS[k][0];
        const r2 = row + NEIGHBORS[k][1];
        if (c2 < 0 || r2 < 0 || c2 >= n || r2 >= n) continue;
        const j = r2 * n + c2;
        if (ignitionMin[j] >= 0) continue;
        if (water && water[j] === 1) continue;
        let slopeFactor = 1;
        if (elev) {
          slopeFactor = Math.exp((C.slopeCoef * (elev[j] - elev[i])) / dist[k]);
          slopeFactor = Math.min(C.slopeFactorMax, Math.max(C.slopeFactorMin, slopeFactor));
        }
        const rate = C.baseRateMPerMin * noise[j] * windFactor[k] * slopeFactor;
        const p = 1 - Math.exp((-rate * step) / dist[k]);
        if (stamp[j] !== s) {
          stamp[j] = s;
          survive[j] = 1;
          candidates[nCand++] = j;
        }
        survive[j] *= 1 - p;
      }
    }

    // One draw per candidate, in index order, for reproducibility.
    const cand = candidates.subarray(0, nCand).sort();
    const ignitedNow: number[] = [];
    for (let q = 0; q < nCand; q++) {
      const j = cand[q];
      if (rand() < 1 - survive[j]) ignitedNow.push(j);
    }
    for (const j of ignitedNow) ignitionMin[j] = tEnd;

    // Next step's burning set: still within burn time at tEnd, plus new ignitions.
    const next: number[] = [];
    for (const i of burning) if (tEnd < ignitionMin[i] + C.burnMinutes) next.push(i);
    for (const j of ignitedNow) next.push(j);
    burning = next;
  }

  return result;
}

export function burnStateAt(result: FireResult, cellIndex: number, minute: number): 'unburned' | 'burning' | 'burned' {
  const ign = result.ignitionMin[cellIndex];
  if (ign < 0 || minute < ign) return 'unburned';
  return minute < ign + result.burnMinutes ? 'burning' : 'burned';
}

/** Earliest ignition minute among cells whose centers lie within radiusM of xy; Infinity if none. */
export function firstIgnitionWithin(result: FireResult, xy: XY, radiusM: number): number {
  const { grid, ignitionMin } = result;
  const n = grid.size;
  const r2 = radiusM * radiusM;
  const colLo = Math.max(0, Math.floor((xy.x - radiusM - grid.originXY.x) / grid.cellM));
  const colHi = Math.min(n - 1, Math.floor((xy.x + radiusM - grid.originXY.x) / grid.cellM));
  const rowLo = Math.max(0, Math.floor((xy.y - radiusM - grid.originXY.y) / grid.cellM));
  const rowHi = Math.min(n - 1, Math.floor((xy.y + radiusM - grid.originXY.y) / grid.cellM));
  let best = Infinity;
  for (let row = rowLo; row <= rowHi; row++) {
    for (let col = colLo; col <= colHi; col++) {
      const ign = ignitionMin[row * n + col];
      if (ign < 0 || ign >= best) continue;
      const c = cellCenter(grid, col, row);
      const dx = c.x - xy.x;
      const dy = c.y - xy.y;
      if (dx * dx + dy * dy <= r2) best = ign;
    }
  }
  return best;
}
