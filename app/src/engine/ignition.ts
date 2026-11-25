// Suggests three drill ignition points about 2 km from home, where wind and
// uphill slope would carry fire toward home and the start of the main route.
import type { FireGrid, Wind, XY } from './types';
import { bearingDeg, compassName, dist, pointSegmentDistance, polylineLength, samplePolyline, windToVector } from './geo';
import { cellOf, isInGrid, waterMask } from './fire';

export interface IgnitionSuggestion {
  xy: XY;
  label: string;
  reason: string;
}

export const IGNITION_CONSTANTS = {
  bearingStepDeg: 15,
  radiiM: [1600, 2000, 2400],
  /** Candidates must be at least this far inside the fire grid edge. */
  edgeMarginM: 300,
  /** Only the first stretch of the main route is a target. */
  routeStretchM: 2000,
  maxRouteSamples: 5,
  /** Wind term = (speedMph / windRefMph) * cos(angle). */
  windRefMph: 20,
  /** Slope term = clamp(rise / run * slopeGain, -1, 1). */
  slopeGain: 10,
  minSeparationDeg: 60,
  /** A fire lit on a road closes it at minute 0, which teaches nothing; keep this far from every route. */
  minRouteClearanceM: 800,
  count: 3,
  /** A term must exceed this mean to be named in the reason. */
  reasonThreshold: 0.1,
  /** Land share needed among the cells within landRadiusCells of a pick, so the fire has fuel to run. */
  minLandShare: 0.5,
  landRadiusCells: 2,
} as const;

/** Whether a picked point can start a drill fire: inside the grid and on land (not sea). */
export type IgnitionPointCheck = 'ok' | 'outside' | 'water';

/** For the UI: refuse a picked point outside the fire area or on the sea. Lakes and rivers are not detected. */
export function checkIgnitionPoint(grid: FireGrid, elevationPerCell: Float32Array | null, xy: XY): IgnitionPointCheck {
  if (!isInGrid(grid, xy)) return 'outside';
  const mask = waterMask(elevationPerCell);
  const c = cellOf(grid, xy);
  if (mask && c && mask[c.row * grid.size + c.col] === 1) return 'water';
  return 'ok';
}

/** Share of land cells within radius cells of (col, row), counting only cells inside the grid. */
function landShare(grid: FireGrid, mask: Uint8Array, col: number, row: number, radius: number): number {
  let land = 0;
  let total = 0;
  for (let r = row - radius; r <= row + radius; r++) {
    for (let k = col - radius; k <= col + radius; k++) {
      if (r < 0 || k < 0 || r >= grid.size || k >= grid.size) continue;
      total++;
      if (mask[r * grid.size + k] === 0) land++;
    }
  }
  return total === 0 ? 0 : land / total;
}

interface Candidate {
  xy: XY;
  bearing: number;
  radius: number;
  score: number;
  homeScore: number;
  routeScore: number | null;
  wind: number;
  slope: number;
  mostlyLand: boolean;
}

export function suggestIgnitions(
  fireGrid: FireGrid,
  elevationPerCell: Float32Array | null,
  wind: Wind,
  homeXY: XY,
  mainRouteShape: XY[],
  /** Other route shapes (e.g. the backup) to keep clear of, besides the main route. */
  otherRouteShapes: XY[][] = [],
): IgnitionSuggestion[] {
  const C = IGNITION_CONSTANTS;
  const routeTargets = routeSamples(mainRouteShape);
  const elevAt = (p: XY) => elevationAt(fireGrid, elevationPerCell, p);
  const windTo = windToVector(wind.fromDeg);
  const windWeight = Math.max(0, wind.speedMph) / C.windRefMph;
  const water = elevationPerCell && elevationPerCell.length === fireGrid.size * fireGrid.size ? waterMask(elevationPerCell) : null;

  const termsFor = (from: XY, target: XY) => {
    const d = dist(from, target);
    if (d < 1e-6) return { wind: 0, slope: 0 };
    // cos(angle) between wind-to vector and the from->target unit vector.
    const cos = (windTo.x * (target.x - from.x) + windTo.y * (target.y - from.y)) / d;
    let slope = 0;
    if (elevationPerCell) {
      const rise = elevAt(target) - elevAt(from);
      slope = clamp((rise / d) * C.slopeGain, -1, 1);
    }
    return { wind: windWeight * cos, slope };
  };

  const candidates: Candidate[] = [];
  for (const radius of C.radiiM) {
    for (let bearing = 0; bearing < 360; bearing += C.bearingStepDeg) {
      const rad = (bearing * Math.PI) / 180;
      const xy = { x: homeXY.x + radius * Math.sin(rad), y: homeXY.y + radius * Math.cos(rad) };
      if (!insideGrid(fireGrid, xy, C.edgeMarginM)) continue;
      if ([mainRouteShape, ...otherRouteShapes].some((shape) => distToPolyline(xy, shape) < C.minRouteClearanceM)) continue;
      // Never on the sea. Prefer points with mostly land around them, so the fire has fuel.
      let mostlyLand = true;
      if (water) {
        const cell = cellOf(fireGrid, xy);
        if (!cell || water[cell.row * fireGrid.size + cell.col] === 1) continue;
        mostlyLand = landShare(fireGrid, water, cell.col, cell.row, C.landRadiusCells) >= C.minLandShare;
      }

      const home = termsFor(xy, homeXY);
      const route = routeTargets.map((t) => termsFor(xy, t));
      const all = [home, ...route];
      const windMean = mean(all.map((t) => t.wind));
      const slopeMean = mean(all.map((t) => t.slope));
      candidates.push({
        xy,
        bearing,
        radius,
        score: windMean + slopeMean,
        homeScore: home.wind + home.slope,
        routeScore: route.length ? mean(route.map((t) => t.wind + t.slope)) : null,
        wind: windMean,
        slope: slopeMean,
        mostlyLand,
      });
    }
  }

  // Highest score first; ties broken by bearing then radius so the order is stable.
  candidates.sort((a, b) => b.score - a.score || a.bearing - b.bearing || a.radius - b.radius);

  // Mostly-land points first; points on a narrow strip of land only fill the remaining slots.
  const picked: Candidate[] = [];
  for (const pass of [true, false]) {
    for (const c of candidates) {
      if (picked.length >= C.count) break;
      if (c.mostlyLand !== pass) continue;
      if (picked.every((p) => angleBetween(p.bearing, c.bearing) >= C.minSeparationDeg)) picked.push(c);
    }
  }

  return picked.map((c) => ({
    xy: c.xy,
    label: `${(dist(homeXY, c.xy) / 1000).toFixed(1)} km ${compassName(bearingDeg(homeXY, c.xy))}`,
    reason: reasonFor(c),
  }));
}

function distToPolyline(p: XY, shape: XY[]): number {
  if (shape.length === 1) return dist(p, shape[0]);
  let best = Infinity;
  for (let i = 1; i < shape.length; i++) best = Math.min(best, pointSegmentDistance(p, shape[i - 1], shape[i]));
  return best;
}

/** Up to maxRouteSamples evenly spaced points on the route's first routeStretchM. */
function routeSamples(shape: XY[]): XY[] {
  const C = IGNITION_CONSTANTS;
  if (shape.length === 0) return [];
  const stretch = truncatePolyline(shape, C.routeStretchM);
  const len = polylineLength(stretch);
  if (len < 1e-6) return [{ ...stretch[0] }];
  return samplePolyline(stretch, len / (C.maxRouteSamples - 1)).slice(0, C.maxRouteSamples);
}

function truncatePolyline(pts: XY[], maxM: number): XY[] {
  const out: XY[] = [pts[0]];
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (walked + seg >= maxM) {
      const t = seg > 0 ? (maxM - walked) / seg : 0;
      const a = pts[i - 1];
      const b = pts[i];
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      return out;
    }
    walked += seg;
    out.push(pts[i]);
  }
  return out;
}

function reasonFor(c: Candidate): string {
  const T = IGNITION_CONSTANTS.reasonThreshold;
  const parts: string[] = [];
  if (c.wind > T) parts.push('upwind');
  if (c.slope > T) parts.push('downhill');
  if (parts.length === 0) return 'Little wind or slope pushes fire from here; a test of a slower fire';

  let target = 'your home';
  if (c.routeScore !== null) {
    if (c.routeScore > c.homeScore + T) target = 'your route';
    else if (Math.abs(c.routeScore - c.homeScore) <= T) target = 'your home and route';
  }
  const phrase = parts.join(' and ');
  return `${phrase[0].toUpperCase()}${phrase.slice(1)} of ${target}`;
}

/** Elevation of the cell containing p, clamped to the grid edge for points outside it. */
function elevationAt(grid: FireGrid, elev: Float32Array | null, p: XY): number {
  if (!elev) return 0;
  const clamped = {
    x: clamp(p.x, grid.originXY.x, grid.originXY.x + grid.size * grid.cellM - 1e-6),
    y: clamp(p.y, grid.originXY.y, grid.originXY.y + grid.size * grid.cellM - 1e-6),
  };
  const cell = cellOf(grid, clamped);
  if (!cell) return 0;
  return elev[cell.row * grid.size + cell.col] ?? 0;
}

function insideGrid(grid: FireGrid, p: XY, marginM: number): boolean {
  const extent = grid.size * grid.cellM;
  return (
    p.x >= grid.originXY.x + marginM &&
    p.x <= grid.originXY.x + extent - marginM &&
    p.y >= grid.originXY.y + marginM &&
    p.y <= grid.originXY.y + extent - marginM
  );
}

/** Smallest angle between two bearings, in [0, 180]. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
