// The drill map: real OpenStreetMap roads around home in local XY, terrain contours from the
// elevation grid, the simulated fire as model cells, routes, destinations and markers.
// Drawn as inline SVG. The view is the fire grid square plus a little padding; on a frame wider
// than tall, the view grows sideways so roads and terrain fill the whole frame.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import { contours } from 'd3-contour';
import type { DrillRun } from '../engine/drill';
import type { PreparedArea } from '../engine/area';
import type { Destination, Route, Wind, XY } from '../engine/types';
import type { IgnitionSuggestion } from '../engine/ignition';
import { compassName, dist } from '../engine/geo';
import { isInGrid } from '../engine/fire';
import '../styles/map.css';

export type RouteStyle = 'main' | 'backup' | 'closed' | 'unused';

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
}

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
/** Road names shown per route, longest stretches first, and the shortest stretch worth a name. */
const ROAD_NAMES_PER_ROUTE = 3;
const MIN_NAMED_RUN_M = 300;

interface View {
  minX: number;
  maxY: number;
  spanM: number;
  k: number; // SVG units per meter
  /** Extra SVG units drawn on each side of the square (0 on a square or tall frame). */
  ex: number;
}

function makeView(prepared: PreparedArea, aspect: number): View {
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

function inView(v: View, p: XY, insetM = 0): boolean {
  return (
    p.x >= v.minX + insetM &&
    p.x <= v.minX + v.spanM - insetM &&
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

// ---------- Terrain ----------

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
  const toSvg = (cx: number, cy: number) =>
    `${r1(sx(v, g.originXY.x + cx * g.cellM))} ${r1(sy(v, g.originXY.y + cy * g.cellM))}`;
  // d3 closes every ring along the grid border; those border pieces are not contour lines.
  const n = g.size;
  const onSameBorder = (a: number[], b: number[]) =>
    (a[0] <= 0 && b[0] <= 0) || (a[0] >= n && b[0] >= n) || (a[1] <= 0 && b[1] <= 0) || (a[1] >= n && b[1] >= n);
  return shapes.map((mp) => {
    let d = '';
    for (const poly of mp.coordinates) {
      for (const ring of poly) {
        let pen = false;
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1];
          const b = ring[i];
          if (onSameBorder(a, b)) {
            pen = false;
            continue;
          }
          if (!pen) d += 'M' + toSvg(a[0], a[1]);
          d += 'L' + toSvg(b[0], b[1]);
          pen = true;
        }
      }
    }
    return { d, major: Math.round(mp.value) % majorStep === 0 };
  });
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

// ---------- Labels ----------

interface Box { x0: number; y0: number; x1: number; y1: number }

class Placer {
  boxes: Box[] = [];
  fs: number;
  x0: number;
  x1: number;
  constructor(fs: number, x0 = 0, x1 = VB) {
    this.fs = fs;
    this.x0 = x0;
    this.x1 = x1;
  }
  /** True when the box lies inside the frame. */
  fits(b: Box): boolean {
    return b.x0 >= this.x0 + 4 && b.x1 <= this.x1 - 4 && b.y0 >= 4 && b.y1 <= VB - 4;
  }
  free(b: Box): boolean {
    return !this.boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  }
  box(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end'): Box {
    const w = text.length * this.fs * 0.54;
    const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    return { x0, y0: y - this.fs, x1: x0 + w, y1: y + this.fs * 0.3 };
  }
  reserve(b: Box) {
    this.boxes.push(b);
  }
  /** Reserves and returns true when the label fits inside the view without overlap. */
  tryPlace(x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end'): boolean {
    const b = this.box(x, y, text, anchor);
    if (!this.fits(b) || !this.free(b)) return false;
    this.boxes.push(b);
    return true;
  }
}

interface Label { x: number; y: number; text: string; anchor: 'start' | 'middle' | 'end'; cls: string }

/** Anchor that keeps a label inside the frame when the point is near the right edge. */
const anchorFor = (x: number, v: View): 'start' | 'end' => (x > frameX0(v) + (frameX1(v) - frameX0(v)) * 0.62 ? 'end' : 'start');

/** Last point of the shape still inside the view (inset), for off-map destinations. */
function lastInView(v: View, shape: XY[], insetM: number): XY | null {
  for (let i = shape.length - 1; i >= 0; i--) if (inView(v, shape[i], insetM)) return shape[i];
  return null;
}

function clampToward(v: View, from: XY, to: XY, insetM: number): XY {
  // Walk from home toward the destination until we leave the inset view.
  let lo = 0, hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    const p = { x: from.x + m * (to.x - from.x), y: from.y + m * (to.y - from.y) };
    if (inView(v, p, insetM)) lo = m;
    else hi = m;
  }
  return { x: from.x + lo * (to.x - from.x), y: from.y + lo * (to.y - from.y) };
}

const sameXY = (a: XY | null, b: XY) => !!a && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

function windText(w: Wind): string {
  return `Wind from ${compassName(w.fromDeg)} ${Math.round(w.speedMph)} mph`;
}

const STYLE_WORDS: Record<RouteStyle, (label: string) => string> = {
  main: (l) => `Solid cyan line: ${l}.`,
  backup: (l) => `Dashed cyan line: ${l}.`,
  closed: (l) => `Dotted coral line: ${l}, closed by the fire.`,
  unused: (l) => `Grey dashed line: ${l}, not used.`,
};

// ---------- Component ----------

export function MapView(props: MapViewProps) {
  const { prepared, routes = [], fire = null, closure = null, wind, terrain = true, ignition = null, notes = [] } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const glowId = `glow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
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
  const fireRun = fire?.run ?? null;
  const fireMinute = fire?.minute ?? 0;
  const firePath = useMemo(() => (fireRun ? firePaths(fireRun, fireMinute, view) : null), [fireRun, fireMinute, view]);

  const { waysOut, homeXY, fireGrid } = prepared;
  const insetM = 22 * u / view.k;

  // Routes to draw, bottom to top: unused, closed, backup, main.
  const order: RouteStyle[] = ['unused', 'closed', 'backup', 'main'];
  const drawn = routes
    .map((r) => ({ ...r, route: r.which === 'main' ? waysOut.main : waysOut.backup }))
    .filter((r): r is typeof r & { route: Route } => r.route !== null)
    .map((r) => ({ ...r, shape: routeShape(prepared, r.route) }))
    .sort((a, b) => order.indexOf(a.style) - order.indexOf(b.style));
  const mainMissing = routes.some((r) => r.which === 'main') && waysOut.main === null;
  const leavesGrid = drawn.find((r) => r.shape.some((p) => !isInGrid(fireGrid, p))) ?? null;

  // Destinations of main and backup (D1, D2), placed at the view edge when off map.
  // With routes given, only their destinations; otherwise both.
  const destRoutes = routes.length ? routes.map((r) => (r.which === 'main' ? waysOut.main : waysOut.backup)) : [waysOut.main, waysOut.backup];
  const destIds = [...new Set(destRoutes.map((r) => r?.destinationId).filter(Boolean))] as string[];
  const dests = destIds
    .map((id) => waysOut.destinations.find((d) => d.id === id))
    .filter((d): d is Destination => !!d)
    .map((d) => {
      const route = waysOut.main?.destinationId === d.id ? waysOut.main : waysOut.backup;
      const onMap = inView(view, d.xy, 0);
      let at = d.xy;
      if (!inView(view, d.xy, insetM)) at = (route && lastInView(view, routeShape(prepared, route), insetM)) ?? clampToward(view, homeXY, d.xy, insetM);
      const [code, ...rest] = d.label.split(' ');
      return { d, at, onMap, code, name: d.name.length <= MAX_NAME_CHARS ? d.name : rest.join(' ') || d.name };
    });

  // ----- Labels, placed most important first -----
  const placer = new Placer(fs, fx0, fx1);
  const labels: Label[] = [];
  const hx = sx(view, homeXY.x);
  const hy = sy(view, homeXY.y);
  placer.reserve({ x0: hx - 18 * u, y0: hy - 18 * u, x1: hx + 18 * u, y1: hy + 18 * u });
  placer.reserve({ x0: fx1 - 70 * u, y0: 0, x1: fx1, y1: 70 * u }); // wind arrow
  // Wind text and the top-left corner notes come first, so nothing is drawn over them.
  if (wind !== undefined) placer.reserve(placer.box(fx1 - 12 * u, wind ? 88 * u : 30 * u, wind ? windText(wind) : 'Wind not set', 'end'));
  // Corner notes: where the fire model ends, and missing elevation. Each goes at the top left of the
  // fire square, else just under the wind text; on a small map where neither fits it is left out
  // (the screens also say it in words).
  const gridX = sx(view, fireGrid.originXY.x);
  const gridY = sy(view, fireGrid.originXY.y + fireGrid.cellM * fireGrid.size);
  const extentSvg = fireGrid.cellM * fireGrid.size * view.k;
  const cornerNotes: string[] = [];
  if (leavesGrid) cornerNotes.push('Fire not modeled outside the dashed square');
  if (terrain && !prepared.elevationPerCell) cornerNotes.push('No elevation data: drawn flat');
  const cornerX = Math.max(gridX, 0) + 8 * u;
  const cornerYs = [Math.max(gridY, 0) + fs * 1.2, Math.max(gridY, 0) + fs * 2.5, (wind ? 88 * u : 30 * u) + fs * 1.4, (wind ? 88 * u : 30 * u) + fs * 2.7];
  const corner = cornerNotes.flatMap((text) => {
    const y = cornerYs.find((cy) => placer.tryPlace(cornerX, cy, text, 'start'));
    return y === undefined ? [] : [{ x: cornerX, y, text }];
  });
  if (placer.tryPlace(hx + 22 * u, hy + fs * 0.35, 'Home', 'start'))
    labels.push({ x: hx + 22 * u, y: hy + fs * 0.35, text: 'Home', anchor: 'start', cls: '' });

  for (const ds of dests) {
    const x = sx(view, ds.at.x);
    const y = sy(view, ds.at.y);
    placer.reserve({ x0: x - 16 * u, y0: y - 16 * u, x1: x + 16 * u, y1: y + 16 * u });
  }

  // Ignition markers, and the label of the selected one (below, else above, else beside).
  let igLabel: Label | null = null;
  if (ignition) {
    for (const s of ignition.suggestions) {
      const x = sx(view, s.xy.x);
      const y = sy(view, s.xy.y);
      placer.reserve({ x0: x - 28 * u, y0: y - 28 * u, x1: x + 28 * u, y1: y + 28 * u });
    }
    const sel = ignition.selected;
    if (sel) {
      const x = sx(view, sel.x);
      const y = sy(view, sel.y);
      const text = ignition.suggestions.some((s) => sameXY(sel, s.xy)) ? 'Ignition point (selected)' : 'Your ignition point';
      const tries: [number, number, 'start' | 'middle' | 'end'][] = [
        [x, y + 30 * u + fs, 'middle'],
        [x, y - 34 * u, 'middle'],
        [x + 32 * u, y + fs * 0.35, 'start'],
        [x - 32 * u, y + fs * 0.35, 'end'],
      ];
      const spot = tries.find(([lx, ly, a]) => placer.tryPlace(lx, ly, text, a)) ?? tries[0];
      igLabel = { x: spot[0], y: spot[1], text, anchor: spot[2], cls: 't-fire' };
    }
  }

  // Closure label: beside the marker on the roomier side, else the other side, else centered below
  // or above it, always kept inside the frame so the road name is never cut off.
  let closureLabel: { ring: XY; lx: number; ly: number; anchor: 'start' | 'middle' | 'end'; leader: boolean } | null = null;
  if (closure) {
    const x = sx(view, closure.xy.x);
    const y = sy(view, closure.xy.y);
    placer.reserve({ x0: x - 16 * u, y0: y - 16 * u, x1: x + 16 * u, y1: y + 16 * u });
    const first: 'start' | 'end' = x > (fx0 + fx1) / 2 ? 'end' : 'start';
    const side = (a: 'start' | 'end') => ({ lx: a === 'end' ? x - 50 * u : x + 50 * u, ly: y + fs * 0.35, anchor: a, leader: true });
    const below = { lx: x, ly: y + 22 * u + fs, anchor: 'middle' as const, leader: false };
    const above = { lx: x, ly: y - 24 * u, anchor: 'middle' as const, leader: false };
    const tries = [side(first), side(first === 'start' ? 'end' : 'start'), below, above];
    const fitsAt = (t: (typeof tries)[number]) => placer.fits(placer.box(t.lx, t.ly, closure.label, t.anchor));
    let spot = tries.find((t) => fitsAt(t) && placer.free(placer.box(t.lx, t.ly, closure.label, t.anchor))) ?? tries.find(fitsAt) ?? below;
    if (!fitsAt(spot)) {
      // Too long for the frame at any spot: center it and clamp to the frame edges.
      const b = placer.box(spot.lx, spot.ly, closure.label, 'middle');
      const shift = b.x0 < fx0 + 4 ? fx0 + 4 - b.x0 : b.x1 > fx1 - 4 ? fx1 - 4 - b.x1 : 0;
      spot = { ...below, lx: x + shift };
    }
    placer.reserve(placer.box(spot.lx, spot.ly, closure.label, spot.anchor));
    closureLabel = { ring: { x, y }, ...spot };
  }

  // Extra notes: stacked near their point (below first, then above) without covering other labels.
  for (const note of notes) {
    const x = sx(view, note.xy.x);
    const y = sy(view, note.xy.y);
    const cls = note.tone === 'short' ? 't-closed' : note.tone === 'route' ? 't-route' : 't-road';
    const anchors: ('start' | 'end')[] = [anchorFor(x, view), anchorFor(x, view) === 'start' ? 'end' : 'start'];
    let placed = false;
    for (const dy of [2.4, 3.7, 5.0, -1.8, -3.1, 6.3]) {
      for (const anchor of anchors) {
        const lx = anchor === 'start' ? x - 8 * u : x + 8 * u;
        if (!placed && placer.tryPlace(lx, y + fs * dy, note.text, anchor)) {
          labels.push({ x: lx, y: y + fs * dy, text: note.text, anchor, cls });
          placed = true;
        }
      }
    }
  }

  for (const ds of dests) {
    const x = sx(view, ds.at.x);
    const y = sy(view, ds.at.y);
    const text = `${ds.name} (candidate${ds.onMap ? '' : ', off map'})`;
    const first = anchorFor(x, view);
    const tries: { lx: number; ly: number; anchor: 'start' | 'end' }[] = [];
    for (const anchor of [first, first === 'start' ? 'end' : 'start'] as const) {
      const lx = anchor === 'start' ? x + 22 * u : x - 22 * u;
      for (const ly of [y + fs * 0.35, y - 24 * u, y + 30 * u]) tries.push({ lx, ly, anchor });
    }
    const spot = tries.find((t) => placer.tryPlace(t.lx, t.ly, text, t.anchor));
    if (spot) labels.push({ x: spot.lx, y: spot.ly, text, anchor: spot.anchor, cls: 't-minor' });
  }

  // Route labels, then the names of the roads the routes use.
  for (const r of drawn) {
    if (!r.label) continue;
    const inside = r.shape.filter((p) => inView(view, p, insetM));
    for (const t of [0.45, 0.6, 0.3, 0.75]) {
      if (inside.length < 2) break;
      const p = pointAlong(inside, t);
      const x = sx(view, p.x) + 14 * u;
      const y = sy(view, p.y) - 10 * u;
      const cls = r.style === 'closed' ? 't-closed' : r.style === 'unused' ? 't-road' : 't-route';
      if (placer.tryPlace(x, y, r.label, 'start')) {
        labels.push({ x, y, text: r.label, anchor: 'start', cls });
        break;
      }
    }
  }
  const named = new Set<string>();
  for (const r of drawn) {
    // Longest in-view run of consecutive edges per road name.
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
        if (!inView(view, p, insetM)) continue;
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
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const p = pointAlong(run.pts, t);
        const x = sx(view, p.x);
        const y = sy(view, p.y) - 12 * u;
        if (placer.tryPlace(x, y, name, 'middle')) {
          labels.push({ x, y, text: name, anchor: 'middle', cls: 't-road' });
          named.add(name);
          shown++;
          break;
        }
      }
    }
  }

  if (firePath?.centroid) {
    const cx = sx(view, firePath.centroid.x);
    const cy = sy(view, firePath.centroid.y);
    const step = 40 * u;
    const tries: [number, number][] = [[0, 0], [0, -step], [0, step], [-2 * step, 0], [2 * step, 0], [0, -2 * step], [0, 2 * step]];
    for (const [dx, dy] of tries) {
      if (placer.tryPlace(cx + dx, cy + dy, 'SIMULATED FIRE', 'middle')) {
        labels.push({ x: cx + dx, y: cy + dy, text: 'SIMULATED FIRE', anchor: 'middle', cls: 't-fire' });
        break;
      }
    }
  }

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
  const selected = ignition?.selected ?? null;
  const selectedIsSuggestion = !!ignition?.suggestions.some((s) => sameXY(selected, s.xy));

  // ----- Mobile note: what the hidden minor labels said -----
  const noteParts: string[] = [];
  for (const r of routes) {
    const def = r.which === 'main' ? 'your main route' : 'your backup route';
    if ((r.which === 'main' ? waysOut.main : waysOut.backup) === null) continue;
    noteParts.push(STYLE_WORDS[r.style](r.label ?? def));
  }
  if (firePath) noteParts.push('Fire cells: bright edge is burning, hatched is burned.');
  if (wind) noteParts.push(`Arrow: wind from ${compassName(wind.fromDeg)} ${Math.round(wind.speedMph)} mph.`);
  else if (wind === null) noteParts.push('Wind not set yet.');
  if (dests.length) {
    const names = dests.map((d) => `${d.code} ${d.name}${d.onMap ? '' : ' (off map, at the edge)'}`);
    noteParts.push(`${names.join(' and ')} ${dests.length > 1 ? 'are candidate destinations, not confirmed shelters' : 'is a candidate destination, not a confirmed shelter'}.`);
  }
  for (const note of notes) noteParts.push(`At the closure point, ${note.text.charAt(0).toLowerCase()}${note.text.slice(1)}.`);
  if (leavesGrid) noteParts.push('Past the dashed square the fire is not modeled.');
  if (flat) noteParts.push('No elevation data: terrain is drawn flat.');

  const svgStyle = { '--map-fs': `${r1(fs)}px`, '--map-fs-dest': `${r1(DEST_PX * u)}px`, '--map-ts': `${r1(TEXT_STROKE_PX * u)}px` } as CSSProperties;
  const blur = Math.max(4, 140 * view.k);

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
          </defs>
          <rect className="sp-ground" x={fx0} y={0} width={fx1 - fx0} height={VB} />

          <g aria-hidden="true">
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

            {closureLabel && closure && (
              <g>
                <circle cx={closureLabel.ring.x} cy={closureLabel.ring.y} r={16 * u} className="closure-back" />
                <circle cx={closureLabel.ring.x} cy={closureLabel.ring.y} r={16 * u} className="closure" />
                {closureLabel.leader && (
                  <path
                    className="leader"
                    d={`M${r1(closureLabel.ring.x + (closureLabel.anchor === 'end' ? -18 : 18) * u)} ${r1(closureLabel.ring.y)}H${r1(closureLabel.lx + (closureLabel.anchor === 'end' ? 6 : -6) * u)}`}
                  />
                )}
                <text x={r1(closureLabel.lx)} y={r1(closureLabel.ly)} textAnchor={closureLabel.anchor} className="t-closed">
                  {closure.label}
                </text>
              </g>
            )}

            {dests.map((ds) => {
              const x = sx(view, ds.at.x);
              const y = sy(view, ds.at.y);
              const s = 15 * u;
              return (
                <g key={ds.d.id}>
                  <rect x={x - s} y={y - s} width={2 * s} height={2 * s} rx={5 * u} className="dest" />
                  <text x={x} y={y + DEST_PX * u * 0.36} textAnchor="middle" className="t-dest">
                    {ds.code}
                  </text>
                </g>
              );
            })}

            <circle cx={hx} cy={hy} r={16 * u} className="home-ring" />
            <circle cx={hx} cy={hy} r={6.5 * u} className="home" />

            {labels.map((l, i) => (
              <text key={i} x={r1(l.x)} y={r1(l.y)} textAnchor={l.anchor} className={l.cls || undefined}>
                {l.text}
              </text>
            ))}
            {corner.map((c) => (
              <text key={c.text} x={r1(c.x)} y={r1(c.y)} className="t-road t-minor">
                {c.text}
              </text>
            ))}

            {wind !== undefined && (
              <g>
                {wind && (
                  <g className="wind" transform={`translate(${r1(fx1 - 40 * u)} ${r1(40 * u)}) rotate(${r1(wind.fromDeg)}) scale(${r1(u * 100) / 100})`}>
                    <path d="M0 -20V20M-11 9 0 20 11 9" />
                  </g>
                )}
                <text x={fx1 - 12 * u} y={wind ? 88 * u : 30 * u} textAnchor="end" className="t-minor">
                  {wind ? windText(wind) : 'Wind not set'}
                </text>
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
              {igLabel && (
                <text x={r1(igLabel.x)} y={r1(igLabel.y)} textAnchor={igLabel.anchor} className="t-fire" aria-hidden="true">
                  {igLabel.text}
                </text>
              )}
            </g>
          )}
        </svg>
        <span className="sp-attrib">Map data © OpenStreetMap contributors</span>
      </div>
      {noteParts.length > 0 && <p className="mapnote">{noteParts.join(' ')}</p>}
    </>
  );
}
