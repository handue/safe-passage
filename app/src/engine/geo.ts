// Geometry helpers in local meters. x = east of home, y = north of home.
import type { LatLon, Projection, XY } from './types';

const METERS_PER_DEG_LAT = 111320;

/** Local equirectangular projection around `origin`. Accurate to well under a meter within ~10 km. */
export function makeProjection(origin: LatLon): Projection {
  const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    origin,
    toXY(p: LatLon): XY {
      return {
        x: (p.lon - origin.lon) * metersPerDegLon,
        y: (p.lat - origin.lat) * METERS_PER_DEG_LAT,
      };
    },
    toLatLon(p: XY): LatLon {
      return {
        lat: origin.lat + p.y / METERS_PER_DEG_LAT,
        lon: origin.lon + p.x / metersPerDegLon,
      };
    },
  };
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Shortest distance from point p to the segment a-b. */
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(p, a);
  // Project p onto the line, clamp to the segment.
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Closest point to p on the polyline (any vertex or segment). Empty polyline returns a copy of p. */
export function nearestPointOnPolyline(p: XY, pts: XY[]): XY {
  if (pts.length === 0) return { x: p.x, y: p.y };
  let best: XY = { x: pts[0].x, y: pts[0].y };
  let bestD = dist(p, best);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(p, q);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

export function polylineLength(pts: XY[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  return total;
}

/**
 * Points every `stepM` meters along the polyline, measured from the start.
 * Always includes the first and last point. stepM <= 0 returns a copy of the input.
 */
export function samplePolyline(pts: XY[], stepM: number): XY[] {
  if (pts.length === 0) return [];
  if (pts.length === 1 || !(stepM > 0)) return pts.map((p) => ({ x: p.x, y: p.y }));

  const out: XY[] = [{ x: pts[0].x, y: pts[0].y }];
  let nextAt = stepM; // distance along the line of the next sample
  let walked = 0; // distance along the line at the start of the current segment
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    while (nextAt < walked + segLen) {
      const t = (nextAt - walked) / segLen;
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      nextAt += stepM;
    }
    walked += segLen;
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  // Avoid a near-duplicate end point when the length is a multiple of stepM.
  if (out.length === 1 || dist(prev, last) > 1e-9) out.push({ x: last.x, y: last.y });
  else out[out.length - 1] = { x: last.x, y: last.y };
  return out;
}

/** Compass bearing from `from` to `to`: 0 = north, 90 = east, clockwise, in [0, 360). */
export function bearingDeg(from: XY, to: XY): number {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return normalizeDeg(deg);
}

const COMPASS_8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** 8-point compass name for a bearing in degrees (any value, wrapped). */
export function compassName(deg: number): string {
  const idx = Math.round(normalizeDeg(deg) / 45) % 8;
  return COMPASS_8[idx];
}

/** Unit vector of where the wind blows TO, given the meteorological FROM direction. */
export function windToVector(fromDeg: number): XY {
  const toRad = ((fromDeg + 180) * Math.PI) / 180;
  return { x: Math.sin(toRad), y: Math.cos(toRad) };
}

function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}
