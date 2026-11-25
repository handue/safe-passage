// Screen 7: fix the plan. Same fire, new plan: the user picks changes (their own minute
// estimates, or switching to the backup route) and the same fire runs again via fixes/set.
import { useState } from 'react';
import { useApp, type Fixes } from '../app/state';
import { compareRuns, displayDiffMin, type DrillRun } from '../engine/drill';
import type { RouteRun, Task } from '../engine/types';
import { Icon } from '../ui/Icon';
import { Tag, fmtMin, fmtT } from '../ui/Tag';
import { MapView, type MapViewProps } from '../ui/MapView';
import { TimeBars, type TimeBar } from '../ui/TimeBars';
import type { PreparedArea } from '../engine/area';
import { aDrive, capitalize, minShort, unitsFor } from '../ui/units';
import { DemoChip, DrillProblem, ModelNotes, NavLink, barFor, destLabel, destinationFireText, endMin, fireCaptionFor, verdictOf, wayOutName, windText } from './ResultsScreen';
import '../styles/results.css';
import '../styles/fix.css';

/** What the household can change for each task, in plain words. */
const CHANGE_TEXT: Record<string, string> = {
  pets: 'Keep pet carriers by the front door',
  meds: 'Put medications in the go-bag',
  docs: 'Keep documents and chargers in the go-bag',
  gather: 'Agree on one meeting point inside the house',
  help: 'Plan who helps whom ahead of time',
  load: 'Pack the car the night before a red flag day',
  ride: 'Arrange a ride with a neighbor ahead of time',
};

/** The change for a task, or null when there is none to offer. Tasks the user added get a generic row. */
function changeText(t: Task): string | null {
  return CHANGE_TEXT[t.id] ?? (t.id.startsWith('custom-') ? `Shorten: ${t.label}` : null);
}

const defaultTarget = (t: Task) => Math.max(1, Math.round(t.minutes / 3));
const clampTarget = (n: number, t: Task) => Math.min(Math.max(1, Math.round(n)), Math.max(1, t.minutes));

/** Three changes up front (the slowest task, then pets and medications, then by minutes); the rest
 * stay one click away so the screen fits without scrolling. The order is stable, so rows never jump. */
function splitChanges(tasks: Task[]): [Task[], Task[]] {
  const slowest = [...tasks].sort((a, b) => b.minutes - a.minutes);
  const ids = [...new Set([slowest[0]?.id, 'pets', 'meds', ...slowest.map((t) => t.id)])];
  const first = ids.flatMap((id) => tasks.filter((t) => t.id === id)).slice(0, 3);
  return [first, tasks.filter((t) => !first.includes(t))];
}

/** What a card's minutes measure: getting past the closing road, or reaching the destination. */
function measureText(run: RouteRun, prepared: PreparedArea): string {
  return run.binding ? `to get past ${run.binding.name}` : `to reach ${destLabel(prepared, run.route.destinationId)}`;
}

function Card({ title, run, prepared }: { title: string; run: RouteRun; prepared: PreparedArea }) {
  const v = verdictOf(run);
  // Color follows the verdict (coral short, green spare), never alone: icon and words carry it too.
  const tone = v.kind === 'short' ? 'before' : v.kind === 'spare' ? 'after' : 'neutral';
  return (
    <div className={tone}>
      <h2>{title}</h2>
      <div className="hero">
        {fmtMin(endMin(run))}
        <small>min</small>
      </div>
      <p className="small fix-measure">{measureText(run, prepared)}</p>
      <p className="verdict">
        <Icon name={v.kind === 'short' ? 'closed' : 'check'} />
        {v.shortText}
      </p>
    </div>
  );
}

function ignitionName(run: DrillRun, suggestions: { xy: { x: number; y: number } }[]): string {
  const i = suggestions.findIndex((s) => s.xy.x === run.setup.ignition.x && s.xy.y === run.setup.ignition.y);
  return i >= 0 ? `ignition ${i + 1}` : 'your ignition point';
}

export function FixScreen() {
  const { state, dispatch } = useApp();
  const { prepared, area, before, after, fixes, household, isDemo } = state;

  // Target minutes the user typed, kept even while a change is unchecked.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(household.tasks.map((t) => [t.id, String(fixes.taskMinutes[t.id] ?? defaultTarget(t))])),
  );
  const [moreOpen, setMoreOpen] = useState(() =>
    splitChanges(household.tasks.filter((t) => changeText(t) !== null))[1].some((t) => fixes.taskMinutes[t.id] !== undefined),
  );

  if (!prepared || !area) return null;
  const problem = DrillProblem({ run: before, prepared, isDemo });
  if (problem || !before || !before.main) return problem;

  const tasks = household.tasks.filter((t) => changeText(t) !== null);
  const [firstTasks, moreTasks] = splitChanges(tasks);
  const targetOf = (t: Task) => {
    const n = Number.parseInt(drafts[t.id] ?? '', 10);
    return Number.isFinite(n) ? clampTarget(n, t) : defaultTarget(t);
  };
  const set = (next: Fixes) => dispatch({ type: 'fixes/set', fixes: next });
  const toggleTask = (t: Task, on: boolean) => {
    const taskMinutes = { ...fixes.taskMinutes };
    if (on) taskMinutes[t.id] = targetOf(t);
    else delete taskMinutes[t.id];
    set({ ...fixes, taskMinutes });
  };
  const editTarget = (t: Task, raw: string) => {
    setDrafts((d) => ({ ...d, [t.id]: raw }));
    const n = Number.parseInt(raw, 10);
    if (fixes.taskMinutes[t.id] !== undefined && Number.isFinite(n)) {
      set({ ...fixes, taskMinutes: { ...fixes.taskMinutes, [t.id]: clampTarget(n, t) } });
    }
  };
  const normalize = (t: Task) => setDrafts((d) => ({ ...d, [t.id]: String(targetOf(t)) }));

  const taskRow = (t: Task) => {
              const on = fixes.taskMinutes[t.id] !== undefined;
              const target = on ? fixes.taskMinutes[t.id] : targetOf(t);
              const id = `fix-${t.id}`;
              return (
                <li key={t.id}>
                  <input type="checkbox" id={id} checked={on} onChange={(e) => toggleTask(t, e.target.checked)} />
                  <div className="grow">
                    <label htmlFor={id}>{changeText(t)}</label>
                    <div className="est-row">
                      <span>{fmtMin(t.minutes)} →</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={Math.max(1, t.minutes)}
                        step={1}
                        value={drafts[t.id] ?? ''}
                        onChange={(e) => editTarget(t, e.target.value)}
                        onBlur={() => normalize(t)}
                        aria-label={`Minutes for "${t.label}" after this change`}
                      />
                      <span>min</span>
                      <Tag kind="est" />
                    </div>
                  </div>
                  <div className="val">
                    {on ? `−${fmtMin(t.minutes - target)} min` : ''}
                  </div>
                </li>
              );
  };

  const anyOn = Object.keys(fixes.taskMinutes).length > 0 || fixes.switchMainRoute;
  const shown = anyOn && after && after.main ? after : null;
  const cmp = shown ? compareRuns(before, shown) : null;

  const w = prepared.waysOut;
  const mainRoute = w.main!;
  const backupRoute = w.backup;
  const units = unitsFor(area.country);
  const backupName = backupRoute ? wayOutName(w, backupRoute) : null;
  // Each drive is rounded before subtracting, so the difference matches the minutes in the sentence.
  const driveDiff = backupRoute ? displayDiffMin(backupRoute.driveMin, mainRoute.driveMin) : 0;

  // Bars: before with the household's tasks, after with the changed tasks outlined.
  const fixedIds = Object.keys(fixes.taskMinutes);
  const afterTasks = household.tasks.map((t) => (fixes.taskMinutes[t.id] !== undefined ? { ...t, minutes: fixes.taskMinutes[t.id] } : t));
  const bars: TimeBar[] = [barFor(before, household.tasks, 'Before')!];
  if (shown) bars.push(barFor(shown, afterTasks, 'After', fixedIds)!);

  // Map: the after route solid, the other route dim; fire and closure from the run shown.
  const focus = shown ?? before;
  const focusMain = focus.main!;
  const fb = focusMain.binding;
  const switched = shown !== null && fixes.switchMainRoute;
  const routes: MapViewProps['routes'] = [
    { which: 'main', style: switched ? 'unused' : focusMain.outcome === 'short' ? 'closed' : 'main', label: switched ? 'Way out A (old main)' : 'Way out A' },
  ];
  if (backupRoute) routes.push({ which: 'backup', style: switched ? (focusMain.outcome === 'short' ? 'closed' : 'main') : 'unused', label: switched ? 'Way out B (new main)' : 'Way out B' });
  const fireMin = endMin(focusMain);
  const fireCaption = fireCaptionFor(focusMain);
  const destFire = destinationFireText(focusMain, destLabel(prepared, focusMain.route.destinationId));

  // Closure point labels, as in the approved design: when each plan reaches it, and whether that is before it closed.
  const bb = before.main.binding;
  const reachText = (label: string, pass: number, close: number) => `${label}: ${fmtT(pass)}, ${pass > close ? 'after' : 'before'} it closed`;
  const mapNotes: NonNullable<MapViewProps['notes']> = [];
  if (bb && !switched) {
    mapNotes.push({ xy: bb.xy, text: reachText('Before', bb.passMin, bb.closeMin), tone: before.main.outcome === 'short' ? 'short' : 'plain' });
    const ab = shown?.main?.binding;
    if (ab && ab.edgeId === bb.edgeId) mapNotes.push({ xy: ab.xy, text: reachText('After', ab.passMin, ab.closeMin), tone: shown!.main!.outcome === 'short' ? 'short' : 'route' });
  }

  const runsChip = `${cmp?.sameFire === false ? 'Different fires' : shown ? 'Both runs' : 'This fire'}: ${ignitionName(before, state.suggestions)} · ${windText(before.setup.wind, false, units)} · ${before.setup.start} · same random seed`;

  return (
    <main className="stage fix-stage">
      <div className="row between fix-head">
        <h1>
          Same fire, new plan <DemoChip show={isDemo} />
        </h1>
        <span className="chip">{runsChip}</span>
      </div>
      {cmp && !cmp.sameFire && (
        <ul className="notes"><li><Icon name="warn" /><span>These runs used different fires, so they cannot be compared. Run the drill again.</span></li></ul>
      )}

      <div className="compare" aria-live="polite">
        <Card title="Before" run={before.main} prepared={prepared} />
        {shown ? (
          <Card title="After" run={shown.main!} prepared={prepared} />
        ) : (
          <div className="after-empty">
            <h2>After</h2>
            <p>Choose one or more changes below. The same fire runs again with your new plan.</p>
          </div>
        )}
      </div>

      <div className="stack-s">
        <TimeBars
          bars={bars}
          note={
            <>
              Minutes to get past the closure point <Tag kind="calc" /> Task minutes <Tag kind="est" />
            </>
          }
        />
        <ModelNotes run={focus} area={area} prepared={prepared} which="both" />
        {destFire && (
          <p className="res-dest-fire" role="status">
            <Icon name="warn" />
            <span><b>Fire at the destination.</b> {destFire} <Tag kind="calc" /></span>
          </p>
        )}
      </div>

      <div className="cols2 fix-cols">
        <div className="stack-s">
          <h2>Changes</h2>
          <ul className="list fix-list">
            {firstTasks.map(taskRow)}
            {backupRoute && backupName && (
              <li>
                <input
                  type="checkbox"
                  id="fix-route"
                  checked={fixes.switchMainRoute}
                  onChange={(e) => set({ ...fixes, switchMainRoute: e.target.checked })}
                />
                <div className="grow">
                  <label htmlFor="fix-route">Switch the main route to {backupName.replace(/^Way out/, 'way out')}</label>
                  <div className="muted small">
                    {before.backup?.binding
                      ? `In this fire ${before.backup.binding.name} closes at ${fmtT(before.backup.binding.closeMin)}. `
                      : 'This fire did not close it. '}
                    {capitalize(aDrive(backupRoute.driveMin))} instead of {minShort(mainRoute.driveMin)}. The other route stays as your backup. <Tag kind="calc" />
                  </div>
                </div>
                <div className="val">
                  {driveDiff === 0 ? 'Same drive' : `${driveDiff > 0 ? '+' : '−'}${Math.abs(driveDiff)} min drive`}
                </div>
              </li>
            )}
          </ul>
          {moreTasks.length > 0 && (
            <details className="more-fixes" open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)}>
              <summary>More changes ({moreTasks.length})</summary>
              <ul className="list fix-list">{moreTasks.map(taskRow)}</ul>
            </details>
          )}
          {tasks.length === 0 && !backupRoute && <p className="muted">No changes to try for this household.</p>}
        </div>
        <div className="stack-s">
          <MapView
            prepared={prepared}
            routes={routes}
            fire={{ run: focus, minute: fireMin }}
            closure={fb ? { xy: fb.xy, label: `${fb.name} closes ${fmtT(fb.closeMin)}` } : null}
            wind={focus.setup.wind}
            notes={mapNotes}
            size="short"
            units={units}
            fireCaption={fireCaption}
            ariaLabel={`Map of the ${shown ? 'new' : 'current'} route, ${wayOutName(w, focusMain.route)}. ${fireCaption}.${fb ? ` ${fb.name} closes at ${fmtT(fb.closeMin)}.` : ' It did not close the route.'}`}
          />
          <div className="row fix-actions">
            <NavLink to="plan" primary>Make my plan</NavLink>
            <NavLink to="results">Back to results</NavLink>
            <p className="small muted">Minutes you change are your own estimates. Practice once to check them.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
