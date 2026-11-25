// Screen 8: the household's personal leaving plan, ready to print or save as PDF.
// Calculated parts (routes, drill results) come from the store; the wording comes from the plan writer.
import { useEffect, useRef, useState } from 'react';
import { useApp, fixedTasks, hasFixes, windSourceWord, type AppState, type Fixes } from '../app/state';
import { requestPlan, type PlanRequest, type PlanResponse } from '../app/api';
import { useDemoSettling } from '../app/demoHook';
import { backupBlockedByMainClosure, destTitle, type DrillRun } from '../engine/drill';
import { bearingDeg, compassName } from '../engine/geo';
import type { Destination, RoadGraph, Route, RouteRun, Task, WaysOut } from '../engine/types';
import { Icon } from '../ui/Icon';
import { Tag, fmtMin, fmtT } from '../ui/Tag';
import { fmtDist, fmtSpeed, unitsFor } from '../ui/units';
import { DISCLAIMER } from '../ui/Shell';
import { dataSources, wayOutName } from './ResultsScreen';
import '../styles/plan.css';

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
let inflightAbort: AbortController | null = null;
let inflightStartedAt = 0;
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
export function shortDest(d: Destination | null): string {
  if (!d) return '';
  return `${d.label.split(' ')[0]} ${KIND_WORD[d.kind]}`;
}

/**
 * Label printed on the plan, said once: "D1 School (Blake Hammond Manor School)", or for an
 * exit point "D1, where Pacific Coast Highway leaves the area" (never "D1 Exit point (Exit point, ...)").
 */
export function fullDest(d: Destination): string {
  return destTitle(d);
}

/** Puts the real place names back into the writer's wording (the writer only saw the short labels). */
export function withPlaceNames(data: PlanResponse, dests: Destination[]): PlanResponse {
  const fix = (text: string) =>
    dests.reduce((t, d) => {
      const short = shortDest(d);
      if (!short) return t;
      // An exit point is a road, so it has no front entrance.
      const out = d.kind === 'exit_point' ? t.split(`${short}, front entrance`).join(short).split(`${short} front entrance`).join(short) : t;
      return out.split(short).join(fullDest(d));
    }, text);
  return {
    ...data,
    whenToLeave: fix(data.whenToLeave),
    meetingSpot: { primary: fix(data.meetingSpot.primary), ifClosed: fix(data.meetingSpot.ifClosed), reason: fix(data.meetingSpot.reason) },
  };
}

/** Same road segment in either direction. */
function segmentKey(graph: RoadGraph, edgeId: number): string {
  const e = graph.edges[edgeId];
  return e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
}

/** The road the plan treats as the one that may close: the drill's closing road, else the main route's second road. */
export function closedRoadName(run: DrillRun | null, main: Route | null): string {
  return run?.main?.binding?.name ?? main?.roadNames[Math.min(1, main.roadNames.length - 1)] ?? '';
}

export interface ClosureFacts {
  /** The backup drives the very segment where the main route closes, so it does not avoid the closure. */
  onSharedStretch: boolean;
  /** In this drill the fire also closed the backup before the car could pass. */
  backupCut: boolean;
  /** When the backup also uses the closing road (by name, on other segments): compass word for its way along it. */
  backupTurn: string;
  /** With backupTurn: compass word for the main route's way along the closing road. */
  mainTurn: string;
}

/** Compass word for the way a route drives along the first run of `road`; '' when it does not use it. */
function turnOn(graph: RoadGraph, route: Route, road: string): string {
  const first = route.edgeIds.findIndex((id) => graph.edges[id].name === road);
  if (first < 0) return '';
  let last = first;
  while (last + 1 < route.edgeIds.length && graph.edges[route.edgeIds[last + 1]].name === road) last++;
  const from = graph.nodes[graph.edges[route.edgeIds[first]].from].xy;
  const to = graph.nodes[graph.edges[route.edgeIds[last]].to].xy;
  return from.x !== to.x || from.y !== to.y ? compassName(bearingDeg(from, to)) : '';
}

/**
 * Facts about the backup and the road that may close, from the routes and the latest run.
 * The closure counts as shared when the backup drives the closing segment, or the same road
 * within SAME_CLOSURE_RADIUS_M of the closing spot (engine backupBlockedByMainClosure): then
 * "if X is closed, take the backup" would send people through the same closure.
 */
export function closureFacts(graph: RoadGraph | null, run: DrillRun | null, main: Route | null, backup: Route | null): ClosureFacts {
  const none: ClosureFacts = { onSharedStretch: false, backupCut: false, backupTurn: '', mainTurn: '' };
  if (!graph || !main || !backup) return none;
  const b = run?.main?.binding ?? null;
  const block = run ? backupBlockedByMainClosure(graph, run.main, run.backup) : null;
  const onSharedStretch =
    !!b && (backup.edgeIds.some((id) => segmentKey(graph, id) === segmentKey(graph, b.edgeId)) || block?.reason === 'same_road_nearby');
  const backupCut = !!b && run?.backup?.outcome === 'short';
  const closed = closedRoadName(run, main);
  const backupTurn = closed && !onSharedStretch ? turnOn(graph, backup, closed) : '';
  const mainTurn = backupTurn ? turnOn(graph, main, closed) : '';
  return { onSharedStretch, backupCut, backupTurn, mainTurn };
}

/** Heading of the second meeting spot field: from the side that differs when both routes use the road. */
export function ifClosedHeading(f: ClosureFacts, closed: string): string {
  return f.backupTurn && f.mainTurn && f.mainTurn !== f.backupTurn ? `If the way ${f.mainTurn} on ${closed} is closed` : `If ${closed} is closed`;
}

/** True when the backup is a real second way past the road that may close (same rule as server/plan.ts). */
export function backupUsable(f: ClosureFacts, closed: string, backup: Route | null): boolean {
  if (!backup || !closed || f.backupCut || f.onSharedStretch) return false;
  return !backup.roadNames.includes(closed) || f.backupTurn !== '';
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
  const route = (r: Route | null) =>
    r ? { roadNames: r.roadNames, driveMin: Math.round(r.driveMin), destination: shortDest(destOf(s, r)), exitPoint: destOf(s, r)?.kind === 'exit_point' } : null;
  const latest = latestRun(s);
  const binding = latest?.main?.binding ?? null;
  const facts = closureFacts(s.prepared?.graph ?? null, latest, main, backup);
  return {
    household: { adults: h.adults, children: h.children, needHelpMoving: h.needHelpMoving, dogs: h.dogs, catsAndSmallPets: h.catsAndSmallPets, cars: h.cars },
    tasks: fixedTasks(h.tasks, activeFixes(s)).map((t) => ({ label: writerLabel(t), minutes: t.minutes })),
    main: route(main),
    backup: route(backup),
    drill: binding
      ? { neededMin: Math.round(binding.passMin), closeMin: Math.round(binding.closeMin), roadName: binding.name, onSharedStretch: facts.onSharedStretch, backupCut: facts.backupCut }
      : null,
    backupTurn: facts.backupTurn,
    changes: changeLabels(s),
  };
}

/** "main route (way out B via Black Olive Drive)": which way out a run line is about. */
function routeWord(role: 'main route' | 'backup route', w: WaysOut | null, r: Route): string {
  return w ? `${role} (${wayOutName(w, r).replace(/^Way out/, 'way out')})` : role;
}

/** One sentence for a drill run, with an icon and words (never color alone). */
function RunResult({ label, run, ways }: { label: string; run: DrillRun; ways: WaysOut | null }) {
  if (!run.coverage.ignitionInGrid) {
    return <p className="plan-result"><Icon name="pending" /><span><b>{label}:</b> the fire started outside the modeled area, so no fire was simulated.</span></p>;
  }
  const m: RouteRun | null = run.main;
  if (!m) return <p className="plan-result"><Icon name="closed" /><span><b>{label}:</b> no way out found on mapped roads.</span></p>;
  if (m.outcome === 'never_closed' || !m.binding) {
    return <p className="plan-result"><Icon name="check" /><span><b>{label}:</b> this fire did not close your way out. You leave home at {fmtT(run.tasksMin)}.</span></p>;
  }
  return (
    <>
      <RouteRunLine label={`${label}, ${routeWord('main route', ways, m.route)}`} rr={m} />
      {run.backup && <RouteRunLine label={`${label}, ${routeWord('backup route', ways, run.backup.route)}`} rr={run.backup} />}
    </>
  );
}

/** One route's result in a run: closes or not, and the minutes short or to spare. */
function RouteRunLine({ label, rr }: { label: string; rr: RouteRun }) {
  const b = rr.binding;
  if (rr.outcome === 'never_closed' || !b) {
    return <p className="plan-result"><Icon name="check" /><span><b>{label}:</b> this fire did not close it.</span></p>;
  }
  const gap = Math.abs(Math.round(b.marginMin));
  const short = rr.outcome === 'short';
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

/** "9 min", or "under 1 min" when it rounds to zero. */
export const driveText = (m: number) => (Math.round(m) < 1 ? 'under 1 min' : `${fmtMin(m)} min`);

/** "The simulated fire reaches D1 School (...) at T+58, after you would arrive at T+31." Null when it never does. */
export function destFireLine(rr: RouteRun | null, destName: string): string | null {
  const df = rr?.destinationFire;
  if (!rr || !df || !df.inGrid || !Number.isFinite(df.fireMin)) return null;
  return `The simulated fire reaches ${destName} at ${fmtT(df.fireMin)}, ${df.beforeArrival ? 'before' : 'after'} you would arrive at ${fmtT(rr.arriveMin)}.`;
}

function RouteLine({ name, route, dest, unmodeled, ways, rr }: { name: string; route: Route | null; dest: Destination | null; unmodeled: string[]; ways: WaysOut | null; rr: RouteRun | null }) {
  if (!route) return <p><b>{name}:</b> {name === 'Main' ? 'no way out found on mapped roads.' : 'no second way out found on mapped roads.'}</p>;
  const destName = dest ? fullDest(dest) : 'the destination';
  const fire = destFireLine(rr, destName);
  return (
    <div className="stack-s">
      <p>
        <b>{name}{ways ? `, ${wayOutName(ways, route).replace(/^Way out/, 'way out')}` : ''}:</b> {route.roadNames.join(' → ')}. {driveText(route.driveMin)} to {destName}.
      </p>
      {fire && <p className="plan-result"><Icon name="warn" /><span>{fire} <Tag kind="calc" /></span></p>}
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
  const demoSettling = useDemoSettling();
  const [now, setNow] = useState(() => Date.now());
  const areaReady = !!state.prepared;
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
    // While ?demo=1 is still setting up, or the area is not ready, a plan would be replaced at once.
    if (fresh || inflightKey === key || demoSettling || !areaReady) return;
    inflightAbort?.abort(); // a plan for older inputs is no longer wanted
    const controller = new AbortController();
    inflightAbort = controller;
    inflightKey = key;
    inflightStartedAt = Date.now();
    setNow(inflightStartedAt);
    setError(null);
    dispatch({ type: 'plan/loading' });
    requestPlan(JSON.parse(key) as PlanRequest, controller.signal)
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
        if (inflightKey === key) {
          inflightKey = null;
          inflightAbort = null;
        }
      });
    // A change in status alone must not resend, so it is not a dependency.
  }, [key, attempt, dispatch, demoSettling, areaReady]);

  const area = state.area;
  const units = unitsFor(area?.country);
  const { main, backup } = currentRoutes(state);
  const mainDest = destOf(state, main);
  const backupDest = destOf(state, backup);
  const latest = latestRun(state);
  const before = state.before;
  const after = afterRun(state);
  const data = state.plan.data && doneKey === key ? state.plan.data : null;
  const ai = data?.source === 'ai';
  const waiting = !data && !error;

  // Seconds since the request went out, shown while waiting.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const elapsedS = inflightKey === key && inflightStartedAt > 0 ? Math.max(0, Math.round((now - inflightStartedAt) / 1000)) : 0;
  const w = state.prepared?.waysOut;
  const ways = w ?? null;
  const shared = w && w.sharedFromDoorM >= ONE_WAY_OUT_MIN_M && main && backup ? w : null;
  const closedRoad = closedRoadName(latest, main) || 'the main route';
  const facts = closureFacts(state.prepared?.graph ?? null, latest, main, backup);
  const usable = backupUsable(facts, closedRoad, backup);
  const meetPlaceholder = mainDest?.kind === 'exit_point' ? 'Choose a place everyone knows' : undefined;
  const meet2Placeholder = !usable ? 'Agree on a spot together' : backupDest?.kind === 'exit_point' ? 'Choose a second place everyone knows' : undefined;
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const wind = (latest?.setup.wind ?? state.setup.wind);
  const sources = area ? dataSources(area, wind, state.isDemo) : '';

  const writtenTag = ai ? <Tag kind="ai" /> : null;
  // The first section says how long it usually takes and counts the seconds; the others just wait.
  const pendingFirst = (
    <p className="plan-wait" role="status">
      <Icon name="pending" />
      <span>Writing the plan. This usually takes 10 to 40 seconds.</span>
      <span className="plan-elapsed" aria-hidden="true">{elapsedS} s so far</span>
    </p>
  );
  const pending = (
    <p className="plan-wait">
      <Icon name="pending" />
      <span>Writing...</span>
    </p>
  );
  const failed = error && (
    <div className="plan-wait" role="alert">
      <Icon name="warn" /> <span>{error} The routes and drill result above are still correct.</span>
      <button type="button" className="noprint" onClick={() => { inflightKey = null; inflightAbort = null; setAttempt((n) => n + 1); }}>Try again</button>
    </div>
  );

  return (
    <main className="narrow plan">
      <div className="row between">
        <h1>Our leaving plan</h1>
        <button className="primary noprint" type="button" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <p className="printonly plan-printnote"><b>Practice drill only.</b> {DISCLAIMER}</p>
      <p>
        {area?.addressLabel ?? 'Your address'}
        {state.isDemo && <> <span className="chip">Demo address</span></>} · {householdLine(state.household)} · Made {today}
      </p>

      <section className="stack-s box" aria-labelledby="p-leave">
        <h2 id="p-leave">When told to leave {writtenTag}</h2>
        {data ? <p className="plan-lead">{data.whenToLeave}</p> : waiting ? pendingFirst : failed}
        {data && !ai && <p className="small muted">Fixed checklist (AI writer unavailable).</p>}
      </section>

      <section className="cols2">
        <div className="stack-s">
          <h2>Routes <Tag kind="calc" /></h2>
          <RouteLine name="Main" route={main} dest={mainDest} ways={ways} rr={latest?.main ?? null} unmodeled={latest ? unmodeledRoads(state, latest.coverage.mainUnmodeledEdgeIds) : []} />
          <RouteLine name="Backup" route={backup} dest={backupDest} ways={ways} rr={latest?.backup ?? null} unmodeled={latest ? unmodeledRoads(state, latest.coverage.backupUnmodeledEdgeIds) : []} />
          {shared && (
            <p className="plan-result"><Icon name="oneway" /><span>One way out: both routes use {shared.sharedRoadNames.join(', ')} for the first {fmtDist(shared.sharedFromDoorM, units)}.</span></p>
          )}
          <p className="small muted">Destinations are candidate destinations, not confirmed shelters. Follow official directions.</p>
        </div>
        <div className="stack-s">
          <h2>Meet here if separated {writtenTag}</h2>
          {data ? (
            <>
              <Field id="meet" label="Meeting spot (you can change it)" value={state.meeting.primary} placeholder={meetPlaceholder} onChange={(v) => dispatch({ type: 'meeting/set', patch: { primary: v } })} />
              <Field id="meet2" label={ifClosedHeading(facts, closedRoad)} value={state.meeting.ifClosed} placeholder={meet2Placeholder} onChange={(v) => dispatch({ type: 'meeting/set', patch: { ifClosed: v } })} />
              {backup && !usable && (
                <p className="plan-result">
                  <Icon name={facts.backupCut ? 'closed' : 'oneway'} />
                  <span>
                    {facts.backupCut
                      ? 'In this drill the fire closed both routes, so no backup meeting spot can be reached. Agree on one together, and follow official directions.'
                      : `Both routes use ${closedRoad}, so no backup meeting spot past it can be reached. Agree on one together, and follow official directions.`}
                  </span>
                </p>
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
            <RunResult label={after ? 'Before your changes' : 'This drill'} run={before} ways={ways} />
            {after ? <RunResult label="After your changes" run={after} ways={ways} /> : <p className="small muted">No changes tried yet. <a className="noprint" href="#/fix">Fix the plan</a></p>}
            <p className="small muted">
              {after ? 'Same simulated fire for both' : 'Simulated fire'}: wind from the {compassName(wind.fromDeg)}, {fmtSpeed(wind.speedMph, units)} ({windSourceWord(wind, state.isDemo)}), {before.setup.start === 'night' ? 'night start' : 'day start'}. Assumes the order to leave comes when the fire starts.
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
            {ai ? <Tag kind="ai" /> : data ? <b className="small">Fixed checklist</b> : <b className="small">{waiting ? 'Writing...' : 'Not written'}</b>}
            <p>
              {ai
                ? `"When told to leave", the meeting spot, the go-bag and this week's list, written by ${data?.model ?? 'the AI writer'}. Wording only: it cannot change times or routes. The sentence about the backup route is built from the drill.`
                : data
                  ? '"When told to leave", the meeting spot, the go-bag and this week\'s list come from a fixed checklist filled with your routes, because the AI writer was not used.'
                  : waiting
                    ? '"When told to leave", the meeting spot, the go-bag and this week\'s list are being written. Wording only: the writer cannot change times or routes.'
                    : '"When told to leave", the meeting spot, the go-bag and this week\'s list could not be written. Try again above.'}
            </p>
          </div>
        </div>
        <p className="how-data">
          Data: {sources || 'OpenStreetMap'}. Routing: our own fastest-time search on the OpenStreetMap roads, no traffic.
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
