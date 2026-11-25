// Drill logic: household tasks, ways out, road closures from a simulated fire, and drill results.
import type {
  Bottleneck,
  Destination,
  DrillResult,
  DrillSetup,
  EdgeClosures,
  FireGrid,
  FireResult,
  Household,
  Projection,
  RawPlace,
  RoadGraph,
  Route,
  RouteRun,
  StartTime,
  Task,
  WaysOut,
  XY,
} from './types';
import { bearingDeg, dist, nearestPointOnPolyline, pointSegmentDistance, polylineLength, samplePolyline } from './geo';
import { nearestNode } from './graph';
import { pathEdges, routeFromEdges, shortestTimes } from './routing';
import { cellCenter, firstIgnitionWithin, isInGrid, makeFireGrid, simulateFire } from './fire';

// ---------- Displayed minutes ----------

/** The one rounding rule for any minute shown to people (T+N, drive times, margins). Infinity stays Infinity. */
export function displayMin(min: number): number {
  return Math.round(min);
}

/** Difference of two minutes as shown: each value is rounded first, so the sentence and the delta agree. */
export function displayDiffMin(a: number, b: number): number {
  return displayMin(a) - displayMin(b);
}

// ---------- Household tasks ----------

export type HouseholdCounts = Pick<
  Household,
  'adults' | 'children' | 'needHelpMoving' | 'dogs' | 'catsAndSmallPets' | 'cars'
>;

/** Minutes added at night for waking everyone up. */
export const NIGHT_WAKE_MIN = 3;

/** Starting task list with rough minute estimates for a household. */
export function defaultTasks(h: HouseholdCounts): Task[] {
  const people = Math.max(0, h.adults) + Math.max(0, h.children);
  const tasks: Task[] = [];
  const add = (id: string, label: string, minutes: number) =>
    tasks.push({ id, label, minutes, source: 'estimate' });

  add('gather', 'Gather everyone', 2 + Math.ceil(0.5 * people));
  if (h.needHelpMoving > 0) add('help', 'Help a person to the car', 6 * h.needHelpMoving);
  const petMin = 3 * Math.max(0, h.dogs) + 4 * Math.max(0, h.catsAndSmallPets);
  if (petMin > 0) add('pets', 'Find pet carriers and pets', petMin);
  add('meds', 'Gather medications', 4);
  add('docs', 'Documents, phones, chargers', 3);
  add('load', 'Load the car', 3 + Math.floor(people / 2));
  if (h.cars === 0) add('ride', 'Reach a ride', 10);
  return tasks;
}

/** Total minutes before the car leaves, including the night wake-up. */
export function tasksMinutes(tasks: Task[], start: StartTime): number {
  let total = 0;
  for (const t of tasks) total += t.minutes;
  return total + (start === 'night' ? NIGHT_WAKE_MIN : 0);
}

// ---------- Ways out ----------

const PLACE_MIN_M = 2000; // DECISIONS.md: candidate destinations 2-8 km away
const PLACE_MAX_M = 8000;
/** Places farther than this from any road node are not used. */
const PLACE_SNAP_MAX_M = 500;
const EXIT_MIN_M = 4000;
const EXIT_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MAX_EXIT_POINTS = 4;
const BACKUP_PENALTY = 6;
const BACKUP_MIN_BEARING_DIFF = 45;
/** Destinations at least this far outside the fire grid edge count as outside the fire area. */
const OUTSIDE_GRID_MARGIN_M = 300;
/** An outside destination is preferred when its drive is at most this many times the nearest one. */
const OUTSIDE_MAX_DRIVE_RATIO = 1.5;

const KIND_WORD: Record<Destination['kind'], string> = {
  school: 'School',
  library: 'Library',
  townhall: 'Hall',
  community_centre: 'Centre',
  assembly_point: 'Assembly point',
  other: 'Place',
  exit_point: 'Exit point',
};

/** Undirected key for a road segment, so both directions of a two-way road match. */
function segmentKey(graph: RoadGraph, edgeId: number): string {
  const e = graph.edges[edgeId];
  return e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** "D1 School": the code and the kind word. The place's own name is added by destTitle. */
function shortLabel(prefix: string, d: Destination): string {
  return `${prefix} ${KIND_WORD[d.kind]}`;
}

/**
 * The one way a destination is named in sentences and lists on every screen:
 * "D2 School (Clear Creek School)", or for an exit point "D1, where Pacific Coast Highway leaves the area".
 */
export function destTitle(d: Destination): string {
  const id = d.label.split(' ')[0] || 'D';
  const name = d.name.trim();
  if (d.kind === 'exit_point') {
    if (/^where\s/i.test(name)) return `${id}, ${name}`;
    const road = name.replace(/^Exit point,?\s*/i, '').trim();
    return road ? `${id}, where ${road} leaves the area` : `${id}, where a road leaves the area`;
  }
  const short = `${id} ${KIND_WORD[d.kind]}`;
  const generic = !name || name.toLowerCase() === KIND_WORD[d.kind].toLowerCase() || short.endsWith(name);
  return generic ? short : `${short} (${name})`;
}

function emptyWaysOut(homeNodeId: number, destinations: Destination[] = []): WaysOut {
  return { homeNodeId, destinations, main: null, backup: null, sharedFromDoorM: 0, sharedRoadNames: [] };
}

/** True when xy lies at least OUTSIDE_GRID_MARGIN_M beyond the fire grid's edge (beyond the dashed square). */
export function isOutsideFireArea(grid: FireGrid, xy: XY): boolean {
  const m = OUTSIDE_GRID_MARGIN_M;
  const extent = grid.size * grid.cellM;
  return (
    xy.x < grid.originXY.x - m ||
    xy.y < grid.originXY.y - m ||
    xy.x > grid.originXY.x + extent + m ||
    xy.y > grid.originXY.y + extent + m
  );
}

/**
 * Sort order that puts destinations outside the fire area first when their drive time is within
 * OUTSIDE_MAX_DRIVE_RATIO of the fastest one; otherwise fastest first. Ties by id.
 */
function preferOutside(list: Destination[], times: Float64Array, grid: FireGrid): Destination[] {
  if (list.length === 0) return list;
  const fastest = Math.min(...list.map((d) => times[d.nodeId]));
  const preferred = (d: Destination) =>
    isOutsideFireArea(grid, d.xy) && times[d.nodeId] <= fastest * OUTSIDE_MAX_DRIVE_RATIO + 1e-9;
  return [...list].sort(
    (a, b) =>
      Number(preferred(b)) - Number(preferred(a)) ||
      times[a.nodeId] - times[b.nodeId] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Main and backup routes from home to candidate destinations. Destinations beyond the fire area
 * are preferred when the extra drive is small (see preferOutside). fireGrid defaults to the drill grid.
 */
export function planWaysOut(
  graph: RoadGraph,
  homeXY: XY,
  places: RawPlace[],
  proj: Projection,
  fireGrid: FireGrid = makeFireGrid(),
): WaysOut {
  const homeNode = nearestNode(graph, homeXY);
  if (homeNode === null) return emptyWaysOut(-1);
  const { time, prevEdge } = shortestTimes(graph, homeNode);
  const reachable = (nodeId: number) => nodeId !== homeNode && Number.isFinite(time[nodeId]);

  const candidates: Destination[] = [];
  for (const p of places) {
    const xy = proj.toXY(p.at);
    const d = dist(homeXY, xy);
    if (d < PLACE_MIN_M || d > PLACE_MAX_M) continue;
    // Snap to the nearest road node that can be reached from home, so a place beside a
    // cut-off service road still counts when a connected road is within PLACE_SNAP_MAX_M.
    const nodeId = nearestNode(graph, xy, PLACE_SNAP_MAX_M, reachable);
    if (nodeId === null) continue;
    candidates.push({ id: p.id, label: '', name: p.name, kind: p.kind, xy, nodeId });
  }
  // Places that snap to the same node are the same way out, so count distinct nodes.
  const placeNodes = new Set(candidates.map((d) => d.nodeId));
  if (placeNodes.size < 2) {
    for (const x of exitPoints(graph, homeXY, reachable)) if (!placeNodes.has(x.nodeId)) candidates.push(x);
  }
  if (candidates.length === 0) return emptyWaysOut(homeNode);

  // Outside the fire area first when the extra drive is small, then fastest; ties by id.
  const sorted = preferOutside(candidates, time, fireGrid);
  candidates.length = 0;
  candidates.push(...sorted);

  const mainDest = candidates[0];
  const mainEdges = pathEdges(graph, prevEdge, mainDest.nodeId, homeNode) ?? [];
  const main = routeFromEdges(graph, mainEdges, mainDest.id);

  // Backup: same search with the main route made expensive, to another destination.
  const onMain = new Set(mainEdges.map((eid) => segmentKey(graph, eid)));
  const penalized = shortestTimes(graph, homeNode, {
    edgeCost: (e) => (onMain.has(segmentKey(graph, e.id)) ? e.minutes * BACKUP_PENALTY : e.minutes),
  });
  // A backup at the main destination's node would just repeat the main route.
  const others = preferOutside(
    candidates.filter((d) => d.nodeId !== mainDest.nodeId && Number.isFinite(penalized.time[d.nodeId])),
    penalized.time,
    fireGrid,
  );
  const mainBearing = bearingDeg(homeXY, mainDest.xy);
  const backupDest =
    others.find((d) => angleDiff(bearingDeg(homeXY, d.xy), mainBearing) >= BACKUP_MIN_BEARING_DIFF) ??
    others[0] ??
    null;

  let backup: Route | null = null;
  if (backupDest) {
    const edges = pathEdges(graph, penalized.prevEdge, backupDest.nodeId, homeNode) ?? [];
    backup = routeFromEdges(graph, edges, backupDest.id);
  }

  // Labels: D1 main, D2 backup, then the rest in the order above.
  const ordered = [mainDest, ...(backupDest ? [backupDest] : [])];
  for (const d of candidates) if (!ordered.includes(d)) ordered.push(d);
  const destinations = ordered.map((d, i) => ({ ...d, label: shortLabel(`D${i + 1}`, d) }));

  // Shared stretch from the door: common prefix of undirected segments.
  let sharedFromDoorM = 0;
  const shared: number[] = [];
  if (backup) {
    for (let i = 0; i < main.edgeIds.length && i < backup.edgeIds.length; i++) {
      if (segmentKey(graph, main.edgeIds[i]) !== segmentKey(graph, backup.edgeIds[i])) break;
      shared.push(main.edgeIds[i]);
      sharedFromDoorM += graph.edges[main.edgeIds[i]].lengthM;
    }
  }
  const sharedRoadNames = shared.length > 0 ? routeFromEdges(graph, shared, '').roadNames : [];

  return { homeNodeId: homeNode, destinations, main, backup, sharedFromDoorM, sharedRoadNames };
}

/**
 * The road both ways out turn onto right where they split, when it is the same named road
 * (for example one goes north and one south on Central Avenue). A fire near that junction can
 * close both, so screens must not call this "more than one way out". Null otherwise.
 */
export function splitOnSameRoad(graph: RoadGraph, w: Pick<WaysOut, 'main' | 'backup'>): string | null {
  const { main, backup } = w;
  if (!main || !backup) return null;
  let k = 0;
  while (k < main.edgeIds.length && k < backup.edgeIds.length && segmentKey(graph, main.edgeIds[k]) === segmentKey(graph, backup.edgeIds[k])) k++;
  const a = main.edgeIds[k];
  const b = backup.edgeIds[k];
  if (a === undefined || b === undefined) return null;
  const name = graph.edges[a].name;
  return name && name !== 'Unnamed road' && graph.edges[b].name === name ? name : null;
}

/** Reachable nodes on major roads far from home, farthest first, in distinct directions. */
function exitPoints(graph: RoadGraph, homeXY: XY, reachable: (nodeId: number) => boolean): Destination[] {
  const roadAt = new Map<number, string>();
  for (const e of graph.edges) {
    if (!EXIT_HIGHWAYS.has(e.highway)) continue;
    if (!roadAt.has(e.from)) roadAt.set(e.from, e.name);
    if (!roadAt.has(e.to)) roadAt.set(e.to, e.name);
  }
  const far = [...roadAt.keys()]
    .filter((id) => reachable(id) && dist(homeXY, graph.nodes[id].xy) >= EXIT_MIN_M)
    .map((id) => ({ id, d: dist(homeXY, graph.nodes[id].xy), bearing: bearingDeg(homeXY, graph.nodes[id].xy) }))
    .sort((a, b) => b.d - a.d || a.id - b.id);

  const picked: typeof far = [];
  for (const c of far) {
    if (picked.length >= MAX_EXIT_POINTS) break;
    if (picked.every((p) => angleDiff(p.bearing, c.bearing) >= BACKUP_MIN_BEARING_DIFF)) picked.push(c);
  }
  return picked.map((c) => ({
    id: `exit-${c.id}`,
    label: '',
    name: exitPointName(roadAt.get(c.id) ?? ''),
    kind: 'exit_point' as const,
    xy: graph.nodes[c.id].xy,
    nodeId: c.id,
  }));
}

/** "where Highway 9 leaves the area"; unnamed roads read "where an unnamed road leaves the area". */
export function exitPointName(road: string): string {
  const named = road.trim() !== '' && road !== 'Unnamed road';
  return `where ${named ? road : 'an unnamed road'} leaves the area`;
}

// ---------- Road closures ----------

const SAMPLE_STEP_M = 25;

/** Per graph: grid+buffer key -> cell indices near each edge. */
const cellCache = new WeakMap<RoadGraph, Map<string, Int32Array[]>>();

function edgeCells(graph: RoadGraph, grid: FireGrid, bufferM: number): Int32Array[] {
  let perGraph = cellCache.get(graph);
  if (!perGraph) {
    perGraph = new Map();
    cellCache.set(graph, perGraph);
  }
  const key = `${grid.cellM}|${grid.size}|${grid.originXY.x}|${grid.originXY.y}|${bufferM}`;
  const cached = perGraph.get(key);
  if (cached) return cached;

  const n = grid.size;
  const radius = bufferM + grid.cellM / 2;
  const r2 = radius * radius;
  const byEdge: Int32Array[] = [];
  const bySegment = new Map<string, Int32Array>(); // reverse edges share the same cells
  for (const e of graph.edges) {
    const sk = segmentKey(graph, e.id) + `|${e.lengthM}`;
    const known = bySegment.get(sk);
    if (known) {
      byEdge.push(known);
      continue;
    }
    const cells = new Set<number>();
    for (const p of samplePolyline(e.shape, SAMPLE_STEP_M)) {
      const colLo = Math.max(0, Math.floor((p.x - radius - grid.originXY.x) / grid.cellM));
      const colHi = Math.min(n - 1, Math.floor((p.x + radius - grid.originXY.x) / grid.cellM));
      const rowLo = Math.max(0, Math.floor((p.y - radius - grid.originXY.y) / grid.cellM));
      const rowHi = Math.min(n - 1, Math.floor((p.y + radius - grid.originXY.y) / grid.cellM));
      for (let row = rowLo; row <= rowHi; row++) {
        for (let col = colLo; col <= colHi; col++) {
          const c = cellCenter(grid, col, row);
          const dx = c.x - p.x;
          const dy = c.y - p.y;
          if (dx * dx + dy * dy <= r2) cells.add(row * n + col);
        }
      }
    }
    const arr = Int32Array.from([...cells].sort((a, b) => a - b));
    bySegment.set(sk, arr);
    byEdge.push(arr);
  }
  perGraph.set(key, byEdge);
  return byEdge;
}

/** Where on each closing edge the fire first reaches it (edge id -> XY on the road). Open edges are absent. */
export type ClosurePoints = Map<number, XY>;

/**
 * Closure minute per edge plus the point where it closes: the nearest point on the road
 * to the first cell that ignites within bufferM. Ties go to the lowest cell index.
 */
export function edgeClosuresWithPoints(
  graph: RoadGraph,
  fire: FireResult,
  bufferM = 100,
): { closures: EdgeClosures; points: ClosurePoints } {
  const cellsByEdge = edgeCells(graph, fire.grid, bufferM);
  const n = fire.grid.size;
  const closures: EdgeClosures = new Map();
  const points: ClosurePoints = new Map();
  for (const e of graph.edges) {
    let best = Infinity;
    let bestCell = -1;
    for (const i of cellsByEdge[e.id]) {
      const ign = fire.ignitionMin[i];
      if (ign >= 0 && ign < best) {
        best = ign;
        bestCell = i;
      }
    }
    closures.set(e.id, best);
    if (bestCell >= 0) {
      const c = cellCenter(fire.grid, bestCell % n, Math.floor(bestCell / n));
      points.set(e.id, nearestPointOnPolyline(c, e.shape));
    }
  }
  return { closures, points };
}

/** Minute each edge closes: first ignition of a cell within bufferM of the road. Infinity = stays open. */
export function edgeClosures(graph: RoadGraph, fire: FireResult, bufferM = 100): EdgeClosures {
  return edgeClosuresWithPoints(graph, fire, bufferM).closures;
}

/** Edges with any part outside the fire grid. Their closures there are not modeled, so "open" is not known. */
export function edgesLeavingGrid(graph: RoadGraph, grid: FireGrid): Set<number> {
  const out = new Set<number>();
  // The grid is a rectangle, so a straight segment is inside if both its ends are.
  for (const e of graph.edges) if (e.shape.some((p) => !isInGrid(grid, p))) out.add(e.id);
  return out;
}

// ---------- Running a route ----------

/** Point halfway along a polyline. */
function midpoint(shape: XY[]): XY {
  const half = polylineLength(shape) / 2;
  let walked = 0;
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1];
    const b = shape[i];
    const seg = dist(a, b);
    if (walked + seg >= half && seg > 0) {
      const t = (half - walked) / seg;
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    walked += seg;
  }
  return { ...shape[0] };
}

export function runRoute(
  graph: RoadGraph,
  route: Route,
  departMin: number,
  closures: EdgeClosures,
  horizonMin: number,
  /** Where each edge closes; without it the binding point falls back to the edge midpoint. */
  closurePoints?: ClosurePoints,
): RouteRun {
  const legs: RouteRun['legs'] = [];
  let t = departMin;
  let binding: RouteRun['binding'] = null;
  for (const eid of route.edgeIds) {
    const e = graph.edges[eid];
    t += e.minutes;
    const close = closures.get(eid) ?? Infinity;
    const closeMin = close <= horizonMin ? close : Infinity;
    const marginMin = closeMin - t;
    legs.push({ edgeId: eid, name: e.name, exitMin: t, closeMin, marginMin });
    if (Number.isFinite(closeMin) && (binding === null || marginMin < binding.marginMin)) {
      const at = closurePoints?.get(eid);
      binding = { edgeId: eid, name: e.name, closeMin, passMin: t, marginMin, xy: at ? { ...at } : midpoint(e.shape) };
    }
  }
  const outcome: RouteRun['outcome'] = binding === null ? 'never_closed' : binding.marginMin < 0 ? 'short' : 'in_time';
  return { route, departMin, legs, binding, outcome, arriveMin: departMin + route.driveMin };
}

// ---------- Fire at the destination ----------

/** The fire counts as reaching a destination when it ignites a cell within this distance. */
export const DESTINATION_FIRE_RADIUS_M = 100;

/**
 * When the fire first comes within DESTINATION_FIRE_RADIUS_M of xy, and whether that is before
 * arriveMin. A destination outside the grid is not modeled: fireMin is Infinity and inGrid false.
 */
export function destinationFire(
  fire: FireResult,
  xy: XY,
  arriveMin: number,
): { fireMin: number; beforeArrival: boolean; inGrid: boolean } {
  const inGrid = isInGrid(fire.grid, xy);
  const raw = inGrid ? firstIgnitionWithin(fire, xy, DESTINATION_FIRE_RADIUS_M) : Infinity;
  const fireMin = raw <= fire.horizonMin ? raw : Infinity;
  return { fireMin, beforeArrival: fireMin <= arriveMin, inGrid };
}

// ---------- Does the main route's closure also block the backup? ----------

/** A backup edge on the same road name within this distance of the main closure counts as the same place. */
export const SAME_CLOSURE_RADIUS_M = 200;

export type BackupBlock = {
  blocked: boolean;
  /**
   * same_edge: the backup uses the very road segment that closes on the main route.
   * same_road_nearby: the backup uses the same named road within SAME_CLOSURE_RADIUS_M of the closure.
   * backup_short: the backup's own closure comes before you would pass it.
   * backup_closes_first: the backup closes no later than the main route does.
   */
  reason: 'same_edge' | 'same_road_nearby' | 'backup_short' | 'backup_closes_first' | null;
  /** Road to name in copy when blocked: the shared road, or the backup's own closing road. */
  roadName: string | null;
};

function distToShape(p: XY, shape: XY[]): number {
  if (shape.length === 1) return dist(p, shape[0]);
  let best = Infinity;
  for (let i = 1; i < shape.length; i++) best = Math.min(best, pointSegmentDistance(p, shape[i - 1], shape[i]));
  return best;
}

/** True when route uses a road named `name` within radiusM of xy. */
export function routeUsesRoadNear(graph: RoadGraph, route: Route, name: string, xy: XY, radiusM = SAME_CLOSURE_RADIUS_M): boolean {
  return route.edgeIds.some((id) => {
    const e = graph.edges[id];
    return e.name === name && distToShape(xy, e.shape) <= radiusM;
  });
}

/**
 * Whether "if the main route is closed, take the backup" would be false advice in this drill.
 * Use it before writing "If X is closed, take <backup>": when blocked, say both ways use X (or the
 * backup closes too) and to follow official directions instead.
 */
export function backupBlockedByMainClosure(graph: RoadGraph, main: RouteRun | null, backup: RouteRun | null): BackupBlock {
  const none: BackupBlock = { blocked: false, reason: null, roadName: null };
  if (!backup) return none;
  const b = main?.binding ?? null;
  if (b) {
    const segment = (id: number) => {
      const e = graph.edges[id];
      return e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    };
    const key = segment(b.edgeId);
    if (backup.route.edgeIds.some((id) => segment(id) === key)) return { blocked: true, reason: 'same_edge', roadName: b.name };
    if (routeUsesRoadNear(graph, backup.route, b.name, b.xy)) return { blocked: true, reason: 'same_road_nearby', roadName: b.name };
  }
  if (backup.outcome === 'short' && backup.binding) {
    return { blocked: true, reason: 'backup_short', roadName: backup.binding.name };
  }
  if (b && backup.binding && backup.binding.closeMin <= b.closeMin) {
    return { blocked: true, reason: 'backup_closes_first', roadName: backup.binding.name };
  }
  return none;
}

// ---------- The drill ----------

/** What runDrill needs from prepareArea (area.ts). */
export interface PreparedForDrill {
  graph: RoadGraph;
  fireGrid: FireGrid;
  elevationPerCell: Float32Array | null;
  waysOut: WaysOut;
}

const DEFAULT_HORIZON_MIN = 180;
const ONE_WAY_OUT_MIN_M = 200;
const METERS_PER_MILE = 1609.344;
const FIRE_NEAR_M = 805; // 0.5 mi

/**
 * What the drill could not model (local addition; types.ts DrillResult is unchanged).
 * The UI should refuse or move an off-grid ignition, and label unmodeled legs "not modeled", not "open".
 */
export interface DrillCoverage {
  /** False when the ignition is outside the fire grid: no fire was simulated and every route reads "never closed". */
  ignitionInGrid: boolean;
  /** Edges on the main route that leave the fire grid. */
  mainUnmodeledEdgeIds: number[];
  /** Edges on the backup route that leave the fire grid. */
  backupUnmodeledEdgeIds: number[];
}

export type DrillRun = DrillResult & { coverage: DrillCoverage };

export function runDrill(
  prepared: PreparedForDrill,
  tasks: Task[],
  setup: DrillSetup,
  opts: { horizonMin?: number } = {},
): DrillRun {
  const horizonMin = opts.horizonMin ?? DEFAULT_HORIZON_MIN;
  const fire = simulateFire(prepared.fireGrid, {
    ignition: setup.ignition,
    wind: setup.wind,
    seed: setup.seed,
    horizonMin,
    stepMin: 1,
    elevationPerCell: prepared.elevationPerCell,
  });
  const { closures, points } = edgeClosuresWithPoints(prepared.graph, fire);
  const tasksMin = tasksMinutes(tasks, setup.start);
  const { waysOut } = prepared;
  const destXY = (r: Route): XY => {
    const d = waysOut.destinations.find((x) => x.id === r.destinationId);
    if (d) return d.xy;
    const last = r.edgeIds[r.edgeIds.length - 1];
    return last === undefined ? { x: 0, y: 0 } : prepared.graph.nodes[prepared.graph.edges[last].to].xy;
  };
  const run = (r: Route | null): RouteRun | null => {
    if (!r) return null;
    const rr = runRoute(prepared.graph, r, tasksMin, closures, horizonMin, points);
    return { ...rr, destinationFire: destinationFire(fire, destXY(r), rr.arriveMin) };
  };
  const main = run(waysOut.main);
  const backup = run(waysOut.backup);

  const leaving = edgesLeavingGrid(prepared.graph, prepared.fireGrid);
  const unmodeled = (r: Route | null) => (r ? r.edgeIds.filter((id) => leaving.has(id)) : []);
  const coverage: DrillCoverage = {
    ignitionInGrid: isInGrid(prepared.fireGrid, setup.ignition),
    mainUnmodeledEdgeIds: unmodeled(waysOut.main),
    backupUnmodeledEdgeIds: unmodeled(waysOut.backup),
  };

  const bottlenecks: Bottleneck[] = [];
  if (main && main.outcome === 'short' && main.binding) {
    bottlenecks.push({
      kind: 'road_closed',
      title: 'Road closed by the fire',
      detail: `${main.binding.name} at T+${displayMin(main.binding.closeMin)}`,
      minutes: displayMin(main.binding.closeMin),
    });
  }
  if (waysOut.sharedFromDoorM >= ONE_WAY_OUT_MIN_M) {
    const miles = (waysOut.sharedFromDoorM / METERS_PER_MILE).toFixed(1);
    bottlenecks.push({
      kind: 'one_way_out',
      title: 'One way out',
      detail: `${waysOut.sharedRoadNames.join(', ')}, first ${miles} mi`,
    });
  }
  // A closure that blocks the backup at the same spot leaves one way out in this fire.
  const block = backupBlockedByMainClosure(prepared.graph, main, backup);
  const sharedClosure = block.reason === 'same_edge' || block.reason === 'same_road_nearby';
  if (sharedClosure && main?.binding && !bottlenecks.some((b) => b.kind === 'one_way_out')) {
    bottlenecks.push({
      kind: 'one_way_out',
      title: 'One way out',
      detail: `${main.binding.name} closes for both routes at T+${displayMin(main.binding.closeMin)}`,
      minutes: displayMin(main.binding.closeMin),
    });
  }
  const longest = tasks.reduce<Task | null>((best, t) => (best === null || t.minutes > best.minutes ? t : best), null);
  if (longest) {
    bottlenecks.push({ kind: 'longest_task', title: 'Longest task', detail: longest.label, minutes: longest.minutes });
  }

  const moments: { label: string; min: number }[] = [{ label: 'Order to leave', min: 0 }];
  const binding = main?.binding ?? null;
  if (binding) {
    // binding.xy is where the road closes, so this is never later than the closure.
    const near = firstIgnitionWithin(fire, binding.xy, FIRE_NEAR_M);
    if (Number.isFinite(near)) moments.push({ label: `Fire within 0.5 mi of ${binding.name}`, min: near });
  }
  moments.push({ label: 'Your car leaves home', min: tasksMin });
  if (binding) {
    moments.push({ label: `${binding.name} closes`, min: binding.closeMin });
    moments.push({ label: 'You would reach that point', min: binding.passMin });
  }
  if (main) {
    const dest = waysOut.destinations.find((d) => d.id === main.route.destinationId);
    const name = dest ? destTitle(dest) : 'the destination';
    moments.push({ label: `${main.outcome === 'short' ? 'You would reach' : 'You reach'} ${name}`, min: main.arriveMin });
    const df = main.destinationFire;
    if (df && Number.isFinite(df.fireMin)) moments.push({ label: `Fire reaches ${name}`, min: df.fireMin });
  }
  const keyMoments = moments
    .map((m) => ({ label: m.label, min: displayMin(m.min) }))
    .sort((a, b) => a.min - b.min); // stable: equal minutes keep story order

  return { setup, fire, closures, tasksMin, main, backup, bottlenecks, keyMoments, coverage };
}

/** Before/after comparison. Margins are the main route's binding margin (null if it never closed). */
export function compareRuns(
  before: DrillResult,
  after: DrillResult,
): { sameFire: boolean; savedMin: number; beforeMargin: number | null; afterMargin: number | null } {
  const a = before.setup;
  const b = after.setup;
  const sameFire =
    a.ignition.x === b.ignition.x &&
    a.ignition.y === b.ignition.y &&
    a.wind.fromDeg === b.wind.fromDeg &&
    a.wind.speedMph === b.wind.speedMph &&
    a.start === b.start &&
    a.seed === b.seed;
  return {
    sameFire,
    savedMin: before.tasksMin - after.tasksMin,
    beforeMargin: before.main?.binding?.marginMin ?? null,
    afterMargin: after.main?.binding?.marginMin ?? null,
  };
}
