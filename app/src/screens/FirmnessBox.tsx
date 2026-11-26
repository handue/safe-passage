// "How sure is this?": one drill result next to the same fire run again, the same plan with
// evacuation traffic, and how many task minutes were really timed. All calculated (engine/spread.ts).
import { useId, useMemo } from 'react';
import { swappedWaysOut, useApp } from '../app/state';
import type { DrillRun, PreparedForDrill } from '../engine/drill';
import type { Task } from '../engine/types';
import { EVAC_TRAFFIC_MAX, EVAC_TRAFFIC_MIN, firmness, rangeText, type Firmness, type MarginRange } from '../engine/spread';
import { Tag } from '../ui/Tag';
import { NavLink } from './ResultsScreen';
import { NumInput } from './SituationsSection';

/**
 * Firmness of one run, recalculated only when the run, the task minutes or the traffic value change
 * (tasks are compared by content, so a freshly built list does not rerun 15 fires). `swap` runs it
 * with the main and backup routes swapped, as the Fix screen's "after" run does.
 */
export function useFirmness(prepared: PreparedForDrill | null, run: DrillRun | null, tasks: Task[], scale: number, swap = false): Firmness | null {
  const tasksKey = tasks.map((t) => `${t.id}:${t.minutes}:${t.source}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tasks is keyed by tasksKey
  return useMemo(() => {
    if (!prepared || !run || !run.main) return null;
    const p = swap ? { ...prepared, waysOut: swappedWaysOut(prepared.waysOut) } : prepared;
    return firmness(p, run, tasks, scale);
  }, [prepared, run, tasksKey, scale, swap]);
}

/** "Short in 2 of 15 runs." / "Not short in any of 15 runs." plus runs the fire never closed the road. */
function countText(r: MarginRange): string {
  const parts = [r.short > 0 ? `Short in ${r.short} of ${r.total} runs.` : `Not short in any of ${r.total} runs.`];
  if (r.open > 0) parts.push(`In ${r.open} the fire never closed the road.`);
  return parts.join(' ');
}

/** Range sentence, or the no-closure sentence when no run closed the main route. */
function rangeSentence(r: MarginRange): string {
  const t = rangeText(r);
  return t ? `${t}.` : `the fire never closed your main route in any run.`;
}

/** "this plan is from 1 min short to 5 min to spare." or the no-closure sentence. */
function planSentence(r: MarginRange): string {
  const t = rangeText(r);
  return t ? `this plan is ${t}.` : 'the fire never closed your main route in any run.';
}

export function tasksLine(f: Pick<Firmness, 'timedTasks' | 'estimatedTasks'>): string {
  const n = f.timedTasks + f.estimatedTasks;
  if (n === 0) return 'No tasks yet.';
  if (f.timedTasks === 0) return `All ${n} task times are estimates.`;
  if (f.estimatedTasks === 0) return `All ${n} task times were timed with the stopwatch.`;
  return `${f.timedTasks} of ${n} task times were timed with the stopwatch; ${f.estimatedTasks} are still estimates.`;
}

export function FirmnessBox({ prepared, run, tasks }: { prepared: PreparedForDrill; run: DrillRun; tasks: Task[] }) {
  const { state, dispatch } = useApp();
  const id = useId();
  const f = useFirmness(prepared, run, tasks, state.trafficScale);
  if (!f) return null;
  return (
    <section className="box firm" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>How sure is this?</h2>
      <ul className="firm-list">
        <li>
          <b>Same fire, {f.runs} runs.</b> The model spreads fire with random draws, so the same start and wind can close a road
          sooner or later. Across {f.runs} runs, {planSentence(f.fire)} {countText(f.fire)} <Tag kind="calc" />
        </li>
        <li>
          <b>With evacuation traffic.</b> If everyone leaves at once and every road takes{' '}
          <NumInput
            value={f.trafficScale}
            min={EVAC_TRAFFIC_MIN}
            max={EVAC_TRAFFIC_MAX}
            decimal
            label="Evacuation traffic: times longer to drive"
            onValue={(scale) => dispatch({ type: 'traffic/set', scale })}
          />{' '}
          times longer to drive <Tag kind="est" />, {planSentence(f.traffic)} {countText(f.traffic)} <Tag kind="calc" />
        </li>
        <li>
          <b>Your task minutes.</b> {tasksLine(f)}{' '}
          {f.estimatedTasks > 0 && (
            <>
              Time them once at home to replace guesses with real minutes. <NavLink to="household">Time it for real</NavLink>
            </>
          )}
        </li>
      </ul>
      <p className="small muted">Run 1 is the run shown above. The model has no queues or crashes; the traffic value is your guess.</p>
    </section>
  );
}

/** One line for compact places (the Fix screen's After card): fire runs and traffic, calculated. */
export function FirmnessLine({ label, prepared, run, tasks, swap = false }: { label: string; prepared: PreparedForDrill; run: DrillRun; tasks: Task[]; swap?: boolean }) {
  const { state } = useApp();
  const f = useFirmness(prepared, run, tasks, state.trafficScale, swap);
  if (!f) return null;
  return (
    <p className="small firm-line">
      <b>{label}:</b> across {f.runs} runs of this fire, {rangeSentence(f.fire)} With evacuation traffic (×{f.trafficScale} <Tag kind="est" />): {rangeSentence(f.traffic)} <Tag kind="calc" />
    </p>
  );
}
