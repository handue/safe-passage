// Other situations, same fire: the fire stays fixed (base.fire / base.closures) and the household's
// situation changes. Each situation is computed here; nothing simulates a new fire.
import type { RoadGraph, Route, RouteRun, Task } from './types';
import {
  NIGHT_WAKE_MIN,
  destinationFire,
  edgeClosuresWithPoints,
  routeDestXY,
  runRoute,
  segmentKey,
  type ClosurePoints,
  type DrillRun,
  type HouseholdCounts,
  type PreparedForDrill,
} from './drill';

export type SituationKind = 'night' | 'late_order' | 'adult_away' | 'no_car' | 'slow_traffic' | 'road_blocked' | 'pet_hides';

export interface SituationSpec {
  kind: SituationKind;
  param: number;
  reason?: string;
  source: 'ai' | 'rules';
}

export interface SituationInfo {
  kind: SituationKind;
  title: string;
  paramUnit: 'min' | 'x';
  paramLabel: string;
  defaultParam: number;
  minParam: number;
  maxParam: number;
  /** One sentence describing what the engine changes. */
  assumption: (p: number) => string;
}

/** "1.5" for multipliers, "10" for minutes. */
function fmtParam(p: number): string {
  return String(Math.round(p * 10) / 10);
}

export const SITUATIONS: Record<SituationKind, SituationInfo> = {
  night: {
    kind: 'night',
    title: 'Night start',
    paramUnit: 'min',
    paramLabel: 'minutes to wake everyone',
    defaultParam: NIGHT_WAKE_MIN,
    minParam: 1,
    maxParam: 15,
    assumption: (p) => `The fire starts at night, and waking everyone takes ${fmtParam(p)} min.`,
  },
  late_order: {
    kind: 'late_order',
    title: 'Order comes late',
    paramUnit: 'min',
    paramLabel: 'minutes after the fire starts',
    defaultParam: 10,
    minParam: 5,
    maxParam: 30,
    assumption: (p) => `The order to leave comes ${fmtParam(p)} min after the fire starts.`,
  },
  adult_away: {
    kind: 'adult_away',
    title: 'One adult away',
    paramUnit: 'x',
    paramLabel: 'times longer',
    defaultParam: 1.5,
    minParam: 1.2,
    maxParam: 2,
    assumption: (p) => `One adult is away, so gathering, helping, pets and loading take ${fmtParam(p)} times longer.`,
  },
  no_car: {
    kind: 'no_car',
    title: 'Car not available',
    paramUnit: 'min',
    paramLabel: 'minutes to reach a ride',
    defaultParam: 10,
    minParam: 5,
    maxParam: 30,
    assumption: (p) => `The car is not available, so reaching a ride takes ${fmtParam(p)} min.`,
  },
  slow_traffic: {
    kind: 'slow_traffic',
    title: 'Slow traffic or smoke',
    paramUnit: 'x',
    paramLabel: 'times longer',
    defaultParam: 1.5,
    minParam: 1.2,
    maxParam: 3,
    assumption: (p) => `Traffic or smoke makes every road take ${fmtParam(p)} times longer to drive.`,
  },
  road_blocked: {
    kind: 'road_blocked',
    title: 'Main route blocked',
    paramUnit: 'min',
    paramLabel: '',
    defaultParam: 0,
    minParam: 0,
    maxParam: 0,
    assumption: () => 'The main route is blocked from the start, so you take the backup route.',
  },
  pet_hides: {
    kind: 'pet_hides',
    title: 'A pet hides',
    paramUnit: 'min',
    paramLabel: 'extra minutes',
    defaultParam: 10,
    minParam: 5,
    maxParam: 30,
    assumption: (p) => `A pet hides, and finding it takes ${fmtParam(p)} extra min.`,
  },
};

const ALL_KINDS = Object.keys(SITUATIONS) as SituationKind[];

/** Clamp to the kind's range. Minutes are whole numbers, multipliers keep one decimal. Non-numbers get the default. */
export function clampParam(kind: SituationKind, p: number): number {
  const info = SITUATIONS[kind];
  if (typeof p !== 'number' || !Number.isFinite(p)) return info.defaultParam;
  const step = info.paramUnit === 'min' ? 1 : 10;
  const rounded = info.paramUnit === 'min' ? Math.round(p) : Math.round(p * step) / step;
  return Math.min(info.maxParam, Math.max(info.minParam, rounded));
}

/** What the household can change for each task, in plain words (same wording as the Fix screen). */
export const CHANGE_TEXT: Record<string, string> = {
  pets: 'Keep pet carriers by the front door',
  meds: 'Put medications in the go-bag',
  docs: 'Keep documents and chargers in the go-bag',
  gather: 'Agree on one meeting point inside the house',
  help: 'Plan who helps whom ahead of time',
  load: 'Pack the car the night before a red flag day',
  ride: 'Arrange a ride with a neighbor ahead of time',
};

/** The change for a task, or null when there is none to offer. Tasks the user added get a generic row. */
export function changeText(t: Pick<Task, 'id' | 'label'>): string | null {
  return CHANGE_TEXT[t.id] ?? (t.id.startsWith('custom-') ? `Shorten: ${t.label}` : null);
}

/** Main route edges whose road segment is not on the backup (both directions compared). */
function mainOnlyEdges(prepared: PreparedForDrill): number[] {
  const { main, backup } = prepared.waysOut;
  if (!main) return [];
  const onBackup = new Set((backup?.edgeIds ?? []).map((id) => segmentKey(prepared.graph, id)));
  return main.edgeIds.filter((id) => !onBackup.has(segmentKey(prepared.graph, id)));
}

export function applicableKinds(h: HouseholdCounts, prepared: PreparedForDrill, base: DrillRun): SituationKind[] {
  return ALL_KINDS.filter((k) => {
    switch (k) {
      case 'night':
        return base.setup.start === 'day';
      case 'adult_away':
        return h.adults >= 2;
      case 'no_car':
        return h.cars >= 1;
      case 'pet_hides':
        return h.dogs + h.catsAndSmallPets > 0;
      case 'road_blocked':
        return mainOnlyEdges(prepared).length > 0;
      default:
        return true;
    }
  });
}

const RULES_ORDER: SituationKind[] = ['late_order', 'road_blocked', 'night', 'adult_away', 'pet_hides', 'slow_traffic', 'no_car'];
const MAX_SITUATIONS = 6;

export function defaultSituations(h: HouseholdCounts, prepared: PreparedForDrill, base: DrillRun): SituationSpec[] {
  const ok = new Set(applicableKinds(h, prepared, base));
  return RULES_ORDER.filter((k) => ok.has(k))
    .slice(0, MAX_SITUATIONS)
    .map((kind) => ({ kind, param: SITUATIONS[kind].defaultParam, source: 'rules' as const }));
}

export interface NextAction {
  id: string;
  text: string;
  /** calc: effect fully computed; est: uses an app starting estimate for task minutes (a third of the task). */
  tag: 'calc' | 'est';
  /** New margin on the route used; Infinity if that route never closes. */
  marginMin: number;
  /** marginMin(after action) - marginMin(situation); Infinity when the action makes the route never close. */
  gainMin: number;
  outcome: RouteRun['outcome'];
  /** The route run with the action taken, so screens can show its T+ values with the same rounding. */
  run: RouteRun;
}

export interface SituationResult {
  spec: SituationSpec;
  info: SituationInfo;
  tasks: Task[];
  tasksMin: number;
  departMin: number;
  route: 'main' | 'backup' | null;
  run: RouteRun | null;
  outcome: RouteRun['outcome'] | 'no_route';
  marginMin: number | null;
  deltaMin: number | null;
  nextAction: NextAction | null;
}

// ---------- Running one scenario on the fixed fire ----------

/** Everything that decides one run: tasks, wake-up minutes, order delay, route and drive-time multiplier. */
interface Scenario {
  tasks: Task[];
  wakeMin: number;
  delayMin: number;
  route: 'main' | 'backup';
  driveScale: number;
}

interface Ctx {
  prepared: PreparedForDrill;
  base: DrillRun;
  points: ClosurePoints | null;
  scaled: Map<number, RoadGraph>;
}

/** Closure points for binding positions, from the SAME fire (no new simulation). */
function closurePoints(ctx: Ctx): ClosurePoints {
  if (!ctx.points) ctx.points = edgeClosuresWithPoints(ctx.prepared.graph, ctx.base.fire).points;
  return ctx.points;
}

/** A copy of the graph with every edge's minutes scaled. The original graph is not changed. */
function scaledGraph(ctx: Ctx, k: number): RoadGraph {
  let g = ctx.scaled.get(k);
  if (!g) {
    const src = ctx.prepared.graph;
    g = { ...src, edges: src.edges.map((e) => ({ ...e, minutes: e.minutes * k })) };
    ctx.scaled.set(k, g);
  }
  return g;
}

function sumMinutes(tasks: Task[]): number {
  let s = 0;
  for (const t of tasks) s += t.minutes;
  return s;
}

function evaluate(ctx: Ctx, sc: Scenario): { tasksMin: number; departMin: number; run: RouteRun | null } {
  const tasksMin = sumMinutes(sc.tasks) + sc.wakeMin;
  const departMin = sc.delayMin + tasksMin;
  const r: Route | null = ctx.prepared.waysOut[sc.route];
  if (!r) return { tasksMin, departMin, run: null };
  const k = sc.driveScale;
  const graph = k === 1 ? ctx.prepared.graph : scaledGraph(ctx, k);
  const driven = k === 1 ? r : { ...r, driveMin: r.driveMin * k };
  const rr = runRoute(graph, driven, departMin, ctx.base.closures, ctx.base.fire.horizonMin, closurePoints(ctx));
  const run: RouteRun = { ...rr, route: r, destinationFire: destinationFire(ctx.base.fire, routeDestXY(ctx.prepared, r), rr.arriveMin) };
  return { tasksMin, departMin, run };
}

const marginOf = (run: RouteRun): number => (run.binding ? run.binding.marginMin : Infinity);

/** Difference that stays finite-safe: both never close -> 0; better to never close -> Infinity. */
function diff(a: number, b: number): number {
  if (a === b) return 0;
  return a - b;
}

// ---------- Next actions ----------

interface Candidate {
  id: string;
  text: string;
  tag: 'calc' | 'est';
  scenario: Scenario;
}

const BAG_TASKS = new Set(['meds', 'docs', 'load']);

/** Shorten the slowest task (optionally among some ids) to a third, like the Fix screen's default. */
function shortenSlowest(sc: Scenario, opts: { only?: Set<string>; night?: boolean } = {}): Candidate | null {
  let slow: Task | null = null;
  for (const t of sc.tasks) {
    if (opts.only && !opts.only.has(t.id)) continue;
    if (slow === null || t.minutes > slow.minutes) slow = t;
  }
  if (!slow) return null;
  const target = Math.max(1, Math.round(slow.minutes / 3));
  if (target >= slow.minutes) return null;
  const text =
    opts.night && BAG_TASKS.has(slow.id)
      ? 'Pack the go-bag before bed on red flag nights'
      : changeText(slow) ?? `Shorten: ${slow.label}`;
  const id = slow.id;
  return {
    id: `shorten:${id}`,
    text,
    tag: 'est',
    scenario: { ...sc, tasks: sc.tasks.map((t) => (t.id === id ? { ...t, minutes: target } : t)) },
  };
}

function setTask(tasks: Task[], id: string, minutes: number): Task[] {
  return tasks.map((t) => (t.id === id ? { ...t, minutes } : t));
}

function firstOwnRoad(prepared: PreparedForDrill, edgeIds: number[], other: Route | null): string {
  // Prefer a road the other route never uses by name, so "on X" never names a shared road.
  const otherNames = new Set((other?.edgeIds ?? []).map((id) => prepared.graph.edges[id].name));
  const ownName = edgeIds.map((id) => prepared.graph.edges[id].name).find((n) => n && !otherNames.has(n));
  if (ownName) return ownName;
  const onOther = new Set((other?.edgeIds ?? []).map((id) => segmentKey(prepared.graph, id)));
  const own = edgeIds.find((id) => !onOther.has(segmentKey(prepared.graph, id)));
  const pick = own ?? edgeIds[0];
  return pick === undefined ? '' : prepared.graph.edges[pick].name;
}

/**
 * The road_blocked sentence. It names a main-only road the backup never uses; when every main-only
 * stretch is on a road the backup also uses (by name), it says only a stretch of that road is blocked,
 * so the backup driving the same road elsewhere does not read as a contradiction.
 */
function blockedText(prepared: PreparedForDrill): string {
  const blocked = mainOnlyEdges(prepared);
  if (blocked.length === 0) return '';
  const { graph, waysOut } = prepared;
  const backupNames = new Set((waysOut.backup?.edgeIds ?? []).map((id) => graph.edges[id].name).filter(Boolean));
  const ownName = blocked.map((id) => graph.edges[id].name).find((n) => n && !backupNames.has(n));
  if (ownName) return `${ownName} is blocked from the start, so you take the backup route.`;
  const shared = blocked.map((id) => graph.edges[id].name).find(Boolean);
  const via = waysOut.backup ? firstOwnRoad(prepared, waysOut.backup.edgeIds, waysOut.main) : '';
  const head = shared ? `A stretch of ${shared} on the main route` : 'Part of the main route';
  const tail = via && via !== shared ? `, so you take the backup route by ${via}.` : ', so you take the backup route.';
  return `${head} is blocked from the start${tail}`;
}

// ---------- Situations ----------

const ALONE_TASKS = new Set(['gather', 'help', 'pets', 'load']);
const PETS_LABEL = 'Find pet carriers and pets';

function build(
  ctx: Ctx,
  spec: SituationSpec,
  tasks: Task[],
): { info: SituationInfo; scenario: Scenario; candidates: Candidate[] } {
  const p = spec.param;
  const baseWake = ctx.base.setup.start === 'night' ? NIGHT_WAKE_MIN : 0;
  const sc: Scenario = { tasks, wakeMin: baseWake, delayMin: 0, route: 'main', driveScale: 1 };
  let info = SITUATIONS[spec.kind];
  const candidates: Candidate[] = [];
  const add = (c: Candidate | null) => {
    if (c) candidates.push(c);
  };

  switch (spec.kind) {
    case 'night': {
      sc.wakeMin = p;
      add(shortenSlowest(sc, { night: true }));
      break;
    }
    case 'late_order': {
      sc.delayMin = p;
      add({ id: 'leave_on_warning', text: 'Leave when a warning is issued, not when the order comes', tag: 'calc', scenario: { ...sc, delayMin: 0 } });
      break;
    }
    case 'adult_away': {
      // Rounded up so a longer task never reads as unchanged.
      sc.tasks = tasks.map((t) => (ALONE_TASKS.has(t.id) ? { ...t, minutes: Math.ceil(t.minutes * p - 1e-9) } : t));
      add(shortenSlowest(sc, { only: ALONE_TASKS }));
      break;
    }
    case 'no_car': {
      const ride: Task = { id: 'ride', label: 'Reach a ride', minutes: p, source: 'estimate' };
      sc.tasks = [...tasks.filter((t) => t.id !== 'ride'), ride];
      add({
        id: 'shorten:ride',
        text: CHANGE_TEXT.ride,
        tag: 'est',
        scenario: { ...sc, tasks: setTask(sc.tasks, 'ride', Math.max(1, Math.round(p / 3))) },
      });
      break;
    }
    case 'slow_traffic': {
      sc.driveScale = p;
      const { backup } = ctx.prepared.waysOut;
      const switched: Candidate | null = backup
        ? {
            id: 'switch_backup',
            text: `Take the backup route on ${firstOwnRoad(ctx.prepared, backup.edgeIds, ctx.prepared.waysOut.main) || 'the other road'}`,
            tag: 'calc',
            scenario: { ...sc, route: 'backup' },
          }
        : null;
      // Switch only when it does better under the same slowdown; otherwise shorten the slowest task.
      const now = evaluate(ctx, sc).run;
      const alt = switched ? evaluate(ctx, switched.scenario).run : null;
      if (switched && now && alt && diff(marginOf(alt), marginOf(now)) > 0) add(switched);
      else add(shortenSlowest(sc));
      break;
    }
    case 'road_blocked': {
      sc.route = 'backup';
      const text = blockedText(ctx.prepared);
      if (text) info = { ...info, assumption: () => text };
      add(shortenSlowest(sc));
      break;
    }
    case 'pet_hides': {
      const pets = tasks.find((t) => t.id === 'pets');
      const original = pets?.minutes ?? 0;
      sc.tasks = pets
        ? setTask(tasks, 'pets', original + p)
        : [...tasks, { id: 'pets', label: PETS_LABEL, minutes: p, source: 'estimate' }];
      add({
        id: 'pets_inside',
        text: 'Keep pets inside on red flag days, carriers by the door',
        tag: 'est',
        scenario: { ...sc, tasks: setTask(sc.tasks, 'pets', Math.max(1, Math.round(original / 3))) },
      });
      break;
    }
  }
  return { info, scenario: sc, candidates };
}

function bestAction(ctx: Ctx, situationMargin: number, candidates: Candidate[]): NextAction | null {
  let best: NextAction | null = null;
  for (const c of candidates) {
    const run = evaluate(ctx, c.scenario).run;
    if (!run) continue;
    const marginMin = marginOf(run);
    const gainMin = diff(marginMin, situationMargin);
    if (!(gainMin > 0)) continue;
    const better = best === null || gainMin > best.gainMin || (gainMin === best.gainMin && c.tag === 'calc' && best.tag !== 'calc');
    if (better) best = { id: c.id, text: c.text, tag: c.tag, marginMin, gainMin, outcome: run.outcome, run };
  }
  return best;
}

export function runSituations(prepared: PreparedForDrill, base: DrillRun, tasks: Task[], specs: SituationSpec[]): SituationResult[] {
  const ctx: Ctx = { prepared, base, points: null, scaled: new Map() };
  const baseMargin = base.main ? marginOf(base.main) : null;
  return specs.map((raw) => {
    const spec: SituationSpec = { ...raw, param: clampParam(raw.kind, raw.param) };
    const { info, scenario, candidates } = build(ctx, spec, tasks);
    const { tasksMin, departMin, run } = evaluate(ctx, scenario);
    if (!run) {
      return { spec, info, tasks: scenario.tasks, tasksMin, departMin, route: null, run: null, outcome: 'no_route', marginMin: null, deltaMin: null, nextAction: null };
    }
    const marginMin = marginOf(run);
    return {
      spec,
      info,
      tasks: scenario.tasks,
      tasksMin,
      departMin,
      route: scenario.route,
      run,
      outcome: run.outcome,
      marginMin,
      deltaMin: baseMargin === null ? null : diff(marginMin, baseMargin),
      nextAction: bestAction(ctx, marginMin, candidates),
    };
  });
}

/** Count for headlines: results that are not short and have a route. */
export function passCount(results: SituationResult[]): { pass: number; total: number } {
  const pass = results.filter((r) => r.outcome !== 'short' && r.outcome !== 'no_route').length;
  return { pass, total: results.length };
}
