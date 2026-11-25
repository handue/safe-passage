// App state: one store for the whole flow, kept in memory (nothing personal is saved).
import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import type { AreaData, DrillSetup, Household, Route, StartTime, Task, WaysOut, Wind, XY } from '../engine/types';
import { prepareArea, type PreparedArea } from '../engine/area';
import { defaultTasks, runDrill, type DrillRun } from '../engine/drill';
import { suggestIgnitions, type IgnitionSuggestion } from '../engine/ignition';
import type { PlanResponse } from './api';

export type LoadStep = { label: string; state: 'done' | 'working' | 'waiting' };

/** How exactly an address match places home (from the server's geocode result). */
export type MatchPrecision = 'house' | 'street' | 'place';

/** What the user typed and picked on the address screen, kept so going back does not lose it. */
export interface Entry {
  query: string;
  /** The pick list from the last search, or null when there was none. */
  choices: { label: string; lat: number; lon: number; country: string; precision?: MatchPrecision }[] | null;
  /** The address the current load uses, shown on the loading screen. */
  matched: { label: string; precision?: MatchPrecision } | null;
}

export interface Fixes {
  /** Task id -> new minutes the user expects after the change (their estimate). */
  taskMinutes: Record<string, number>;
  /** Swap main and backup routes. */
  switchMainRoute: boolean;
}

export interface AppState {
  load: { status: 'idle' | 'loading' | 'ready' | 'error'; steps: LoadStep[]; error?: { code: string; message: string } };
  area: AreaData | null;
  prepared: PreparedArea | null;
  isDemo: boolean;
  household: Household;
  /** Drill setup the user is editing. */
  setup: { ignition: XY | null; wind: Wind; start: StartTime; seed: number };
  suggestions: IgnitionSuggestion[];
  /** First run of the current setup with the household as it is. */
  before: DrillRun | null;
  fixes: Fixes;
  /** Same fire, household with fixes applied. */
  after: DrillRun | null;
  plan: { status: 'idle' | 'loading' | 'ready'; data: PlanResponse | null };
  meeting: { primary: string; ifClosed: string; contact: string };
  entry: Entry;
}

/** Fixed drill wind for the demo address ("Strong wind day" from the northeast), so the
 * no-typing demo always shows the same fire, one that closes the road out. */
export const DEMO_WIND: Wind = { fromDeg: 45, speedMph: 25, source: 'manual' };

/** True when this wind is the demo preset (only meaningful at the demo address). */
export function isDemoWind(w: Wind): boolean {
  return w.source === DEMO_WIND.source && w.fromDeg === DEMO_WIND.fromDeg && w.speedMph === DEMO_WIND.speedMph;
}

/** Where the drill wind came from, in words: "forecast", "set by you" or "demo preset". */
export function windSourceWord(w: Wind, isDemo: boolean): string {
  if (w.source === 'forecast') return 'forecast';
  return isDemo && isDemoWind(w) ? 'demo preset' : 'set by you';
}

const DEMO_HOUSEHOLD = { adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 1, cars: 1 };

export function initialState(): AppState {
  return {
    load: { status: 'idle', steps: [] },
    area: null,
    prepared: null,
    isDemo: false,
    household: { ...DEMO_HOUSEHOLD, tasks: defaultTasks(DEMO_HOUSEHOLD) },
    setup: { ignition: null, wind: { fromDeg: 45, speedMph: 20, source: 'manual' }, start: 'day', seed: 1 },
    suggestions: [],
    before: null,
    fixes: { taskMinutes: {}, switchMainRoute: false },
    after: null,
    plan: { status: 'idle', data: null },
    meeting: { primary: '', ifClosed: '', contact: '' },
    entry: { query: '', choices: null, matched: null },
  };
}

export type Action =
  | { type: 'load/start'; steps: string[] }
  | { type: 'load/step'; index: number }
  | { type: 'load/error'; code: string; message: string }
  | { type: 'load/done'; area: AreaData; isDemo: boolean }
  | { type: 'household/set'; household: Household }
  | { type: 'setup/set'; patch: Partial<AppState['setup']> }
  | { type: 'drill/run' }
  | { type: 'fixes/set'; fixes: Fixes }
  | { type: 'plan/loading' }
  | { type: 'plan/done'; data: PlanResponse }
  | { type: 'meeting/set'; patch: Partial<AppState['meeting']> }
  | { type: 'entry/set'; patch: Partial<Entry> }
  | { type: 'reset' };

/** Route shape in local XY for drawing and for ignition suggestions. */
export function routeShape(prepared: PreparedArea, route: Route | null): XY[] {
  return route ? route.edgeIds.flatMap((id) => prepared.graph.edges[id].shape) : [];
}

function suggest(prepared: PreparedArea, wind: Wind): IgnitionSuggestion[] {
  const w = prepared.waysOut;
  return suggestIgnitions(prepared.fireGrid, prepared.elevationPerCell, wind, prepared.homeXY, routeShape(prepared, w.main), [routeShape(prepared, w.backup)]);
}

/** Household tasks with the chosen fixes applied. */
export function fixedTasks(tasks: Task[], fixes: Fixes): Task[] {
  return tasks.map((t) => (fixes.taskMinutes[t.id] !== undefined ? { ...t, minutes: fixes.taskMinutes[t.id] } : t));
}

export function swappedWaysOut(w: WaysOut): WaysOut {
  return w.backup ? { ...w, main: w.backup, backup: w.main } : w;
}

/** True when the user has at least one change switched on. */
export function hasFixes(f: Fixes): boolean {
  return Object.keys(f.taskMinutes).length > 0 || f.switchMainRoute;
}

const NO_FIXES: Fixes = { taskMinutes: {}, switchMainRoute: false };

/** The run with fixes applied; null when there are no changes, so every screen agrees. */
function runAfter(s: AppState): DrillRun | null {
  if (!s.prepared || !s.before || !hasFixes(s.fixes)) return null;
  const prepared = s.fixes.switchMainRoute ? { ...s.prepared, waysOut: swappedWaysOut(s.prepared.waysOut) } : s.prepared;
  return runDrill(prepared, fixedTasks(s.household.tasks, s.fixes), s.before.setup);
}

function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'load/start':
      return { ...initialState(), household: s.household, entry: s.entry, load: { status: 'loading', steps: a.steps.map((label, i) => ({ label, state: i === 0 ? 'working' : 'waiting' })) } };
    case 'load/step':
      return { ...s, load: { ...s.load, steps: s.load.steps.map((st, i) => ({ ...st, state: i < a.index ? 'done' : i === a.index ? 'working' : 'waiting' })) } };
    case 'load/error':
      return { ...s, load: { ...s.load, status: 'error', error: { code: a.code, message: a.message } } };
    case 'load/done': {
      const prepared = prepareArea(a.area);
      const wind = a.isDemo ? DEMO_WIND : a.area.wind ?? s.setup.wind;
      const suggestions = suggest(prepared, wind);
      return {
        ...s,
        area: a.area,
        prepared,
        isDemo: a.isDemo,
        load: { status: 'ready', steps: s.load.steps.map((st) => ({ ...st, state: 'done' })) },
        setup: { ...s.setup, wind, ignition: suggestions[0]?.xy ?? null },
        suggestions,
      };
    }
    case 'household/set':
      // Fixes belong to the drill they were tried on; a new household starts with none.
      return { ...s, household: a.household, before: null, after: null, fixes: NO_FIXES, plan: { status: 'idle', data: null } };
    case 'setup/set': {
      const setup = { ...s.setup, ...a.patch };
      const windChanged = a.patch.wind !== undefined;
      const suggestions = windChanged && s.prepared ? suggest(s.prepared, setup.wind) : s.suggestions;
      return { ...s, setup, suggestions };
    }
    case 'drill/run': {
      if (!s.prepared || !s.setup.ignition) return s;
      const setup: DrillSetup = { ignition: s.setup.ignition, wind: s.setup.wind, start: s.setup.start, seed: s.setup.seed };
      const before = runDrill(s.prepared, s.household.tasks, setup);
      const next = { ...s, before, after: null, fixes: NO_FIXES, plan: { status: 'idle' as const, data: null } };
      return next;
    }
    case 'fixes/set': {
      const next = { ...s, fixes: a.fixes };
      return { ...next, after: runAfter(next), plan: { status: 'idle', data: null } };
    }
    case 'plan/loading':
      return { ...s, plan: { status: 'loading', data: s.plan.data } };
    case 'plan/done':
      return {
        ...s,
        plan: { status: 'ready', data: a.data },
        meeting: { ...s.meeting, primary: s.meeting.primary || a.data.meetingSpot.primary, ifClosed: s.meeting.ifClosed || a.data.meetingSpot.ifClosed },
      };
    case 'meeting/set':
      return { ...s, meeting: { ...s.meeting, ...a.patch } };
    case 'entry/set':
      return { ...s, entry: { ...s.entry, ...a.patch } };
    case 'reset':
      // A fresh drill, but the typed address stays so the user can come back to it.
      return { ...initialState(), entry: s.entry };
  }
}

const Ctx = createContext<{ state: AppState; dispatch: Dispatch<Action> } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
