// The drill map: real OpenStreetMap roads around home in local XY, terrain contours from the
// elevation grid, the sea, the simulated fire as model cells, routes, destinations and markers.
// Drawn as inline SVG. The view is the fire grid square plus a little padding; on a frame wider
// than tall, the view grows sideways so roads and terrain fill the whole frame.
//
// Labels are placed by layoutMap(): marker boxes are reserved first, then each label tries a few
// spots next to its own point and is shortened or left out rather than drawn over anything else.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { contours } from 'd3-contour';
import type { DrillRun } from '../engine/drill';
import type { PreparedArea } from '../engine/area';
import type { Destination, Route, Wind, XY } from '../engine/types';
import type { IgnitionSuggestion } from '../engine/ignition';
import { compassName, dist } from '../engine/geo';
import { isInGrid, waterMask, WATER_MAX_ELEV_M } from '../engine/fire';
import '../styles/map.css';

export type RouteStyle = 'main' | 'backup' | 'closed' | 'unused';
/** Distance and wind units on the map. Miles and mph by default. */
export type MapUnits = 'mi' | 'km';

export interface MapViewProps {
  prepared: PreparedArea;
  /** Which routes to draw and how. Omitted routes are drawn as ordinary roads. */
  routes?: { which: 'main' | 'backup'; style: RouteStyle; label?: string }[];
  /** Simulated fire to draw, and the minute to draw it at (cells ignited at or before this minute). */
  fire?: { run: DrillRun; minute: number } | null;
  /** Closure marker: where and when a road closes. */
  closure?: { xy: XY; label: string } | null;
  wind?: Wind | null;
  /** Show elevation contours. Default true. */
  terrain?: boolean;
  /** Drill setup: suggestions to show, the selected ignition, and a click handler to pick a point. */
  ignition?: { suggestions: IgnitionSuggestion[]; selected: XY | null; onPick: (xy: XY) => void } | null;
  /** Extra labels, e.g. "Before: T+33, after it closed". */
  notes?: { xy: XY; text: string; tone: 'short' | 'route' | 'plain' }[];
  /** Visible size cap. "full" fills the stage, "short" for secondary maps. */
  size?: 'full' | 'short';
  ariaLabel: string;
  /** Optional: let the fire front breathe (the one authored motion, only while a drill runs). */
  animate?: boolean;
  /** Optional caption drawn in a corner, e.g. "Fire shown at T+28, when you pass". */
  fireCaption?: string | null;
  /** Units for distances and wind speed on the map. Default "mi" (miles, mph). */
  units?: MapUnits;
  /**
   * Reference only, never part of the drill: real current fire perimeters (rings in local XY)
   * and satellite heat detections, drawn in their own color and pattern.
   */
  reference?: RefLayer | null;
  /** Optional: told how many reference perimeters and detections are actually drawn in view (null when none is given). */
  onReferenceDrawn?: (drawn: { perimeters: number; detections: number } | null) => void;
}

export interface RefLayer {
  /** Each perimeter is a list of rings (even-odd fill, so holes stay open). */
  perimeters: XY[][][];
  detections: XY[];
}

export const REF_PERIMETER_LABELS = ['Current fire perimeter (NIFC)', 'Fire perimeter (NIFC)', 'NIFC perimeter'];

// ---------- View geometry ----------

/** viewBox side in SVG units. Sizes on screen are converted with `u` (units per CSS pixel). */
const VB = 1000;
const PAD_FRACTION = 0.06;
const LABEL_PX = 14;
const DEST_PX = 13;
const TEXT_STROKE_PX = 4;
const CONTOUR_STEP_M = 20;
const MAX_CONTOUR_LEVELS = 40;
const MAX_NAME_CHARS = 28;
const SHORT_NAME_CHARS = 16;
/** Road names shown per route, longest stretches first, and the shortest stretch worth a name. */
const ROAD_NAMES_PER_ROUTE = 3;
const MIN_NAMED_RUN_M = 300;
const METERS_PER_MILE = 1609.344;
const KMH_PER_MPH = 1.609344;

// Marker sizes in CSS pixels (multiplied by `u` for SVG units).
const HOME_R = 18;
const DEST_R = 15;
const CLOSURE_R = 20;
const IG_R = 28;
/** Off-map destination markers sit this far inside the frame edge, with the arrow beyond them. */
const EDGE_INSET_PX = 36;
/** The "Map data © OpenStreetMap contributors" credit box in the bottom-right corner. */
const CREDIT_W_PX = 236;
const CREDIT_H_PX = 26;

export interface View {
  minX: number;
  maxY: number;
  spanM: number;
  k: number; // SVG units per meter
  /** Extra SVG units drawn on each side of the square (0 on a square or tall frame). */
  ex: number;
}

export function makeView(prepared: PreparedArea, aspect: number): View {
  const g = prepared.fireGrid;
  const extent = g.cellM * g.size;
  const pad = extent * PAD_FRACTION;
  const spanM = extent + 2 * pad;
  return { minX: g.originXY.x - pad, maxY: g.originXY.y + extent + pad, spanM, k: VB / spanM, ex: Math.max(0, (VB * aspect - VB) / 2) };
}

/** Left and right edges of the drawn frame in SVG units. */
const frameX0 = (v: View) => -v.ex;
const frameX1 = (v: View) => VB + v.ex;

const sx = (v: View, x: number) => (x - v.minX) * v.k;
const sy = (v: View, y: number) => (v.maxY - y) * v.k;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** True when the point lies inside the whole drawn frame (the square plus any sideways extension). */
export function inFrame(v: View, p: XY, insetM = 0): boolean {
  const exM = v.ex / v.k;
  return (
    p.x >= v.minX - exM + insetM &&
    p.x <= v.minX + v.spanM + exM - insetM &&
    p.y <= v.maxY - insetM &&
    p.y >= v.maxY - v.spanM + insetM
  );
}

function shapeTouchesView(v: View, shape: XY[]): boolean {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of shape) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  const exM = v.ex / v.k;
  return x1 >= v.minX - exM && x0 <= v.minX + v.spanM + exM && y1 >= v.maxY - v.spanM && y0 <= v.maxY;
}

function polyD(v: View, shape: XY[]): string {
  if (shape.length === 0) return '';
  let d = `M${r1(sx(v, shape[0].x))} ${r1(sy(v, shape[0].y))}`;
  for (let i = 1; i < shape.length; i++) d += `L${r1(sx(v, shape[i].x))} ${r1(sy(v, shape[i].y))}`;
  return d;
}

/** Point a fraction t (0..1) of the way along a polyline. */
function pointAlong(shape: XY[], t: number): XY {
  let total = 0;
  for (let i = 1; i < shape.length; i++) total += dist(shape[i - 1], shape[i]);
  const target = total * t;
  let walked = 0;
  for (let i = 1; i < shape.length; i++) {
    const seg = dist(shape[i - 1], shape[i]);
    if (walked + seg >= target && seg > 0) {
      const f = (target - walked) / seg;
      const a = shape[i - 1];
      const b = shape[i];
      return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) };
    }
    walked += seg;
  }
  return shape[shape.length - 1] ?? { x: 0, y: 0 };
}

function routeShape(prepared: PreparedArea, route: Route): XY[] {
  const pts: XY[] = [];
  for (const eid of route.edgeIds) {
    const s = prepared.graph.edges[eid].shape;
    pts.push(...(pts.length ? s.slice(1) : s));
  }
  return pts;
}

// ---------- Units ----------

/** "6.3 mi" or "12 km": one decimal under 10, whole numbers above. */
export function fmtDistance(m: number, units: MapUnits): string {
  const v = units === 'km' ? m / 1000 : m / METERS_PER_MILE;
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units}`;
}

function windSpeed(w: Wind, units: MapUnits): string {
  return units === 'km' ? `${Math.round(w.speedMph * KMH_PER_MPH)} km/h` : `${Math.round(w.speedMph)} mph`;
}

function windText(w: Wind, units: MapUnits): string {
  return `Wind from ${compassName(w.fromDeg)} ${windSpeed(w, units)}`;
}

// ---------- Roads ----------

function roadClass(highway: string): 'hwy' | 'road mid' | 'road minor' {
  const h = highway.replace(/_link$/, '');
  if (h === 'motorway' || h === 'trunk' || h === 'primary') return 'hwy';
  if (h === 'secondary' || h === 'tertiary') return 'road mid';
  return 'road minor';
}

function roadPaths(prepared: PreparedArea, v: View): { cls: string; d: string }[] {
  const seen = new Set<string>();
  const byClass: Record<string, string[]> = { 'road minor': [], 'road mid': [], hwy: [] };
  for (const e of prepared.graph.edges) {
    const key = `${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}-${Math.round(e.lengthM)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!shapeTouchesView(v, e.shape)) continue;
    byClass[roadClass(e.highway)].push(polyD(v, e.shape));
  }
  return ['road minor', 'road mid', 'hwy'].map((cls) => ({ cls, d: byClass[cls].join('') })).filter((p) => p.d);
}

// ---------- Terrain and sea ----------

/** d3 closes every ring along the grid border; those border pieces are not real lines. */
const onSameBorder = (n: number, a: number[], b: number[]) =>
  (a[0] <= 0 && b[0] <= 0) || (a[0] >= n && b[0] >= n) || (a[1] <= 0 && b[1] <= 0) || (a[1] >= n && b[1] >= n);

function gridToSvg(prepared: PreparedArea, v: View) {
  const g = prepared.fireGrid;
  return (cx: number, cy: number) => `${r1(sx(v, g.originXY.x + cx * g.cellM))} ${r1(sy(v, g.originXY.y + cy * g.cellM))}`;
}

/** Open path of a d3 ring, leaving out the pieces that run along the grid border. */
function ringLines(ring: number[][], n: number, toSvg: (cx: number, cy: number) => string): string {
  let d = '';
  let pen = false;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1];
    const b = ring[i];
    if (onSameBorder(n, a, b)) {
      pen = false;
      continue;
    }
    if (!pen) d += 'M' + toSvg(a[0], a[1]);
    d += 'L' + toSvg(b[0], b[1]);
    pen = true;
  }
  return d;
}

function contourPaths(prepared: PreparedArea, v: View): { d: string; major: boolean }[] {
  const elev = prepared.elevationPerCell;
  const g = prepared.fireGrid;
  if (!elev || elev.length !== g.size * g.size) return [];
  let lo = Infinity, hi = -Infinity;
  for (const e of elev) {
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  if (!Number.isFinite(lo) || hi - lo < CONTOUR_STEP_M) return [];
  let step = CONTOUR_STEP_M;
  while ((hi - lo) / step > MAX_CONTOUR_LEVELS) step *= 2;
  const levels: number[] = [];
  for (let z = Math.ceil(lo / step) * step; z < hi; z += step) levels.push(z);
  const majorStep = step * 5;

  // d3-contour reads the grid row by row; our row 0 is south, so its y index is our row.
  const shapes = contours().size([g.size, g.size]).thresholds(levels)(Array.from(elev));
  const toSvg = gridToSvg(prepared, v);
  return shapes.map((mp) => {
    let d = '';
    for (const poly of mp.coordinates) for (const ring of poly) d += ringLines(ring, g.size, toSvg);
    return { d, major: Math.round(mp.value) % majorStep === 0 };
  });
}

export interface SeaLayer {
  /** Filled water area (even-odd rings). */
  fill: string;
  /** Coastline: the water edge, without the grid border. */
  coast: string;
  /** Places for the "Sea" label, in local XY, farthest from land first. */
  labelAt: XY[];
  /** True when the sea reaches the edge of the dashed square: elevation, and so the sea, stops there. */
  atEdge: boolean;
}

/**
 * Sea cells (elevation at or below WATER_MAX_ELEV_M) as a water layer with a coastline.
 * Null when there is no elevation data, no sea, or only sea (a failed elevation service).
 */
export function seaLayer(prepared: PreparedArea, v: View): SeaLayer | null {
  const elev = prepared.elevationPerCell;
  const g = prepared.fireGrid;
  const n = g.size;
  if (!elev || elev.length !== n * n) return null;
  const mask = waterMask(elev);
  if (!mask) return null;

  // Contour of the negated elevation: inside where -elev >= -limit, so where elev <= limit.
  const [shape] = contours().size([n, n]).thresholds([-WATER_MAX_ELEV_M])(Array.from(elev, (e) => -e));
  const toSvg = gridToSvg(prepared, v);
  let fill = '';
  let coast = '';
  for (const poly of shape?.coordinates ?? []) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      fill += 'M' + ring.map((p) => toSvg(p[0], p[1])).join('L') + 'Z';
      coast += ringLines(ring, n, toSvg);
    }
  }
  if (!fill) return null;

  // Steps from the nearest land cell, by breadth-first search; open water is farthest from land.
  const far = new Int32Array(n * n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < n * n; i++) if (!mask[i]) {
    far[i] = 0;
    queue.push(i);
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const col = i % n;
    const row = (i - col) / n;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= n || r >= n) continue;
      const j = r * n + c;
      if (far[j] >= 0) continue;
      far[j] = far[i] + 1;
      queue.push(j);
    }
  }
  const sea: number[] = [];
  for (let i = 0; i < n * n; i++) if (mask[i] && far[i] >= 2) sea.push(i);
  sea.sort((a, b) => far[b] - far[a] || a - b);
  const labelAt: XY[] = [];
  for (const i of sea) {
    if (labelAt.length >= 16) break;
    const col = i % n;
    const row = (i - col) / n;
    const p = { x: g.originXY.x + (col + 0.5) * g.cellM, y: g.originXY.y + (row + 0.5) * g.cellM };
    if (labelAt.every((o) => dist(o, p) >= 3 * g.cellM)) labelAt.push(p);
  }
  let atEdge = false;
  for (let i = 0; i < n && !atEdge; i++) atEdge = !!(mask[i] || mask[(n - 1) * n + i] || mask[i * n] || mask[i * n + n - 1]);
  return { fill, coast, labelAt, atEdge };
}

// ---------- Fire ----------

interface FirePaths {
  burned: string;
  hatch: string;
  ember: string;
  front: string;
  hot: string;
  glow: string;
  centroid: XY | null;
}

function firePaths(run: DrillRun, minute: number, v: View): FirePaths {
  const { grid, ignitionMin, burnMinutes } = run.fire;
  const n = grid.size;
  const cs = grid.cellM * v.k;
  const gap = cs * 0.08;
  const w = r1(cs - gap);
  const out = { burned: '', hatch: '', ember: '', front: '', hot: '', glow: '' };
  let cx = 0, cy = 0, count = 0;
  for (let i = 0; i < ignitionMin.length; i++) {
    const ign = ignitionMin[i];
    if (ign < 0 || minute < ign) continue;
    const col = i % n;
    const row = (i - col) / n;
    const x = r1(sx(v, grid.originXY.x + col * grid.cellM) + gap / 2);
    const y = r1(sy(v, grid.originXY.y + (row + 1) * grid.cellM) + gap / 2);
    const rect = `M${x} ${y}h${w}v${w}h${-w}Z`;
    const age = minute - ign;
    cx += col;
    cy += row;
    count++;
    if (age < burnMinutes) {
      if (age < burnMinutes / 6) out.hot += rect;
      else out.front += rect;
      const gx = r1(x - cs * 0.6);
      const gy = r1(y - cs * 0.6);
      const gw = r1(w + cs * 1.2);
      out.glow += `M${gx} ${gy}h${gw}v${gw}h${-gw}Z`;
    } else if (age < burnMinutes + 10) {
      out.ember += rect;
    } else {
      out.burned += rect;
      out.hatch += `M${r1(x + w * 0.1)} ${r1(y + w * 0.9)}l${r1(w * 0.8)} ${r1(-w * 0.8)}`;
    }
  }
  const centroid = count
    ? { x: grid.originXY.x + (cx / count + 0.5) * grid.cellM, y: grid.originXY.y + (cy / count + 0.5) * grid.cellM }
    : null;
  return { ...out, centroid };
}

// ---------- Destinations ----------

export interface DestMark {
  id: string;
  /** "D1" */
  code: string;
  /** Name shown on the map, already shortened. */
  name: string;
  /** True when the real destination point is inside the frame and the marker sits on it. */
  onMap: boolean;
  /** Marker position in SVG units. */
  x: number;
  y: number;
  /** For an off-map marker: unit vector (SVG units) pointing to where the route leaves the view. */
  dir: XY | null;
  /** An exit point: a road leaving the area, labelled the same on every map and never "(candidate)". */
  exit?: boolean;
  /** Distance from home along the route (straight line when there is no route), in meters. */
  awayM: number;
}

/** Cut a name at a word boundary to at most max characters, ending with "…". */
export function shortName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:(–-]+$/, '') + '…';
}

const ROAD_ABBR: [RegExp, string][] = [
  [/\bHighway\b/g, 'Hwy'], [/\bRoad\b/g, 'Rd'], [/\bAvenue\b/g, 'Ave'], [/\bStreet\b/g, 'St'], [/\bDrive\b/g, 'Dr'],
  [/\bBoulevard\b/g, 'Blvd'], [/\bParkway\b/g, 'Pkwy'], [/\bFreeway\b/g, 'Fwy'], [/\bLane\b/g, 'Ln'],
];

/** "Pacific Coast Highway" -> "Pacific Coast Hwy", so an exit label fits every map the same way. */
export function abbreviateRoad(name: string): string {
  return ROAD_ABBR.reduce((t, [re, short]) => t.replace(re, short), name);
}

/** Map name for a destination: an exit point reads "<road> exit", with the road type abbreviated. */
export function mapName(d: Destination): string {
  const m = /^where (.+) leaves the area$/.exec(d.name);
  if (m) return m[1] === 'an unnamed road' ? 'Unnamed road exit' : `${abbreviateRoad(m[1])} exit`;
  return d.name;
}

const unit = (p: XY): XY => {
  const l = Math.hypot(p.x, p.y);
  return l > 0 ? { x: p.x / l, y: p.y / l } : { x: 1, y: 0 };
};

/** Bisect between an inside point a and an outside point b for the frame boundary (inset). */
function edgeBetween(v: View, a: XY, b: XY, insetM: number): XY {
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const p = { x: a.x + m * (b.x - a.x), y: a.y + m * (b.y - a.y) };
    if (inFrame(v, p, insetM)) lo = m;
    else hi = m;
  }
  return { x: a.x + lo * (b.x - a.x), y: a.y + lo * (b.y - a.y) };
}

/**
 * Where to draw an off-map destination: on the inset frame edge where its route last leaves the
 * view, with the direction the route goes on. Without a usable route, toward the destination.
 */
export function edgeExit(v: View, shape: XY[], from: XY, to: XY, insetM: number): { at: XY; dirM: XY } {
  let i = shape.length - 1;
  while (i >= 0 && !inFrame(v, shape[i], insetM)) i--;
  if (i >= 0 && i < shape.length - 1) {
    const a = shape[i];
    const b = shape[i + 1];
    return { at: edgeBetween(v, a, b, insetM), dirM: unit({ x: b.x - a.x, y: b.y - a.y }) };
  }
  const start = inFrame(v, from, insetM) ? from : { x: v.minX + v.spanM / 2, y: v.maxY - v.spanM / 2 };
  return { at: edgeBetween(v, start, to, insetM), dirM: unit({ x: to.x - start.x, y: to.y - start.y }) };
}

/** Markers for the destinations of the drawn routes (both routes when none are given). */
export function destMarks(prepared: PreparedArea, v: View, u: number, routes: MapViewProps['routes'] = []): DestMark[] {
  const { waysOut, homeXY } = prepared;
  const destRoutes = routes.length ? routes.map((r) => (r.which === 'main' ? waysOut.main : waysOut.backup)) : [waysOut.main, waysOut.backup];
  const destIds = [...new Set(destRoutes.map((r) => r?.destinationId).filter(Boolean))] as string[];
  const insetM = (EDGE_INSET_PX * u) / v.k;
  const marks: DestMark[] = [];
  for (const id of destIds) {
    const d = waysOut.destinations.find((x) => x.id === id);
    if (!d) continue;
    const route = waysOut.main?.destinationId === id ? waysOut.main : waysOut.backup?.destinationId === id ? waysOut.backup : null;
    const awayM = route ? route.lengthM : dist(homeXY, d.xy);
    const code = d.label.split(' ')[0] || 'D';
    const name = shortName(mapName(d), MAX_NAME_CHARS);
    const exit = d.kind === 'exit_point';
    // Inside the frame (with room for the marker): drawn on the real point.
    if (inFrame(v, d.xy, (DEST_R * u) / v.k)) {
      marks.push({ id, code, name, onMap: true, x: sx(v, d.xy.x), y: sy(v, d.xy.y), dir: null, awayM, exit });
      continue;
    }
    const { at, dirM } = edgeExit(v, route ? routeShape(prepared, route) : [], homeXY, d.xy, insetM);
    marks.push({ id, code, name, onMap: false, x: sx(v, at.x), y: sy(v, at.y), dir: { x: dirM.x, y: -dirM.y }, awayM, exit });
  }
  return marks;
}

// ---------- Label placement ----------

export interface Box { x0: number; y0: number; x1: number; y1: number }
type Anchor = 'start' | 'middle' | 'end';
export interface Label { x: number; y: number; text: string; anchor: Anchor; cls: string; box: Box }
interface Spot { x: number; y: number; anchor: Anchor }

export const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const square = (x: number, y: number, r: number): Box => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });

/** Average glyph width as a share of the font size (bold, spaced capitals run wider). */
function charWidth(text: string, cls: string): number {
  if (cls.includes('t-fire')) return text === text.toUpperCase() ? 0.74 : 0.64;
  if (cls.includes('t-closed') || cls.includes('t-route') || cls.includes('t-ref')) return 0.58;
  return 0.56;
}

/** True when the segment a-b passes through the box (Liang-Barsky clipping). */
export function segHitsBox(a: XY, b: XY, r: Box): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x0, r.x1 - a.x, a.y - r.y0, r.y1 - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/** True when any segment of any line passes through the box. */
export function boxCrossesLines(b: Box, lines: XY[][]): boolean {
  for (const pts of lines) for (let i = 1; i < pts.length; i++) if (segHitsBox(pts[i - 1], pts[i], b)) return true;
  return false;
}

function insideRings(rings: XY[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/**
 * The visible part of each reference perimeter as grid cells of size g (SVG units) inside the
 * frame x0..x1, 0..VB: cells whose center is inside the shape (even-odd) or that its edge crosses.
 * Used to keep labels off the perimeters and to put the perimeter label next to what is visible.
 */
export function refAreaCells(perimeters: XY[][][], x0: number, x1: number, g: number): Box[][] {
  const cols = Math.ceil((x1 - x0) / g);
  const rows = Math.ceil(VB / g);
  return perimeters.map((rings) => {
    const hit = new Set<number>();
    const mark = (x: number, y: number) => {
      const i = Math.floor((x - x0) / g);
      const j = Math.floor(y / g);
      if (i >= 0 && i < cols && j >= 0 && j < rows) hit.add(j * cols + i);
    };
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % ring.length];
        bx0 = Math.min(bx0, a.x); bx1 = Math.max(bx1, a.x); by0 = Math.min(by0, a.y); by1 = Math.max(by1, a.y);
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g / 2)));
        for (let t = 0; t < n; t++) mark(a.x + ((b.x - a.x) * t) / n, a.y + ((b.y - a.y) * t) / n);
      }
    }
    const i0 = Math.max(0, Math.floor((bx0 - x0) / g));
    const i1 = Math.min(cols - 1, Math.floor((bx1 - x0) / g));
    const j0 = Math.max(0, Math.floor(by0 / g));
    const j1 = Math.min(rows - 1, Math.floor(by1 / g));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!hit.has(j * cols + i) && insideRings(rings, x0 + (i + 0.5) * g, (j + 0.5) * g)) hit.add(j * cols + i);
      }
    }
    return [...hit].sort((a, b) => a - b).map((key) => {
      const i = key % cols;
      const j = Math.floor(key / cols);
      return { x0: x0 + i * g, y0: j * g, x1: x0 + (i + 1) * g, y1: (j + 1) * g };
    });
  });
}

/** Cell size (CSS px) for the reference perimeter collision grid. */
const REF_CELL_PX = 16;
/** A perimeter with less than this much visible area (in CSS px squared) gets no label. */
const REF_LABEL_MIN_PX2 = 1600;
/** Perimeters covering more than this share of the frame are not kept clear of labels (labels have halos). */
const REF_RESERVE_MAX_SHARE = 0.35;

export class Placer {
  markers: Box[] = [];
  labels: Box[] = [];
  /** Areas labels keep off (the reference perimeters); drawn under the labels. */
  areas: Box[] = [];
  fs: number;
  x0: number;
  x1: number;
  pad: number;
  constructor(fs: number, x0: number, x1: number, pad: number) {
    this.fs = fs;
    this.x0 = x0;
    this.x1 = x1;
    this.pad = pad;
  }
  /** True when the box lies inside the frame. */
  fits(b: Box): boolean {
    return b.x0 >= this.x0 + 4 && b.x1 <= this.x1 - 4 && b.y0 >= 4 && b.y1 <= VB - 4;
  }
  free(b: Box, withAreas = true): boolean {
    return !this.markers.some((o) => overlaps(b, o)) && !this.labels.some((o) => overlaps(b, o)) && (!withAreas || !this.areas.some((o) => overlaps(b, o)));
  }
  box(x: number, y: number, text: string, anchor: Anchor, cls = ''): Box {
    const w = text.length * this.fs * charWidth(text, cls);
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    return { x0: x0 - this.pad, y0: y - this.fs * 0.95 - this.pad, x1: x0 + w + this.pad, y1: y + this.fs * 0.28 + this.pad };
  }
  marker(b: Box) {
    this.markers.push(b);
  }
  /** The first text and spot (texts in order, longest first) that fits without overlap, reserved. */
  place(spots: Spot[], texts: string[], cls: string, ok: (b: Box) => boolean = () => true, clampX = false): Label | null {
    for (const text of texts) {
      for (const s0 of spots) {
        let s = s0;
        if (clampX) {
          // Slide the label sideways to stay inside the frame (for labels tied to an area, not a point).
          const b0 = this.box(s0.x, s0.y, text, s0.anchor, cls);
          const dx = Math.max(0, this.x0 + 4 - b0.x0) - Math.max(0, b0.x1 - (this.x1 - 4));
          s = { ...s0, x: s0.x + dx };
        }
        const b = this.box(s.x, s.y, text, s.anchor, cls);
        if (this.fits(b) && this.free(b) && ok(b)) {
          this.labels.push(b);
          return { x: s.x, y: s.y, text, anchor: s.anchor, cls, box: b };
        }
      }
    }
    return null;
  }
}

/**
 * Spots around a marker of the given gap (marker radius plus a little): beside, above, below,
 * then the diagonals. `away` (SVG unit vector) puts spots on that side last.
 */
function spotsAround(x: number, y: number, gap: number, fs: number, away: XY | null, preferLeft = false): Spot[] {
  const mid = fs * 0.35;
  const d = gap * 0.85;
  const spots: (Spot & { dx: number; dy: number })[] = [
    { x: x + gap, y: y + mid, anchor: 'start', dx: 1, dy: 0 },
    { x: x - gap, y: y + mid, anchor: 'end', dx: -1, dy: 0 },
    { x, y: y - gap - fs * 0.3, anchor: 'middle', dx: 0, dy: -1 },
    { x, y: y + gap + fs * 0.95, anchor: 'middle', dx: 0, dy: 1 },
    { x: x + d, y: y - d, anchor: 'start', dx: 0.7, dy: -0.7 },
    { x: x - d, y: y - d, anchor: 'end', dx: -0.7, dy: -0.7 },
    { x: x + d, y: y + d + fs * 0.7, anchor: 'start', dx: 0.7, dy: 0.7 },
    { x: x - d, y: y + d + fs * 0.7, anchor: 'end', dx: -0.7, dy: 0.7 },
  ];
  if (preferLeft) [spots[0], spots[1]] = [spots[1], spots[0]];
  if (away) spots.sort((a, b) => a.dx * away.x + a.dy * away.y - (b.dx * away.x + b.dy * away.y));
  return spots.map(({ x: sx2, y: sy2, anchor }) => ({ x: sx2, y: sy2, anchor }));
}

/**
 * Where to draw the closure ring (SVG units). When it would sit on the Home ring, it moves out
 * along the line from home through the closure (or up and right when they coincide), to just
 * clear Home, and `moved` says to draw a leader line back to the real spot.
 */
export function closureMarkerAt(home: XY, closure: XY, u: number): { x: number; y: number; moved: boolean } {
  const clear = (HOME_R + CLOSURE_R + 6) * u;
  const dx = closure.x - home.x;
  const dy = closure.y - home.y;
  const d = Math.hypot(dx, dy);
  if (d >= clear) return { x: closure.x, y: closure.y, moved: false };
  const ux = d > 1e-6 ? dx / d : Math.SQRT1_2;
  const uy = d > 1e-6 ? dy / d : -Math.SQRT1_2;
  return { x: home.x + ux * clear, y: home.y + uy * clear, moved: true };
}

/** "Pacific Coast Highway closes T+36" -> "Closes T+36", for when the full label has no room. */
export function shortClosure(label: string): string | null {
  const m = /\b(closes|closed)\b(.*)$/.exec(label);
  if (!m) return null;
  const s = `${m[1]}${m[2]}`.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface LayoutInput {
  view: View;
  u: number;
  units: MapUnits;
  /** Home in SVG units. */
  home: XY;
  dests: DestMark[];
  closure: { x: number; y: number; label: string } | null;
  ignition: { points: XY[]; selected: { x: number; y: number; text: string; suggestion: boolean } | null } | null;
  /** undefined: no wind block. null: "Wind not set". */
  wind: Wind | null | undefined;
  caption: string | null;
  notes: { x: number; y: number; text: string; cls: string }[];
  /** Reference layer: the visible part of each in-view perimeter as cells (SVG units), nearest perimeter first. */
  refCells?: Box[][] | null;
  /** Drawn route lines in SVG units; the reference label never crosses them. */
  routeLines?: XY[][];
  cornerNotes: string[];
  /** Fire square in SVG units. */
  grid: { x: number; y: number; w: number };
  /** Spots for the "Sea" label in SVG units, best first. */
  sea: XY[];
  /** Route labels with the in-view part of the route, SVG units. */
  routeLabels: { text: string; cls: string; pts: XY[] }[];
  /** Road names with their longest in-view run, SVG units, most important first. */
  roadNames: { text: string; pts: XY[] }[];
  fireCentroid: XY | null;
}

export interface WindPlacement { ax: number; ay: number; arrow: boolean; text: Label | null }

export interface MapLayout {
  labels: Label[];
  wind: WindPlacement | null;
  caption: Label | null;
  /** All reserved marker boxes (for tests and debugging). */
  markers: Box[];
}

/**
 * Places every label on the map. Markers are reserved first; then labels in order of
 * importance: wind, caption, Home, closure, ignition, destinations, notes, sea, corner notes,
 * route labels, road names and the fire label. Each tries spots next to its own point and is
 * shortened or left out rather than drawn over another label or marker.
 */
export function layoutMap(input: LayoutInput): MapLayout {
  const { view, u, home } = input;
  const fs = LABEL_PX * u;
  const fx0 = frameX0(view);
  const fx1 = frameX1(view);
  const placer = new Placer(fs, fx0, fx1, (TEXT_STROKE_PX * u) / 2);
  const labels: Label[] = [];
  const push = (l: Label | null) => {
    if (l) labels.push(l);
    return l;
  };

  // 1. Markers, and the map credit in the bottom-right corner (an HTML overlay).
  placer.marker({ x0: fx1 - CREDIT_W_PX * u, y0: VB - CREDIT_H_PX * u, x1: fx1, y1: VB });
  placer.marker(square(home.x, home.y, HOME_R * u));
  for (const d of input.dests) {
    placer.marker(square(d.x, d.y, (DEST_R + 2) * u));
    if (d.dir) placer.marker(square(d.x + d.dir.x * 26 * u, d.y + d.dir.y * 26 * u, 8 * u));
  }
  if (input.closure) placer.marker(square(input.closure.x, input.closure.y, CLOSURE_R * u));
  if (input.ignition) {
    for (const p of input.ignition.points) placer.marker(square(p.x, p.y, IG_R * u));
    const s = input.ignition.selected;
    if (s && !s.suggestion) placer.marker(square(s.x, s.y, 26 * u));
  }
  // Reference perimeters: labels and the wind arrow keep off them, unless they cover much of the map.
  const refCells = input.refCells ?? [];
  const cellArea = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);
  const refArea = refCells.flat().reduce((sum, b) => sum + cellArea(b), 0);
  if (refArea > 0 && refArea <= REF_RESERVE_MAX_SHARE * (fx1 - fx0) * VB) placer.areas = refCells.flat();

  // 2. Wind: arrow and text in the top-right corner, else another corner. The bottom-right
  // corner holds the map credit, so it comes last.
  let wind: WindPlacement | null = null;
  if (input.wind !== undefined) {
    const text = input.wind ? windText(input.wind, input.units) : 'Wind not set';
    const arrow = !!input.wind;
    const credit = CREDIT_H_PX * u;
    const corners: { ax: number; ay: number; spot: Spot }[] = [
      { ax: fx1 - 40 * u, ay: 40 * u, spot: { x: fx1 - 12 * u, y: arrow ? 88 * u : 30 * u, anchor: 'end' } },
      { ax: fx0 + 40 * u, ay: 40 * u, spot: { x: fx0 + 12 * u, y: arrow ? 88 * u : 30 * u, anchor: 'start' } },
      { ax: fx0 + 40 * u, ay: VB - 12 * u - fs * 1.4 - 28 * u, spot: { x: fx0 + 12 * u, y: VB - 12 * u, anchor: 'start' } },
      { ax: fx1 - 40 * u, ay: VB - credit - 12 * u - fs * 1.4 - 28 * u, spot: { x: fx1 - 12 * u, y: VB - credit - 12 * u, anchor: 'end' } },
    ];
    for (const c of corners) {
      const ab = square(c.ax, c.ay, 26 * u);
      if (arrow && !placer.free(ab)) continue;
      const tb = placer.box(c.spot.x, c.spot.y, text, c.spot.anchor, 't-minor');
      if (!placer.fits(tb) || !placer.free(tb)) continue;
      if (arrow) placer.marker(ab);
      wind = { ax: c.ax, ay: c.ay, arrow, text: placer.place([c.spot], [text], 't-minor') };
      break;
    }
    if (!wind && arrow) {
      // No corner has room for the words: keep the arrow alone where it fits, off the perimeters if possible.
      const c = corners.find((k) => placer.free(square(k.ax, k.ay, 26 * u))) ?? corners.find((k) => placer.free(square(k.ax, k.ay, 26 * u), false));
      if (c) {
        placer.marker(square(c.ax, c.ay, 26 * u));
        wind = { ax: c.ax, ay: c.ay, arrow, text: null };
      }
    }
  }

  // 3. Fire minute caption, in a corner.
  let caption: Label | null = null;
  if (input.caption) {
    caption = placer.place(
      [
        { x: fx0 + 12 * u, y: VB - 12 * u, anchor: 'start' },
        { x: fx0 + 12 * u, y: 12 * u + fs, anchor: 'start' },
        { x: (fx0 + fx1) / 2, y: VB - 12 * u, anchor: 'middle' },
        { x: (fx0 + fx1) / 2, y: 12 * u + fs, anchor: 'middle' },
      ],
      [input.caption],
      't-cap',
    );
  }

  // 4. Home.
  push(placer.place(spotsAround(home.x, home.y, 22 * u, fs, null), ['Home'], ''));

  // 5. Closure: beside, above or below the ring; shortened to "Closes T+36" if the road name has no room.
  if (input.closure) {
    const c = input.closure;
    const short = shortClosure(c.label);
    const texts = short && short !== c.label ? [c.label, short] : [c.label];
    push(placer.place(spotsAround(c.x, c.y, (CLOSURE_R + 4) * u, fs, null, c.x > (fx0 + fx1) / 2), texts, 't-closed'));
  }

  // 6. Selected ignition point.
  const sel = input.ignition?.selected;
  if (sel) push(placer.place(spotsAround(sel.x, sel.y, (IG_R + 4) * u, fs, null), [sel.text, 'Ignition'], 't-fire'));

  // 7. Destinations, each next to its own marker. Off-map ones say how far away they are.
  for (const d of input.dests) {
    const away = d.onMap ? null : fmtDistance(d.awayM, input.units);
    const full = d.onMap ? `${d.name} (candidate)` : `${d.name}, ${away} away`;
    const brief = shortName(d.name, SHORT_NAME_CHARS);
    // Exit points keep their road name on every map ("Pacific Coast Hwy exit, 6.3 mi"), never "(candidate)".
    const all = d.exit
      ? d.onMap ? [d.name] : [`${d.name}, ${away}`, d.name]
      : d.onMap ? [full, `${brief} (candidate)`, brief] : [full, `${brief}, ${away} away`, `${away} away`];
    const texts = all.filter((t, i, a) => t && a.indexOf(t) === i);
    const preferLeft = d.x > fx0 + (fx1 - fx0) * 0.62;
    push(placer.place(spotsAround(d.x, d.y, (DEST_R + 6) * u, fs, d.dir, preferLeft), texts, 't-minor'));
  }

  // 8. Notes, near their point.
  for (const n of input.notes) {
    const spots = [...spotsAround(n.x, n.y, 24 * u, fs, null), ...spotsAround(n.x, n.y, 24 * u + fs * 1.4, fs, null)];
    push(placer.place(spots, [n.text], n.cls));
  }

  // 8b. Reference perimeter label (real fire, not the drill), right next to the visible part of
  // the nearest perimeter that shows enough of itself. Never across a route; left out when no spot fits.
  const labelled = refCells.find((cells) => cells.reduce((sum, b) => sum + cellArea(b), 0) >= REF_LABEL_MIN_PX2 * u * u);
  if (labelled) {
    const b = labelled.reduce((a, c) => ({ x0: Math.min(a.x0, c.x0), y0: Math.min(a.y0, c.y0), x1: Math.max(a.x1, c.x1), y1: Math.max(a.y1, c.y1) }));
    const gap = 6 * u;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2 + fs * 0.35;
    const below = b.y1 + gap + fs * 0.95;
    const above = b.y0 - gap - fs * 0.3;
    const spots: Spot[] = [
      { x: cx, y: below, anchor: 'middle' }, { x: b.x1, y: below, anchor: 'end' }, { x: b.x0, y: below, anchor: 'start' },
      { x: cx, y: above, anchor: 'middle' }, { x: b.x1, y: above, anchor: 'end' }, { x: b.x0, y: above, anchor: 'start' },
      { x: b.x0 - gap, y: cy, anchor: 'end' }, { x: b.x1 + gap, y: cy, anchor: 'start' },
    ];
    // Spots toward the middle of the map first: there is more room there than against the frame edge.
    const mid = { x: (fx0 + fx1) / 2, y: VB / 2 };
    const score = (s: Spot) => Math.hypot(s.x - mid.x, s.y - mid.y);
    spots.sort((a, c) => score(a) - score(c));
    const lines = input.routeLines ?? [];
    const pad = 4 * u;
    // Still next to the shape after sliding into the frame: the box must stay within a line of it.
    const near = (box: Box) => box.x1 >= b.x0 - fs && box.x0 <= b.x1 + fs && box.y1 >= b.y0 - fs * 2 && box.y0 <= b.y1 + fs * 2;
    // A real gap from every other label (Home above all): boxes that only just miss read as one
    // label on screen, e.g. "Home NIFC perimeter", as if the home were the perimeter.
    const apart = (box: Box) => !placer.labels.some((o) => overlaps({ x0: box.x0 - fs * 1.5, y0: box.y0 - fs * 0.6, x1: box.x1 + fs * 1.5, y1: box.y1 + fs * 0.6 }, o));
    const clear = (box: Box) => near(box) && apart(box) && !boxCrossesLines({ x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad }, lines);
    push(placer.place(spots, REF_PERIMETER_LABELS, 't-ref', clear, true));
  }

  // 9. Sea, in open water.
  const seaSpots = input.sea.flatMap((p) => [0, -1.6, 1.6].map((k) => ({ x: p.x, y: p.y + fs * (0.35 + k), anchor: 'middle' as const })));
  push(placer.place(seaSpots, ['Sea'], 't-sea'));

  // 10. Corner notes: top left of the fire square, else under the wind text, else the bottom left.
  const cornerX = Math.max(input.grid.x, fx0) + 8 * u;
  const top = Math.max(input.grid.y, 0);
  const bottom = Math.min(input.grid.y + input.grid.w, VB);
  const wt: Label | null = wind ? (wind as WindPlacement).text : null;
  const windSpots: Spot[] = wt ? [1.4, 2.7].map((k) => ({ x: wt.x, y: wt.y + fs * k, anchor: wt.anchor })) : [];
  for (const text of input.cornerNotes) {
    const spots: Spot[] = [
      { x: cornerX, y: top + fs * 1.2, anchor: 'start' },
      { x: cornerX, y: top + fs * 2.5, anchor: 'start' },
      ...windSpots,
      { x: cornerX, y: bottom - fs * 0.6, anchor: 'start' },
      { x: cornerX, y: bottom - fs * 1.9, anchor: 'start' },
    ];
    push(placer.place(spots, [text], 't-road t-minor'));
  }

  // 11. Route labels, then road names.
  for (const r of input.routeLabels) {
    if (r.pts.length < 2) continue;
    const spots = [0.45, 0.6, 0.3, 0.75].map((t) => {
      const p = pointAlong(r.pts, t);
      return { x: p.x + 14 * u, y: p.y - 10 * u, anchor: 'start' as const };
    });
    push(placer.place(spots, [r.text], r.cls));
  }
  for (const r of input.roadNames) {
    const spots = [0.5, 0.35, 0.65, 0.2, 0.8].map((t) => {
      const p = pointAlong(r.pts, t);
      return { x: p.x, y: p.y - 12 * u, anchor: 'middle' as const };
    });
    push(placer.place(spots, [r.text], 't-road'));
  }

  // 12. Fire label.
  if (input.fireCentroid) {
    const { x, y } = input.fireCentroid;
    const step = 40 * u;
    const offsets: [number, number][] = [[0, 0], [0, -step], [0, step], [-2 * step, 0], [2 * step, 0], [0, -2 * step], [0, 2 * step]];
    push(placer.place(offsets.map(([dx, dy]) => ({ x: x + dx, y: y + dy, anchor: 'middle' as const })), ['SIMULATED FIRE'], 't-fire'));
  }

  return { labels, wind, caption, markers: placer.markers };
}

const sameXY = (a: XY | null, b: XY) => !!a && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

/** What of the reference layer falls inside the frame, and where its label goes (nearest edge point to home). */
export function refInView(v: View, ref: RefLayer, home: XY, insetM: number): { perimeters: XY[][][]; detections: XY[]; labelAt: XY | null } {
  const perimeters = ref.perimeters.filter((rings) => rings.some((r) => shapeTouchesView(v, r)));
  let labelAt: XY | null = null;
  let best = Infinity;
  for (const rings of perimeters) {
    for (const ring of rings) {
      for (const p of ring) {
        if (!inFrame(v, p, insetM)) continue;
        const d = dist(home, p);
        if (d < best) {
          best = d;
          labelAt = p;
        }
      }
    }
  }
  return { perimeters, detections: ref.detections.filter((p) => inFrame(v, p)), labelAt };
}

const STYLE_WORDS: Record<RouteStyle, (label: string) => string> = {
  main: (l) => `Solid cyan line: ${l}.`,
  backup: (l) => `Dashed cyan line: ${l}.`,
  closed: (l) => `Dotted coral line: ${l}, closed by the fire.`,
  unused: (l) => `Grey dashed line: ${l}, not used.`,
};

/** Longest in-view runs of named roads along the drawn routes, in SVG units. */
function roadNameRuns(prepared: PreparedArea, v: View, insetM: number, drawn: { route: Route }[]): { text: string; pts: XY[] }[] {
  const out: { text: string; pts: XY[] }[] = [];
  const named = new Set<string>();
  for (const r of drawn) {
    const runs = new Map<string, { len: number; pts: XY[] }>();
    let curName = '';
    let cur: XY[] = [];
    let curLen = 0;
    const flush = () => {
      if (curName && cur.length > 1 && curLen > (runs.get(curName)?.len ?? 0)) runs.set(curName, { len: curLen, pts: cur });
    };
    for (const eid of r.route.edgeIds) {
      const e = prepared.graph.edges[eid];
      if (e.name !== curName) {
        flush();
        curName = e.name;
        cur = [];
        curLen = 0;
      }
      for (const p of e.shape) {
        if (!inFrame(v, p, insetM)) continue;
        if (cur.length) curLen += dist(cur[cur.length - 1], p);
        cur.push(p);
      }
    }
    flush();
    const longest = [...runs].filter(([, run]) => run.len >= MIN_NAMED_RUN_M).sort((a, b) => b[1].len - a[1].len);
    let shown = 0;
    for (const [name, run] of longest) {
      if (shown >= ROAD_NAMES_PER_ROUTE) break;
      if (named.has(name) || name === 'Unnamed road' || !name) continue;
      named.add(name);
      shown++;
      out.push({ text: name, pts: run.pts.map((p) => ({ x: sx(v, p.x), y: sy(v, p.y) })) });
    }
  }
  return out;
}

// ---------- Component ----------

export function MapView(props: MapViewProps) {
  const { prepared, routes = [], fire = null, closure = null, wind, terrain = true, ignition = null, notes = [], units = 'mi' } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const glowId = `glow-${uid}`;
  const refHatchId = `refhatch-${uid}`;
  const [px, setPx] = useState(640);
  /** Frame width over height. Above 1 the frame is capped in height, and the view widens to fill it. */
  const [aspect, setAspect] = useState(1);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const side = Math.min(r.width, r.height);
      if (side > 0) setPx(side);
      const frameW = el.parentElement?.clientWidth ?? r.width;
      const maxH = Number.parseFloat(getComputedStyle(el).maxHeight);
      const a = Number.isFinite(maxH) && maxH > 0 && frameW > 0 ? Math.max(1, frameW / maxH) : 1;
      setAspect(Math.round(a * 100) / 100);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const view = useMemo(() => makeView(prepared, aspect), [prepared, aspect]);
  const fx0 = frameX0(view);
  const fx1 = frameX1(view);
  const u = VB / px; // SVG units per CSS pixel
  const fs = LABEL_PX * u;

  const roads = useMemo(() => roadPaths(prepared, view), [prepared, view]);
  const contourLines = useMemo(() => (terrain ? contourPaths(prepared, view) : []), [prepared, view, terrain]);
  const sea = useMemo(() => seaLayer(prepared, view), [prepared, view]);
  const fireRun = fire?.run ?? null;
  const fireMinute = fire?.minute ?? 0;
  const firePath = useMemo(() => (fireRun ? firePaths(fireRun, fireMinute, view) : null), [fireRun, fireMinute, view]);

  const { waysOut, homeXY, fireGrid } = prepared;
  const insetM = (22 * u) / view.k;

  // Routes to draw, bottom to top: unused, closed, backup, main.
  const order: RouteStyle[] = ['unused', 'closed', 'backup', 'main'];
  const drawn = routes
    .map((r) => ({ ...r, route: r.which === 'main' ? waysOut.main : waysOut.backup }))
    .filter((r): r is typeof r & { route: Route } => r.route !== null)
    .map((r) => ({ ...r, shape: routeShape(prepared, r.route) }))
    .sort((a, b) => order.indexOf(a.style) - order.indexOf(b.style));
  const mainMissing = routes.some((r) => r.which === 'main') && waysOut.main === null;
  const leavesGrid = drawn.find((r) => r.shape.some((p) => !isInGrid(fireGrid, p))) ?? null;

  const dests = destMarks(prepared, view, u, routes);
  const reference = props.reference ?? null;
  const refShown = useMemo(() => (reference ? refInView(view, reference, homeXY, insetM) : null), [reference, view, homeXY, insetM]);
  // Tell the screen what is drawn, so a legend outside the map names only marks that are on it.
  const onReferenceDrawn = props.onReferenceDrawn;
  const drawnPerims = refShown ? refShown.perimeters.length : -1;
  const drawnDets = refShown ? refShown.detections.length : -1;
  useEffect(() => {
    onReferenceDrawn?.(drawnPerims < 0 ? null : { perimeters: drawnPerims, detections: drawnDets });
  }, [onReferenceDrawn, drawnPerims, drawnDets]);
  const refCells = useMemo(
    () => (refShown ? refAreaCells(refShown.perimeters.map((rings) => rings.map((ring) => ring.map((p) => ({ x: sx(view, p.x), y: sy(view, p.y) })))), fx0, fx1, REF_CELL_PX * u) : null),
    [refShown, view, fx0, fx1, u],
  );

  const hx = sx(view, homeXY.x);
  const hy = sy(view, homeXY.y);
  const gridX = sx(view, fireGrid.originXY.x);
  const gridY = sy(view, fireGrid.originXY.y + fireGrid.cellM * fireGrid.size);
  const extentSvg = fireGrid.cellM * fireGrid.size * view.k;
  const cornerNotes: string[] = [];
  if (leavesGrid) cornerNotes.push('Fire not modeled outside the dashed square');
  if (sea?.atEdge) cornerNotes.push('Sea shown inside the dashed square only');
  if (terrain && !prepared.elevationPerCell) cornerNotes.push('No elevation data: drawn flat');

  const selected = ignition?.selected ?? null;
  const selectedIsSuggestion = !!ignition?.suggestions.some((s) => sameXY(selected, s.xy));
  const toSvgXY = (p: XY): XY => ({ x: sx(view, p.x), y: sy(view, p.y) });
  const closureTrue = closure ? toSvgXY(closure.xy) : null;
  const closureAt = closureTrue ? closureMarkerAt({ x: hx, y: hy }, closureTrue, u) : null;

  const layout = layoutMap({
    view,
    u,
    units,
    home: { x: hx, y: hy },
    dests,
    closure: closure && closureAt ? { x: closureAt.x, y: closureAt.y, label: closure.label } : null,
    ignition: ignition
      ? {
          points: ignition.suggestions.map((s) => toSvgXY(s.xy)),
          selected: selected
            ? { ...toSvgXY(selected), text: selectedIsSuggestion ? 'Ignition point (selected)' : 'Your ignition point', suggestion: selectedIsSuggestion }
            : null,
        }
      : null,
    wind,
    caption: props.fireCaption ?? null,
    notes: notes.map((n) => ({
      ...toSvgXY(n.xy),
      text: n.text,
      cls: n.tone === 'short' ? 't-closed' : n.tone === 'route' ? 't-route' : 't-road',
    })),
    refCells,
    routeLines: drawn.map((r) => r.shape.map(toSvgXY)),
    cornerNotes,
    grid: { x: gridX, y: gridY, w: extentSvg },
    sea: sea ? sea.labelAt.map(toSvgXY) : [],
    routeLabels: drawn
      .filter((r) => r.label)
      .map((r) => ({
        text: r.label as string,
        cls: r.style === 'closed' ? 't-closed' : r.style === 'unused' ? 't-road' : 't-route',
        pts: r.shape.filter((p) => inFrame(view, p, insetM)).map(toSvgXY),
      })),
    roadNames: roadNameRuns(prepared, view, insetM, drawn),
    fireCentroid: firePath?.centroid ? toSvgXY(firePath.centroid) : null,
  });

  // ----- Status messages for edge cases -----
  const status: string[][] = [];
  if (mainMissing) status.push(['No way out found', 'on mapped roads']);
  if (fire && !fire.run.coverage.ignitionInGrid) status.push(['Ignition is outside the fire model area.', 'No fire was simulated.']);
  const flat = terrain && !prepared.elevationPerCell;

  // ----- Ignition picking -----
  const pickable = !!ignition;
  const toXY = (clientX: number, clientY: number): XY | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: view.minX + p.x / view.k, y: view.maxY - p.y / view.k };
  };
  const onMapClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!ignition) return;
    const xy = toXY(e.clientX, e.clientY);
    if (xy) ignition.onPick(xy);
  };
  const pickKey = (e: KeyboardEvent, xy: XY) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ignition?.onPick(xy);
    }
  };

  // ----- Mobile note: what the hidden minor labels said -----
  const noteParts: string[] = [];
  for (const r of routes) {
    const def = r.which === 'main' ? 'your main route' : 'your backup route';
    if ((r.which === 'main' ? waysOut.main : waysOut.backup) === null) continue;
    noteParts.push(STYLE_WORDS[r.style](r.label ?? def));
  }
  if (firePath) noteParts.push('Fire cells: bright edge is burning, hatched is burned.');
  if (props.fireCaption) noteParts.push(`${props.fireCaption}.`);
  if (sea) noteParts.push(sea.atEdge ? 'Blue area: the sea, shown inside the dashed square only.' : 'Blue area: the sea.');
  if (wind) noteParts.push(`Arrow: wind from ${compassName(wind.fromDeg)} ${windSpeed(wind, units)}.`);
  else if (wind === null) noteParts.push('Wind not set yet.');
  if (dests.length) {
    const names = dests.map((d) => `${d.code} ${d.name}${d.onMap ? '' : ` (${fmtDistance(d.awayM, units)} away, arrow at the map edge)`}`);
    noteParts.push(`${names.join(' and ')} ${dests.length > 1 ? 'are candidate destinations, not confirmed shelters' : 'is a candidate destination, not a confirmed shelter'}.`);
  }
  for (const note of notes) noteParts.push(`At the closure point, ${note.text.charAt(0).toLowerCase()}${note.text.slice(1)}.`);
  if (refShown && refShown.perimeters.length > 0) noteParts.push('Violet hatched outline: current fire perimeter (NIFC), reference only, not part of the drill.');
  if (refShown && refShown.detections.length > 0) noteParts.push('Violet diamonds: satellite heat detections (NASA FIRMS), reference only.');
  if (leavesGrid) noteParts.push('Past the dashed square the fire is not modeled.');
  if (flat) noteParts.push('No elevation data: terrain is drawn flat.');

  const svgStyle = { '--map-fs': `${r1(fs)}px`, '--map-fs-dest': `${r1(DEST_PX * u)}px`, '--map-ts': `${r1(TEXT_STROKE_PX * u)}px` } as CSSProperties;
  const blur = Math.max(4, 140 * view.k);
  const windPlace = layout.wind;

  return (
    <>
      <div className={`map sp-map${props.size === 'short' ? ' short' : ''}${pickable ? ' picking' : ''}`}>
        <svg
          ref={svgRef}
          viewBox={`${r1(fx0)} 0 ${r1(fx1 - fx0)} ${VB}`}
          preserveAspectRatio="xMidYMid meet"
          className={props.animate ? 'm-running' : undefined}
          role={pickable ? 'group' : 'img'}
          aria-label={props.ariaLabel}
          style={svgStyle}
          onClick={pickable ? onMapClick : undefined}
        >
          <defs>
            <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation={r1(blur)} />
            </filter>
            {refShown && (
              <pattern id={refHatchId} patternUnits="userSpaceOnUse" width={r1(9 * u)} height={r1(9 * u)} patternTransform="rotate(45)">
                <path d={`M0 0V${r1(9 * u)}M0 0H${r1(9 * u)}`} className="ref-hatch" />
              </pattern>
            )}
          </defs>
          <rect className="sp-ground" x={fx0} y={0} width={fx1 - fx0} height={VB} />

          <g aria-hidden="true">
            {sea && <path className="sp-sea" fillRule="evenodd" d={sea.fill} />}
            {sea && sea.coast && <path className="sp-coast" d={sea.coast} />}
            {contourLines.map((c, i) => (
              <path key={i} d={c.d} className={c.major ? 'contour major' : 'contour'} />
            ))}
            {roads.map((r) => (
              <path key={r.cls} d={r.d} className={r.cls} />
            ))}
            <path
              className="sp-outside"
              fillRule="evenodd"
              d={`M${r1(fx0)} 0H${r1(fx1)}V${VB}H${r1(fx0)}Z M${r1(gridX)} ${r1(gridY)}h${r1(extentSvg)}v${r1(extentSvg)}h${r1(-extentSvg)}Z`}
            />
            <rect className="sp-gridedge" x={gridX} y={gridY} width={extentSvg} height={extentSvg} />

            {refShown && (
              <g className="ref-layer">
                {refShown.perimeters.map((rings, i) => {
                  const d = rings.map((r) => `${polyD(view, r)}Z`).join('');
                  return (
                    <g key={i}>
                      <path d={d} fillRule="evenodd" fill={`url(#${refHatchId})`} className="ref-area" />
                      <path d={d} className="ref-edge-back" />
                      <path d={d} className="ref-edge" />
                    </g>
                  );
                })}
                {refShown.detections.map((p, i) => {
                  const x = sx(view, p.x);
                  const y = sy(view, p.y);
                  const s = 5.5 * u;
                  return <path key={i} d={`M${r1(x)} ${r1(y - s)}L${r1(x + s)} ${r1(y)}L${r1(x)} ${r1(y + s)}L${r1(x - s)} ${r1(y)}Z`} className="ref-det" />;
                })}
              </g>
            )}

            {firePath && (
              <>
                <path className="glow" d={firePath.glow} filter={`url(#${glowId})`} />
                <path className="c-burned" d={firePath.burned} />
                <path className="c-hatch" d={firePath.hatch} />
                <path className="c-ember" d={firePath.ember} />
                <path className="c-front" d={firePath.front} />
                <path className="c-hot" d={firePath.hot} />
              </>
            )}

            {drawn.map((r) => {
              const d = polyD(view, r.shape);
              if (r.style === 'main')
                return (
                  <g key={r.which}>
                    <path d={d} className="r-halo" />
                    <path d={d} className="r-main" />
                  </g>
                );
              return <path key={r.which} d={d} className={`r-${r.style}`} />;
            })}

            {closureAt && closureTrue && (
              <g>
                {closureAt.moved && (
                  <>
                    <line x1={closureTrue.x} y1={closureTrue.y} x2={closureAt.x} y2={closureAt.y} className="closure-lead" />
                    <circle cx={closureTrue.x} cy={closureTrue.y} r={3.5 * u} className="closure-dot" />
                  </>
                )}
                <circle cx={closureAt.x} cy={closureAt.y} r={16 * u} className="closure-back" />
                <circle cx={closureAt.x} cy={closureAt.y} r={16 * u} className="closure" />
              </g>
            )}

            {dests.map((ds) => {
              const s = DEST_R * u;
              return (
                <g key={ds.id}>
                  {ds.dir && (
                    <path
                      className="dest-arrow"
                      d={`M${r1(ds.x + ds.dir.x * 20 * u - ds.dir.y * 6 * u)} ${r1(ds.y + ds.dir.y * 20 * u + ds.dir.x * 6 * u)}L${r1(ds.x + ds.dir.x * 31 * u)} ${r1(ds.y + ds.dir.y * 31 * u)}L${r1(ds.x + ds.dir.x * 20 * u + ds.dir.y * 6 * u)} ${r1(ds.y + ds.dir.y * 20 * u - ds.dir.x * 6 * u)}`}
                    />
                  )}
                  <rect x={ds.x - s} y={ds.y - s} width={2 * s} height={2 * s} rx={5 * u} className="dest" />
                  <text x={ds.x} y={ds.y + DEST_PX * u * 0.36} textAnchor="middle" className="t-dest">
                    {ds.code}
                  </text>
                </g>
              );
            })}

            <circle cx={hx} cy={hy} r={16 * u} className="home-ring" />
            <circle cx={hx} cy={hy} r={6.5 * u} className="home" />

            {windPlace?.arrow && wind && (
              <g className="wind" transform={`translate(${r1(windPlace.ax)} ${r1(windPlace.ay)}) rotate(${r1(wind.fromDeg)}) scale(${r1(u * 100) / 100})`}>
                <path d="M0 -20V20M-11 9 0 20 11 9" />
              </g>
            )}

            {status.map((lines, i) => {
              const y0 = VB * 0.2 + i * 70 * u; // above home, which sits at the center
              return (
                <text key={i} x={VB / 2} y={y0} textAnchor="middle" className="t-closed sp-status">
                  {lines.map((line, j) => (
                    <tspan key={j} x={VB / 2} dy={j === 0 ? 0 : fs * 1.3}>
                      {line}
                    </tspan>
                  ))}
                </text>
              );
            })}
          </g>

          {ignition && (
            <g>
              {ignition.suggestions.map((s, i) => {
                const on = sameXY(selected, s.xy);
                const x = sx(view, s.xy.x);
                const y = sy(view, s.xy.y);
                return (
                  <g
                    key={i}
                    className="ig-btn"
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    aria-label={`Ignition point ${i + 1}: ${s.label}. ${s.reason}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      ignition.onPick(s.xy);
                    }}
                    onKeyDown={(e) => pickKey(e, s.xy)}
                  >
                    <circle cx={x} cy={y} r={26 * u} className="ig-hit" />
                    {on && <circle cx={x} cy={y} r={26 * u} className="ig-ring" />}
                    <circle cx={x} cy={y} r={15 * u} className={on ? 'ig on' : 'ig'} />
                    <circle cx={x} cy={y} r={30 * u} className="ig-focus" />
                    <text x={x} y={y + fs * 0.36} textAnchor="middle" className={on ? 't-ig on' : 't-ig'} aria-hidden="true">
                      {i + 1}
                    </text>
                  </g>
                );
              })}
              {selected && !selectedIsSuggestion && (
                <g aria-hidden="true">
                  <circle cx={sx(view, selected.x)} cy={sy(view, selected.y)} r={26 * u} className="ig-ring" />
                  <circle cx={sx(view, selected.x)} cy={sy(view, selected.y)} r={11 * u} className="ig on" />
                </g>
              )}
            </g>
          )}

          <g aria-hidden="true" className="sp-labels">
            {/* Closure labels get a dark plate, so they stay readable over fire cells. */}
            {layout.labels
              .filter((l) => l.cls.includes('t-closed'))
              .map((l, i) => (
                <rect key={`plate-${i}`} x={r1(l.box.x0)} y={r1(l.box.y0)} width={r1(l.box.x1 - l.box.x0)} height={r1(l.box.y1 - l.box.y0)} rx={r1(4 * u)} className="t-plate" />
              ))}
            {layout.labels.map((l, i) => (
              <text key={i} x={r1(l.x)} y={r1(l.y)} textAnchor={l.anchor} className={l.cls || undefined}>
                {l.text}
              </text>
            ))}
            {windPlace?.text && (
              <text x={r1(windPlace.text.x)} y={r1(windPlace.text.y)} textAnchor={windPlace.text.anchor} className="t-minor">
                {windPlace.text.text}
              </text>
            )}
            {layout.caption && (
              <text x={r1(layout.caption.x)} y={r1(layout.caption.y)} textAnchor={layout.caption.anchor} className="t-cap">
                {layout.caption.text}
              </text>
            )}
          </g>
        </svg>
        <span className="sp-attrib">Map data © OpenStreetMap contributors</span>
      </div>
      {props.fireCaption && !layout.caption && <p className="map-caption">{props.fireCaption}</p>}
      {noteParts.length > 0 && <p className="mapnote">{noteParts.join(' ')}</p>}
    </>
  );
}
