// Screen 8: the household's personal leaving plan, ready to print or save as PDF.
// Calculated parts (routes, drill results) come from the store; the wording comes from the plan writer.
import { useEffect, useRef, useState } from 'react';
import { useApp, fixedTasks, hasFixes, windSourceWord, type AppState, type Fixes } from '../app/state';
import { requestPlan, type PlanRequest, type PlanResponse } from '../app/api';
import type { DrillRun } from '../engine/drill';
import type { Destination, Route, RouteRun, Task } from '../engine/types';
import { Icon } from '../ui/Icon';
import { Tag, fmtMin, fmtT } from '../ui/Tag';
import '../styles/plan.css';

const METERS_PER_MILE = 1609.344;
const ONE_WAY_OUT_MIN_M = 200; // same threshold the drill uses for the "one way out" bottleneck

const KIND_WORD: Record<Destination['kind'], string> = {
  school: 'School',
  library: 'Library',
  townhall: 'Hall',
  community_centre: 'Centre',
  assembly_point: 'Assembly point',
  other: 'Place',
  exit_point: 'Exit point',
};

// Request bookkeeping kept outside React so StrictMode remounts and screen changes
// neither send a second request nor keep a plan written for older inputs.
let inflightKey: string | null = null;
let doneKey: string | null = null;
/** Last meeting suggestion shown, so a spot the user never edited can follow a new plan. */
let lastMeet: { primary: string; ifClosed: string } | null = null;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function householdLine(h: AppState['household']): string {
  const parts = [plural(h.adults, 'adult', 'adults')];
  if (h.children > 0) parts.push(plural(h.children, 'child', 'children'));
  if (h.needHelpMoving > 0) parts.push(`${h.needHelpMoving} ${h.needHelpMoving === 1 ? 'needs' : 'need'} help moving`);
  if (h.dogs > 0) parts.push(plural(h.dogs, 'dog', 'dogs'));
  if (h.catsAndSmallPets > 0) parts.push(plural(h.catsAndSmallPets, 'cat or small pet', 'cats or small pets'));
  parts.push(h.cars === 0 ? 'no car' : plural(h.cars, 'car', 'cars'));
  return parts.join(', ');
}

/** The run after changes, only while at least one change is on. */
function afterRun(s: AppState): DrillRun | null {
  return s.after && hasFixes(s.fixes) ? s.after : null;
}

/** Latest drill: the run after changes if there is one, else today's run. */
function latestRun(s: AppState): DrillRun | null {
  return afterRun(s) ?? s.before;
}

/** Fixes that belong to the drill shown; none when there is no after-run. */
function activeFixes(s: AppState): Fixes {
  return afterRun(s) ? s.fixes : { taskMinutes: {}, switchMainRoute: false };
}

/** Task name as the writer gets it: built-in names as they are; tasks the user typed become "Another task". */
const writerLabel = (t: Task) => (t.id.startsWith('custom-') ? 'Another task' : t.label);

/** Main and backup routes as the latest run used them (switched if the user chose that). */
function currentRoutes(s: AppState): { main: Route | null; backup: Route | null } {
  const run = latestRun(s);
  if (run) return { main: run.main?.route ?? null, backup: run.backup?.route ?? null };
  const w = s.prepared?.waysOut;
  return { main: w?.main ?? null, backup: w?.backup ?? null };
}

function destOf(s: AppState, r: Route | null): Destination | null {
  if (!r || !s.prepared) return null;
  return s.prepared.waysOut.destinations.find((d) => d.id === r.destinationId) ?? null;
}

/** Short label sent to the writer: "D1 School". Never the place's own name. */
function shortDest(d: Destination | null): string {
  if (!d) return '';
  return `${d.label.split(' ')[0]} ${KIND_WORD[d.kind]}`;
}

/** Label printed on the plan: "D1 School (Blake Hammond Manor School)", so the household knows where to go. */
function fullDest(d: Destination): string {
  const short = shortDest(d);
  return d.name && !short.endsWith(d.name) ? `${short} (${d.name})` : short;
}

/** Puts the real place names back into the writer's wording (the writer only saw the short labels). */
function withPlaceNames(data: PlanResponse, dests: Destination[]): PlanResponse {
  const fix = (text: string) => dests.reduce((t, d) => (shortDest(d) ? t.split(shortDest(d)).join(fullDest(d)) : t), text);
  return {
    ...data,
    whenToLeave: fix(data.whenToLeave),
    meetingSpot: { primary: fix(data.meetingSpot.primary), ifClosed: fix(data.meetingSpot.ifClosed), reason: fix(data.meetingSpot.reason) },
  };
}

/** True when the binding road edge lies on the stretch both routes share from the door. */
function bindingOnSharedStretch(run: DrillRun | null): boolean {
  const b = run?.main?.binding;
  const backup = run?.backup?.route;
  if (!b || !backup || !run?.main) return false;
  const main = run.main.route.edgeIds;
  for (let i = 0; i < Math.min(main.length, backup.edgeIds.length) && main[i] === backup.edgeIds[i]; i++) {
    if (main[i] === b.edgeId) return true;
  }
  return false;
}

/** Changes the user chose on the compare screen, worded as actions. */
function changeLabels(s: AppState): string[] {
  const out: string[] = [];
  const fixes = activeFixes(s);
  for (const t of s.household.tasks) {
    const m = fixes.taskMinutes[t.id];
    if (m !== undefined && m !== t.minutes) out.push(`${writerLabel(t)}: ${fmtMin(t.minutes)} min down to ${fmtMin(m)} min`);
  }
  if (fixes.switchMainRoute && s.prepared?.waysOut.backup) {
    out.push(`Use the route to ${shortDest(destOf(s, s.prepared.waysOut.backup))} as the main way out`);
  }
  return out;
}

function buildRequest(s: AppState): PlanRequest {
  const h = s.household;
  const { main, backup } = currentRoutes(s);
  const route = (r: Route | null) => (r ? { roadNames: r.roadNames, driveMin: Math.round(r.driveMin), destination: shortDest(destOf(s, r)) } : null);
  const latest = latestRun(s);
  const binding = latest?.main?.binding ?? null;
  return {
    household: { adults: h.adults, children: h.children, needHelpMoving: h.needHelpMoving, dogs: h.dogs, catsAndSmallPets: h.catsAndSmallPets, cars: h.cars },
    tasks: fixedTasks(h.tasks, activeFixes(s)).map((t) => ({ label: writerLabel(t), minutes: t.minutes })),
    main: route(main),
    backup: route(backup),
    drill: binding
      ? { neededMin: Math.round(binding.passMin), closeMin: Math.round(binding.closeMin), roadName: binding.name, onSharedStretch: bindingOnSharedStretch(latest) }
      : null,
    changes: changeLabels(s),
  };
}

/** One sentence for a drill run, with an icon and words (never color alone). */
function RunResult({ label, run }: { label: string; run: DrillRun }) {
  if (!run.coverage.ignitionInGrid) {
    return <p className="plan-result"><Icon name="pending" /><span><b>{label}:</b> the fire started outside the modeled area, so no fire was simulated.</span></p>;
  }
  const m: RouteRun | null = run.main;
  if (!m) return <p className="plan-result"><Icon name="closed" /><span><b>{label}:</b> no way out found on mapped roads.</span></p>;
  if (m.outcome === 'never_closed' || !m.binding) {
    return <p className="plan-result"><Icon name="check" /><span><b>{label}:</b> this fire did not close your way out. You leave home at {fmtT(run.tasksMin)}.</span></p>;
  }
  const b = m.binding;
  const gap = Math.abs(Math.round(b.marginMin));
  const short = m.outcome === 'short';
  return (
    <p className={`plan-result ${short ? 'is-short' : 'is-spare'}`}>
      <Icon name={short ? 'closed' : 'check'} />
      <span>
        <b>{label}:</b> {fmtMin(b.passMin)} min to pass {b.name}, which closes at {fmtT(b.closeMin)}.{' '}
        <b>{short ? `${gap} min short` : `${gap} min to spare`}.</b>
      </span>
    </p>
  );
}

function unmodeledRoads(s: AppState, ids: number[]): string[] {
  if (!s.prepared) return [];
  return [...new Set(ids.map((id) => s.prepared!.graph.edges[id].name))];
}

function RouteLine({ name, route, dest, unmodeled }: { name: string; route: Route | null; dest: Destination | null; unmodeled: string[] }) {
  if (!route) return <p><b>{name}:</b> {name === 'Main' ? 'no way out found on mapped roads.' : 'no second way out found on mapped roads.'}</p>;
  return (
    <div className="stack-s">
      <p>
        <b>{name}:</b> {route.roadNames.join(' → ')}. {fmtMin(route.driveMin)} min to {dest ? fullDest(dest) : 'the destination'}.
      </p>
      {unmodeled.length > 0 && (
        <p className="small muted">Part of this route leaves the fire model: {unmodeled.join(', ')} not modeled there.</p>
      )}
    </div>
  );
}

function Checklist({ id, items }: { id: string; items: string[] }) {
  const [checked, setChecked] = useState<boolean[]>([]);
  return (
    <ul className="plan-list" role="list">
      {items.map((item, i) => (
        <li key={`${id}-${i}`}>
          <label className="row">
            <input type="checkbox" checked={!!checked[i]} onChange={(e) => setChecked((c) => { const n = [...c]; n[i] = e.target.checked; return n; })} />
            {item}
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Text input that prints as plain text. */
function Field({ id, label, value, placeholder, onChange }: { id: string; label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="plan-field stack-s">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={2} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <span className="printval" aria-hidden="true">{value || ' '}</span>
    </div>
  );
}

export function PlanScreen() {
  const { state, dispatch } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const req = buildRequest(state);
  const key = JSON.stringify(req);
  const status = state.plan.status;
  const meetingRef = useRef(state.meeting);
  const destsRef = useRef<Destination[]>([]);
  useEffect(() => { meetingRef.current = state.meeting; destsRef.current = state.prepared?.waysOut.destinations ?? []; });

  // Print styles in theme.css key off body[data-step="plan"].
  useEffect(() => {
    document.body.dataset.step = 'plan';
    return () => { delete document.body.dataset.step; };
  }, []);

  useEffect(() => {
    const fresh = status === 'ready' && doneKey === key;
    if (fresh || inflightKey === key) return;
    inflightKey = key;
    setError(null);
    dispatch({ type: 'plan/loading' });
    requestPlan(JSON.parse(key) as PlanRequest)
      .then((data) => {
        if (inflightKey !== key) return; // inputs changed while waiting
        doneKey = key;
        // A meeting spot the user never edited follows the new suggestion.
        const m = meetingRef.current;
        if (lastMeet && m.primary === lastMeet.primary) dispatch({ type: 'meeting/set', patch: { primary: '' } });
        if (lastMeet && m.ifClosed === lastMeet.ifClosed) dispatch({ type: 'meeting/set', patch: { ifClosed: '' } });
        const named = withPlaceNames(data, destsRef.current);
        lastMeet = { primary: named.meetingSpot.primary, ifClosed: named.meetingSpot.ifClosed };
        dispatch({ type: 'plan/done', data: named });
      })
      .catch(() => {
        if (inflightKey === key) setError('Could not reach the plan writer.');
      })
      .finally(() => {
        if (inflightKey === key) inflightKey = null;
      });
    // A change in status alone must not resend, so it is not a dependency.
  }, [key, attempt, dispatch]);

  const area = state.area;
  const { main, backup } = currentRoutes(state);
  const mainDest = destOf(state, main);
  const backupDest = destOf(state, backup);
  const latest = latestRun(state);
  const before = state.before;
  const after = afterRun(state);
  const data = state.plan.data && doneKey === key ? state.plan.data : null;
  const ai = data?.source === 'ai';
  const waiting = !data && !error;
  const w = state.prepared?.waysOut;
  const shared = w && w.sharedFromDoorM >= ONE_WAY_OUT_MIN_M && main && backup ? w : null;
  const closedRoad = latest?.main?.binding?.name ?? main?.roadNames[Math.min(1, main.roadNames.length - 1)] ?? 'the main route';
  const closedOnShared = req.drill?.onSharedStretch === true;
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const sources = area ? Object.keys(area.fetchedAt) : [];
  const wind = (latest?.setup.wind ?? state.setup.wind);

  const writtenTag = ai ? <Tag kind="ai" /> : null;
  const pending = (
    <p className="plan-wait" role="status">
      <Icon name="pending" /> Writing this part of the plan. It takes about 10 seconds.
    </p>
  );
  const failed = error && (
    <div className="plan-wait" role="alert">
      <Icon name="warn" /> <span>{error} The routes and drill result above are still correct.</span>
      <button type="button" className="noprint" onClick={() => { inflightKey = null; setAttempt((n) => n + 1); }}>Try again</button>
    </div>
  );

  return (
    <main className="narrow plan">
      <div className="row between">
        <h1>Our leaving plan</h1>
        <button className="primary noprint" type="button" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <p>
        {area?.addressLabel ?? 'Your address'}
        {state.isDemo && <> <span className="chip">Demo address</span></>} · {householdLine(state.household)} · Made {today}
      </p>

      <section className="stack-s box" aria-labelledby="p-leave">
        <h2 id="p-leave">When told to leave {writtenTag}</h2>
        {data ? <p className="plan-lead">{data.whenToLeave}</p> : waiting ? pending : failed}
        {data && !ai && <p className="small muted">Fixed checklist (AI writer unavailable).</p>}
      </section>

      <section className="cols2">
        <div className="stack-s">
          <h2>Routes <Tag kind="calc" /></h2>
          <RouteLine name="Main" route={main} dest={mainDest} unmodeled={latest ? unmodeledRoads(state, latest.coverage.mainUnmodeledEdgeIds) : []} />
          <RouteLine name="Backup" route={backup} dest={backupDest} unmodeled={latest ? unmodeledRoads(state, latest.coverage.backupUnmodeledEdgeIds) : []} />
          {shared && (
            <p className="plan-result"><Icon name="oneway" /><span>One way out: both routes use {shared.sharedRoadNames.join(', ')} for the first {(shared.sharedFromDoorM / METERS_PER_MILE).toFixed(1)} mi.</span></p>
          )}
          <p className="small muted">Destinations are candidate destinations, not confirmed shelters. Follow official directions.</p>
        </div>
        <div className="stack-s">
          <h2>Meet here if separated {writtenTag}</h2>
          {data ? (
            <>
              <Field id="meet" label="Meeting spot (you can change it)" value={state.meeting.primary} onChange={(v) => dispatch({ type: 'meeting/set', patch: { primary: v } })} />
              <Field id="meet2" label={`If ${closedRoad} is closed`} value={state.meeting.ifClosed} onChange={(v) => dispatch({ type: 'meeting/set', patch: { ifClosed: v } })} />
              {closedOnShared && (
                <p className="plan-result"><Icon name="oneway" /><span>Both routes use {closedRoad}, so no backup meeting spot past it can be reached. Agree on one together, and follow official directions.</span></p>
              )}
              {data.meetingSpot.reason && <p className="small muted">{data.meetingSpot.reason}</p>}
            </>
          ) : waiting ? pending : failed}
          <Field id="contact" label="Out-of-area contact" placeholder="Name and phone" value={state.meeting.contact} onChange={(v) => dispatch({ type: 'meeting/set', patch: { contact: v } })} />
          <p className="small muted">Your contact stays in this browser and is not saved. It is not sent to the AI writer.</p>
        </div>
      </section>

      <section className="cols2">
        <div className="stack-s">
          <h2>Go-bag {writtenTag}</h2>
          {data ? <Checklist id="bag" key={`bag-${key}`} items={data.goBag} /> : waiting ? pending : failed}
        </div>
        <div className="stack-s">
          <h2>Do this this week {writtenTag}</h2>
          {data ? (data.thisWeek.length > 0 ? <Checklist id="week" key={`week-${key}`} items={data.thisWeek} /> : <p className="muted">Nothing extra this week.</p>) : waiting ? pending : failed}
        </div>
      </section>

      <section className="stack-s" aria-labelledby="p-result">
        <h2 id="p-result">Drill result <Tag kind="calc" /></h2>
        {before ? (
          <>
            <RunResult label="Today" run={before} />
            {after ? <RunResult label="After your changes" run={after} /> : <p className="small muted">No changes tried yet. <a className="noprint" href="#/fix">Fix the plan</a></p>}
            <p className="small muted">
              {after ? 'Same simulated fire for both' : 'Simulated fire'}: wind from {Math.round(wind.fromDeg)}° at {Math.round(wind.speedMph)} mph ({windSourceWord(wind, state.isDemo)}), {before.setup.start === 'night' ? 'night start' : 'day start'}. Assumes the order to leave comes when the fire starts.
            </p>
          </>
        ) : (
          <p className="muted">No drill run yet. <a className="noprint" href="#/setup">Run a drill</a></p>
        )}
      </section>

      <section className="how" aria-labelledby="how8">
        <div className="row between">
          <h2 id="how8">How this plan was made</h2>
          <a className="noprint" href="#/how">Sources, assumptions and limits</a>
        </div>
        <div className="how-cols">
          <div><Tag kind="calc" /><p>Routes, drive times, and the drill results.</p></div>
          <div><Tag kind="est" /><p>Task minutes, your contact, and the meeting spot if you change it.</p></div>
          <div>
            {ai ? <Tag kind="ai" /> : <b className="small">Fixed checklist</b>}
            <p>
              {ai
                ? `"When told to leave", the meeting spot, the go-bag and this week's list, written by ${data?.model ?? 'the AI writer'}. Wording only: it cannot change times or routes.`
                : '"When told to leave", the meeting spot, the go-bag and this week\'s list come from a fixed checklist filled with your routes, because the AI writer was not used.'}
            </p>
          </div>
        </div>
        <p className="how-data">
          Data: {sources.length > 0 ? sources.join('; ') : 'OpenStreetMap'}. Routing: our own fastest-time search on the OpenStreetMap roads, no traffic.
          {' '}The plan writer got road names, times, task names, destination types (like "D1 School") and household counts only. Tasks you added were sent as "Another task", and place names were added back here.
        </p>
        {area && area.fallbacksUsed.length > 0 && (
          <ul className="how-data plan-fallbacks">
            {area.fallbacksUsed.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        {area && !area.elevation && !area.fallbacksUsed.some((f) => /elevation/i.test(f)) && <p className="how-data">No elevation data: the fire spreads as if the ground were flat.</p>}
        {area && !area.wind && !area.fallbacksUsed.some((f) => /wind/i.test(f)) && <p className="how-data">No wind forecast: the drill uses the wind you set.</p>}
      </section>

      <div className="row noprint">
        <a href="#/fix">Back to compare</a>
        <a href="#/how">How this plan was made</a>
      </div>
    </main>
  );
}
