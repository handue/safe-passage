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
  return CHANGE_TEXT[t.id] ?? (t.id.startsWith('custom-') || t.id.startsWith('added-') ? `Shorten: ${t.label}` : null);
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

/**
 * Kinds the rules and the AI may pick on their own. Evacuation traffic is shown with every result
 * (engine/spread.ts), so it is not picked again; the household can still type or pick it.
 */
export function autoPickKinds(h: HouseholdCounts, prepared: PreparedForDrill, base: DrillRun): SituationKind[] {
  return applicableKinds(h, prepared, base).filter((k) => k !== 'slow_traffic');
}

export function defaultSituations(h: HouseholdCounts, prepared: PreparedForDrill, base: DrillRun): SituationSpec[] {
  const ok = new Set(autoPickKinds(h, prepared, base));
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
  /** Set on rows the household typed ("Your situation"); then spec/info kind is only a type filler. */
  custom?: CustomSituation;
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

// ---------- Effects: one code path for catalog rows and custom rows ----------

const ALONE_TASKS = new Set(['gather', 'help', 'pets', 'load']);
const PETS_LABEL = 'Find pet carriers and pets';

/** The fixed order effects stack in, whatever order the parts were given in. */
const STACK_ORDER: SituationKind[] = ['pet_hides', 'no_car', 'adult_away', 'night', 'late_order', 'slow_traffic', 'road_blocked'];

/** Task changes first: changed minutes (0 removes the task), then added tasks at the end. */
function applyTaskChanges(tasks: Task[], parts: CustomParts): Task[] {
  const out: Task[] = [];
  for (const t of tasks) {
    const m = Object.hasOwn(parts.taskMinutes, t.id) ? parts.taskMinutes[t.id] : t.minutes;
    if (m > 0) out.push(m === t.minutes ? t : { ...t, minutes: m });
  }
  parts.addTasks.forEach((a, i) => out.push({ id: addedTaskId(tasks, i), label: a.label, minutes: a.minutes, source: 'estimate' }));
  return out;
}

/** Id for the i-th added task: "added-1", "added-2"..., skipping ids the household already uses. */
function addedTaskId(tasks: Task[], i: number): string {
  const used = new Set(tasks.map((t) => t.id));
  let n = 0;
  let id = '';
  for (let k = 0; k <= i; k++) {
    do id = `added-${++n}`;
    while (used.has(id));
  }
  return id;
}

/**
 * Stacks the kinds' effects on the (already changed) task list in STACK_ORDER. `petsMin` replaces
 * the pet_hides step's "original + extra" with a given value, so an action on the pets task is measured
 * BEFORE later steps (adult_away) multiply it, the same as the situation itself.
 */
function stack(ctx: Ctx, param: Map<SituationKind, number>, changed: Task[], petsMin?: number): Scenario {
  const sc: Scenario = {
    tasks: changed,
    wakeMin: ctx.base.setup.start === 'night' ? NIGHT_WAKE_MIN : 0,
    delayMin: 0,
    route: 'main',
    driveScale: 1,
  };
  for (const kind of STACK_ORDER) {
    const p = param.get(kind);
    if (p === undefined) continue;
    switch (kind) {
      case 'pet_hides': {
        const pets = sc.tasks.find((t) => t.id === 'pets');
        const m = petsMin ?? (pets?.minutes ?? 0) + p;
        sc.tasks = pets ? setTask(sc.tasks, 'pets', m) : [...sc.tasks, { id: 'pets', label: PETS_LABEL, minutes: m, source: 'estimate' }];
        break;
      }
      case 'no_car': {
        const ride: Task = { id: 'ride', label: 'Reach a ride', minutes: p, source: 'estimate' };
        sc.tasks = [...sc.tasks.filter((t) => t.id !== 'ride'), ride];
        break;
      }
      case 'adult_away':
        // Rounded up so a longer task never reads as unchanged.
        sc.tasks = sc.tasks.map((t) => (ALONE_TASKS.has(t.id) ? { ...t, minutes: Math.ceil(t.minutes * p - 1e-9) } : t));
        break;
      case 'night':
        sc.wakeMin = p;
        break;
      case 'late_order':
        sc.delayMin = p;
        break;
      case 'slow_traffic':
        sc.driveScale = p;
        break;
      case 'road_blocked':
        sc.route = 'backup';
        break;
    }
  }
  return sc;
}

/**
 * Applies every part on the same fire and lists the actions to measure. Effects stack in a fixed order:
 * task changes, then pet_hides / no_car / adult_away task effects, night wake, late_order delay,
 * slow_traffic multiplier, road_blocked -> backup. `generic` adds the custom-row actions
 * (shorten the slowest task, switch route) on top of each kind's own action.
 */
function applyEffects(ctx: Ctx, parts: CustomParts, tasks: Task[], generic: boolean): { scenario: Scenario; candidates: Candidate[] } {
  const param = new Map(parts.situations.map((s) => [s.kind, s.param]));
  const changed = applyTaskChanges(tasks, parts);
  const petsOriginal = changed.find((t) => t.id === 'pets')?.minutes ?? 0;
  const sc = stack(ctx, param, changed);
  const candidates: Candidate[] = [];
  const add = (c: Candidate | null) => {
    if (c) candidates.push(c);
  };
  const { backup, main } = ctx.prepared.waysOut;
  const switchBackup = (): Candidate | null =>
    sc.route === 'main' && backup
      ? {
          id: 'switch_backup',
          text: `Take the backup route on ${firstOwnRoad(ctx.prepared, backup.edgeIds, main) || 'the other road'}`,
          tag: 'calc',
          scenario: { ...sc, route: 'backup' },
        }
      : null;

  for (const { kind, param: p } of parts.situations) {
    switch (kind) {
      case 'night':
        add(shortenSlowest(sc, { night: true }));
        break;
      case 'late_order':
        add({ id: 'leave_on_warning', text: 'Leave when a warning is issued, not when the order comes', tag: 'calc', scenario: { ...sc, delayMin: 0 } });
        break;
      case 'adult_away':
        add(shortenSlowest(sc, { only: ALONE_TASKS }));
        break;
      case 'no_car':
        add({
          id: 'shorten:ride',
          text: CHANGE_TEXT.ride,
          tag: 'est',
          scenario: { ...sc, tasks: setTask(sc.tasks, 'ride', Math.max(1, Math.round(p / 3))) },
        });
        break;
      case 'slow_traffic': {
        // Switch only when it does better under the same slowdown; otherwise shorten the slowest task.
        const switched = switchBackup();
        const now = switched ? evaluate(ctx, sc).run : null;
        const alt = switched ? evaluate(ctx, switched.scenario).run : null;
        if (switched && now && alt && diff(marginOf(alt), marginOf(now)) > 0) add(switched);
        else add(shortenSlowest(sc));
        break;
      }
      case 'road_blocked':
        add(shortenSlowest(sc));
        break;
      case 'pet_hides':
        add({
          id: 'pets_inside',
          text: 'Keep pets inside on red flag days, carriers by the door',
          tag: 'est',
          // Re-stacked with the pets task shortened first, so a later multiplier (adult_away) still applies.
          scenario: stack(ctx, param, changed, Math.max(1, Math.round(petsOriginal / 3))),
        });
        break;
    }
  }
  if (generic) {
    add(shortenSlowest(sc));
    add(switchBackup()); // kept only when it helps: bestAction drops actions with no gain
  }
  return { scenario: sc, candidates };
}

// ---------- Custom situations (typed by the household, turned into parts) ----------

export interface CustomParts {
  /** Any of the 7 kinds, each at most once, params clamped with clampParam; road_blocked has param 0. */
  situations: { kind: SituationKind; param: number }[];
  /** New tasks, minutes 1..60 (whole), label at most 60 characters, at most 3. */
  addTasks: { label: string; minutes: number }[];
  /** Existing task id -> new minutes 0..60 (0 = task removed). */
  taskMinutes: Record<string, number>;
}

export interface CustomSituation {
  id: string;
  text: string;
  title: string;
  parts: CustomParts;
  titleSource: 'ai' | 'user';
  /** True once the user changed any value; the row then says "your values" instead of "starting guesses". */
  partsEdited?: boolean;
}

/**
 * Text the AI wrote that the user cannot edit carries no numbers the engine did not calculate:
 * numbers (with a unit word after them) are taken out, e.g. "Drive 20 miles to the barn" -> "Drive to the barn".
 */
export function withoutNumbers(s: string): string {
  return s
    .replace(/\[removed\]/gi, ' ')
    .replace(/\d+(?:[.,:]\d+)*\s*(?:%|minutes?|mins?|miles?|mi|km|hours?|hrs?|h|times|x)?(?![A-Za-z])/gi, ' ')
    .replace(/\d/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '')
    .trim();
}

export const MAX_ADD_TASKS = 3;
export const MAX_TASK_LABEL = 60;
export const MAX_TASK_MINUTES = 60;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

/** Whitelists kinds, clamps params and minutes, dedupes kinds, drops unknown task ids and no-op changes, caps added tasks. */
export function sanitizeCustomParts(raw: unknown, tasks: Task[]): CustomParts {
  const out: CustomParts = { situations: [], addTasks: [], taskMinutes: {} };
  if (!isObj(raw)) return out;
  const seen = new Set<SituationKind>();
  for (const s of Array.isArray(raw.situations) ? raw.situations : []) {
    if (!isObj(s) || typeof s.kind !== 'string' || !Object.hasOwn(SITUATIONS, s.kind)) continue;
    const kind = s.kind as SituationKind;
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.situations.push({ kind, param: clampParam(kind, s.param as number) });
  }
  for (const a of Array.isArray(raw.addTasks) ? raw.addTasks : []) {
    if (out.addTasks.length >= MAX_ADD_TASKS) break;
    if (!isObj(a) || typeof a.label !== 'string' || !isNum(a.minutes)) continue;
    const label = withoutNumbers(a.label).slice(0, MAX_TASK_LABEL).trim();
    if (!label) continue;
    out.addTasks.push({ label, minutes: clampInt(a.minutes, 1, MAX_TASK_MINUTES) });
  }
  if (isObj(raw.taskMinutes)) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const [id, m] of Object.entries(raw.taskMinutes)) {
      const t = byId.get(id);
      if (!t || !isNum(m)) continue;
      const minutes = clampInt(m, 0, MAX_TASK_MINUTES);
      if (minutes !== t.minutes) out.taskMinutes[id] = minutes;
    }
  }
  return out;
}

/**
 * A typed task change is stored as absolute minutes against the household's own tasks. When the
 * task list changes (Fix screen), scale it by the same ratio: help 6 -> 10 typed, Fix help 6 -> 2,
 * gives help 3 on the after run (the same as the "a third" next action measured on the row).
 * Removed tasks (0) stay removed; a task the Fix removed (0) is removed here too.
 */
export function rebaseCustomParts(parts: CustomParts, baseTasks: Task[], nowTasks: Task[]): CustomParts {
  const base = new Map(baseTasks.map((t) => [t.id, t.minutes]));
  const now = new Map(nowTasks.map((t) => [t.id, t.minutes]));
  let taskMinutes: Record<string, number> | null = null;
  for (const [id, m] of Object.entries(parts.taskMinutes)) {
    const b = base.get(id);
    const n = now.get(id);
    if (b === undefined || n === undefined || b === n || m === 0) continue;
    taskMinutes ??= { ...parts.taskMinutes };
    taskMinutes[id] = b <= 0 || n <= 0 ? n : clampInt(Math.max(1, (m * n) / b), 1, MAX_TASK_MINUTES);
  }
  return taskMinutes ? { ...parts, taskMinutes } : parts;
}

export function emptyParts(p: CustomParts): boolean {
  return p.situations.length === 0 && p.addTasks.length === 0 && Object.keys(p.taskMinutes).length === 0;
}

/** Plain words for one part, starting lower case, no final period. */
function partWords(prepared: PreparedForDrill, kind: SituationKind, p: number): string {
  const v = fmtParam(p);
  switch (kind) {
    case 'night':
      return `the fire starts at night, and waking everyone takes ${v} min`;
    case 'late_order':
      return `leave ${v} min after the fire starts, when the order comes`;
    case 'adult_away':
      return `one adult is away, so gathering, helping, pets and loading take ${v} times longer`;
    case 'no_car':
      return `the car is not available, so reaching a ride takes ${v} min`;
    case 'slow_traffic':
      return `traffic or smoke makes every road take ${v} times longer to drive`;
    case 'road_blocked': {
      const t = (blockedText(prepared) || 'The main route is blocked from the start, so you take the backup route.').replace(/\.$/, '');
      return /^(A |Part |The )/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
    }
    case 'pet_hides':
      return `a pet hides, and finding it takes ${v} extra min`;
  }
}

/** One sentence listing every part, e.g. "Leave 20 min after...; added task: Hitch the horse trailer (15 min)." */
function customAssumption(prepared: PreparedForDrill, parts: CustomParts, tasks: Task[]): string {
  const words = parts.situations.map((s) => partWords(prepared, s.kind, s.param));
  for (const t of tasks) {
    if (!Object.hasOwn(parts.taskMinutes, t.id)) continue;
    const m = parts.taskMinutes[t.id];
    words.push(m === 0 ? `skip: ${t.label}` : `${t.label} takes ${m} min`);
  }
  for (const a of parts.addTasks) words.push(`added task: ${a.label} (${a.minutes} min)`);
  if (words.length === 0) return 'Nothing changes from this drill.';
  const s = words.join('; ');
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
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

function newCtx(prepared: PreparedForDrill, base: DrillRun): Ctx {
  return { prepared, base, points: null, scaled: new Map() };
}

/**
 * The main route on base's fire with every road taking k times longer to drive (evacuation traffic).
 * Same tasks and wake-up as the drill; no new fire is simulated.
 */
export function runWithDriveScale(prepared: PreparedForDrill, base: DrillRun, tasks: Task[], k: number): RouteRun | null {
  const ctx = newCtx(prepared, base);
  const wakeMin = base.setup.start === 'night' ? NIGHT_WAKE_MIN : 0;
  return evaluate(ctx, { tasks, wakeMin, delayMin: 0, route: 'main', driveScale: k }).run;
}

/** Runs the scenario on the fixed fire and measures the next action. Shared by catalog and custom rows. */
function finish(ctx: Ctx, spec: SituationSpec, info: SituationInfo, scenario: Scenario, candidates: Candidate[]): SituationResult {
  const baseMargin = ctx.base.main ? marginOf(ctx.base.main) : null;
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
}

function runCatalog(ctx: Ctx, raw: SituationSpec, tasks: Task[]): SituationResult {
  const spec: SituationSpec = { ...raw, param: clampParam(raw.kind, raw.param) };
  const parts: CustomParts = { situations: [{ kind: spec.kind, param: spec.param }], addTasks: [], taskMinutes: {} };
  const { scenario, candidates } = applyEffects(ctx, parts, tasks, false);
  let info = SITUATIONS[spec.kind];
  if (spec.kind === 'road_blocked') {
    const text = blockedText(ctx.prepared);
    if (text) info = { ...info, assumption: () => text };
  }
  return finish(ctx, spec, info, scenario, candidates);
}

function runCustom(ctx: Ctx, tasks: Task[], custom: CustomSituation): SituationResult {
  const parts = sanitizeCustomParts(custom.parts, tasks);
  const clean: CustomSituation = { ...custom, parts };
  // spec/info kind is only a type filler: screens must check `custom` first.
  const kind: SituationKind = parts.situations[0]?.kind ?? 'night';
  const sentence = customAssumption(ctx.prepared, parts, tasks);
  const info: SituationInfo = {
    kind,
    title: custom.title.trim() || 'Your situation',
    paramUnit: 'min',
    paramLabel: '',
    defaultParam: 0,
    minParam: 0,
    maxParam: 0,
    assumption: () => sentence,
  };
  const spec: SituationSpec = { kind, param: 0, source: 'ai' };
  const { scenario, candidates } = applyEffects(ctx, parts, tasks, true);
  return { ...finish(ctx, spec, info, scenario, candidates), custom: clean };
}

export function runSituations(prepared: PreparedForDrill, base: DrillRun, tasks: Task[], specs: SituationSpec[]): SituationResult[] {
  const ctx = newCtx(prepared, base);
  return specs.map((raw) => runCatalog(ctx, raw, tasks));
}

/**
 * Applies ALL parts of a custom situation together on the same fire (no new fire simulation).
 * The result carries `custom` (with sanitized parts); its `info` is synthetic: title = custom.title,
 * assumption = one sentence listing every part.
 */
export function runCustomSituation(prepared: PreparedForDrill, base: DrillRun, tasks: Task[], custom: CustomSituation): SituationResult {
  return runCustom(newCtx(prepared, base), tasks, custom);
}

/** Several custom rows sharing one closure-point / scaled-graph cache. */
export function runCustomSituations(prepared: PreparedForDrill, base: DrillRun, tasks: Task[], customs: CustomSituation[]): SituationResult[] {
  const ctx = newCtx(prepared, base);
  return customs.map((c) => runCustom(ctx, tasks, c));
}

/** Count for headlines: results that are not short and have a route. Custom rows can be passed as a second list. */
export function passCount(results: SituationResult[], custom: SituationResult[] = []): { pass: number; total: number } {
  const all = [...results, ...custom];
  const pass = all.filter((r) => r.outcome !== 'short' && r.outcome !== 'no_route').length;
  return { pass, total: all.length };
}
