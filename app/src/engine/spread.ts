// How sure is one drill result? The same fire run again with other random draws, and the same
// plan with evacuation traffic. Every number here is calculated from the drill engine.
import type { RouteRun, Task } from './types';
import { displayMin, runDrill, type DrillRun, type PreparedForDrill } from './drill';
import { SITUATIONS, runWithDriveScale } from './situations';

/** How many runs of the same fire (same start, wind and day/night; other random draws). */
export const FIRE_RUNS = 15;

/** Starting guess for evacuation traffic: every road takes this many times longer to drive. */
export const EVAC_TRAFFIC_SCALE = SITUATIONS.slow_traffic.defaultParam;
export const EVAC_TRAFFIC_MIN = SITUATIONS.slow_traffic.minParam;
export const EVAC_TRAFFIC_MAX = SITUATIONS.slow_traffic.maxParam;

/** One run's main-route outcome. `signed` is displayMin(close) - displayMin(pass): >0 spare, <0 short. */
export interface RunMargin {
  outcome: RouteRun['outcome'];
  /** null when the fire never closed the route in this run. */
  signed: number | null;
  /** Unrounded close - pass, for ordering. Infinity when never closed. */
  raw: number;
}

export interface MarginRange {
  total: number;
  /** Runs where you would be short. */
  short: number;
  /** Runs where the fire never closed the main route. */
  open: number;
  /** Closed runs with the smallest and largest margin; null when no run closed the route. */
  worst: RunMargin | null;
  best: RunMargin | null;
}

export interface Firmness {
  runs: number;
  seeds: number[];
  /** The plan as entered, across the fire runs. */
  fire: MarginRange;
  /** The plan with every road taking trafficScale times longer, across the same fire runs. */
  traffic: MarginRange;
  trafficScale: number;
  timedTasks: number;
  estimatedTasks: number;
}

export function marginOfRun(run: RouteRun | null): RunMargin | null {
  if (!run) return null;
  const b = run.binding;
  if (!b) return { outcome: run.outcome, signed: null, raw: Infinity };
  return { outcome: run.outcome, signed: displayMin(b.closeMin) - displayMin(b.passMin), raw: b.closeMin - b.passMin };
}

export function rangeOf(margins: (RunMargin | null)[]): MarginRange {
  const list = margins.filter((m): m is RunMargin => m !== null);
  // Ordered by the value shown (rounded), so the words always agree with each run's own verdict;
  // the unrounded margin breaks ties (a rounded 0 that is short comes before one that is spare).
  const closed = list.filter((m) => m.signed !== null).sort((a, b) => (a.signed as number) - (b.signed as number) || a.raw - b.raw);
  return {
    total: list.length,
    short: list.filter((m) => m.outcome === 'short').length,
    open: list.length - closed.length,
    worst: closed[0] ?? null,
    best: closed[closed.length - 1] ?? null,
  };
}

/** Seeds for the fire runs: the drill's own seed first, so run 1 is the run on screen. */
export function fireSeeds(seed: number, runs = FIRE_RUNS): number[] {
  return Array.from({ length: runs }, (_, i) => seed + i);
}

/**
 * The same fire run `runs` times (the drill's own run plus runs-1 more seeds), with the plan as it is
 * and with evacuation traffic. `base` is the drill on screen; its run is reused, not re-simulated.
 */
export function firmness(
  prepared: PreparedForDrill,
  base: DrillRun,
  tasks: Task[],
  trafficScale: number = EVAC_TRAFFIC_SCALE,
  runs: number = FIRE_RUNS,
): Firmness {
  const seeds = fireSeeds(base.setup.seed, runs);
  const fire: (RunMargin | null)[] = [];
  const traffic: (RunMargin | null)[] = [];
  for (const seed of seeds) {
    const run = seed === base.setup.seed ? base : runDrill(prepared, tasks, { ...base.setup, seed });
    fire.push(marginOfRun(run.main));
    traffic.push(marginOfRun(runWithDriveScale(prepared, run, tasks, trafficScale)));
  }
  const timedTasks = tasks.filter((t) => t.source === 'timed').length;
  return {
    runs: seeds.length,
    seeds,
    fire: rangeOf(fire),
    traffic: rangeOf(traffic),
    trafficScale,
    timedTasks,
    estimatedTasks: tasks.length - timedTasks,
  };
}

/** "3 min to spare", "2 min short", "under 1 min short"; null signed reads "not closed". */
export function marginText(m: RunMargin): string {
  if (m.signed === null) return 'not closed by the fire';
  const n = Math.abs(m.signed);
  const what = m.outcome === 'short' ? 'short' : 'to spare';
  return n === 0 ? `under 1 min ${what}` : `${n} min ${what}`;
}

/** "from 1 min short to 5 min to spare", "4 min to spare in every run", or null if no run closed the road. */
export function rangeText(r: MarginRange): string | null {
  if (!r.worst || !r.best) return null;
  const a = marginText(r.worst);
  const b = marginText(r.best);
  const everyClosed = r.open === 0;
  if (a === b) return everyClosed ? `${a} in every run` : `${a} in every run that closed the road`;
  // Same side and both at least 1 minute: "8 to 16 min to spare", "1 to 3 min short".
  const w = r.worst.signed ?? 0;
  const bs = r.best.signed ?? 0;
  if (r.worst.outcome !== 'short' && w > 0) return `${w} to ${bs} min to spare`;
  if (r.best.outcome === 'short' && bs < 0) return `${-bs} to ${-w} min short`;
  return `from ${a} to ${b}`;
}
