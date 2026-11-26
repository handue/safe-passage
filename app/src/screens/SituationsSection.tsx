// "Other situations, same fire": the fire stays the same and the household's day goes differently.
// Every time here is calculated by the engine (runSituations) on the drill's own fire. The values in
// each situation are starting guesses the user can change. The AI only picks which situations to
// show and writes the one-line reasons (AI-WRITTEN).
import { useMemo, useState } from 'react';
import { effectiveSpecs, fixedTasks, hasFixes, swappedWaysOut, useApp, type AppState, type SituationsState } from '../app/state';
import { safeRunSituations } from '../app/situations';
import { displayDiffMin, displayMin, type DrillRun } from '../engine/drill';
import type { PreparedArea } from '../engine/area';
import type { RouteRun, Task } from '../engine/types';
import { passCount, type SituationKind, type SituationResult, type SituationSpec } from '../engine/situations';
import { Icon, type IconName } from '../ui/Icon';
import { Tag, fmtT } from '../ui/Tag';
import { destLabel, verdictOf, wayOutName } from './ResultsScreen';
import '../styles/situations.css';

// ---------- Words for one result (pure, tested) ----------

export interface ResultWords {
  tone: 'short' | 'spare' | 'open' | 'none';
  icon: IconName;
  text: string;
  /** Minutes to spare as shown (negative = short); Infinity when the road never closed; null without a route. */
  shown: number | null;
}

/** Signed margin as shown on screen: each T+ value rounded first, like verdictOf. */
export function shownMargin(run: RouteRun | null): number | null {
  if (!run) return null;
  const b = run.binding;
  if (!b) return Infinity;
  return displayDiffMin(b.closeMin, b.passMin);
}

/** "3 min to spare", "6 min short", "Road never closed in this fire" or "No route", with an icon. */
export function resultWords(r: Pick<SituationResult, 'run' | 'outcome'>): ResultWords {
  if (!r.run || r.outcome === 'no_route') return { tone: 'none', icon: 'closed', text: 'No route', shown: null };
  if (!r.run.binding) return { tone: 'open', icon: 'check', text: 'Road never closed in this fire', shown: Infinity };
  const v = verdictOf(r.run);
  const shown = shownMargin(r.run)!;
  return { tone: v.kind === 'short' ? 'short' : 'spare', icon: v.kind === 'short' ? 'closed' : 'check', text: v.shortText, shown };
}

const minus = (n: number) => `−${Math.abs(n)}`;
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? minus(n) : '0');

/** "−7 min vs this drill", "Same as this drill", or '' without a route. From the numbers shown. */
export function deltaWords(r: Pick<SituationResult, 'run' | 'outcome'>, base: RouteRun | null): string {
  const a = r.outcome === 'no_route' ? null : shownMargin(r.run);
  const b = shownMargin(base);
  if (a === null || b === null) return '';
  if (a === Infinity && b === Infinity) return 'Same as this drill';
  if (a === Infinity) return 'Better than this drill';
  if (b === Infinity) return 'Worse than this drill';
  const d = a - b;
  return d === 0 ? 'Same as this drill' : `${signed(d)} min vs this drill`;
}

/** "2 min to spare (+8)" for a next action, from the numbers shown. */
export function nextActionWords(r: Pick<SituationResult, 'run' | 'outcome' | 'nextAction'>): string | null {
  const na = r.nextAction;
  if (!na) return null;
  if (na.outcome === 'never_closed' || !Number.isFinite(na.marginMin)) return 'road never closes';
  // From the action's own T+ values, rounded like every other margin shown, so "(+N)" adds up.
  const m = na.run ? shownMargin(na.run)! : displayMin(na.marginMin);
  const after = m === 0 ? (na.outcome === 'short' ? 'under 1 min short' : 'under 1 min to spare') : m < 0 ? `${-m} min short` : `${m} min to spare`;
  const before = r.outcome === 'no_route' ? null : shownMargin(r.run);
  const gain = before !== null && Number.isFinite(before) ? m - before : null;
  return gain !== null && gain !== 0 ? `${after} (${signed(gain)})` : after;
}

/** "1.5" for multipliers, "10" for minutes: the same text the engine puts in its sentence. */
const paramText = (p: number) => String(Math.round(p * 10) / 10);

// ---------- Pieces ----------

function ParamInput({ r, onParam }: { r: SituationResult; onParam: (kind: SituationKind, p: number) => void }) {
  const { info, spec } = r;
  const [draft, setDraft] = useState<string | null>(null);
  const isX = info.paramUnit === 'x';
  return (
    <input
      type="number"
      inputMode={isX ? 'decimal' : 'numeric'}
      className="sit-param"
      min={info.minParam}
      max={info.maxParam}
      step={isX ? 0.1 : 1}
      value={draft ?? paramText(spec.param)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number.parseFloat(e.target.value);
        if (Number.isFinite(n)) onParam(spec.kind, n);
      }}
      onBlur={() => setDraft(null)}
      aria-label={`${info.title}: ${info.paramLabel || 'value'}, from ${info.minParam} to ${info.maxParam}`}
    />
  );
}

/** The assumption sentence with its value as a number input in place, and where the value came from. */
function Assumption({ r, edited, onParam }: { r: SituationResult; edited: boolean; onParam?: (kind: SituationKind, p: number) => void }) {
  const { info, spec } = r;
  const sentence = info.assumption(spec.param);
  const editable = !!onParam && info.minParam < info.maxParam;
  if (!editable) return <p className="sit-assume">{sentence}</p>;
  const p = paramText(spec.param);
  const at = sentence.indexOf(p);
  const input = <ParamInput r={r} onParam={onParam!} />;
  // A value is an estimate whoever set it (rules, the AI or the user): never AI-WRITTEN.
  const origin = <span className="sit-origin">{edited ? 'your value' : 'starting guess'} <Tag kind="est" /></span>;
  return (
    <p className="sit-assume">
      {at >= 0 ? (
        <>
          {sentence.slice(0, at)}
          {input}
          {sentence.slice(at + p.length)}
        </>
      ) : (
        <>
          {sentence} {input} {info.paramLabel}
        </>
      )}{' '}
      {origin}
    </p>
  );
}

function RoadCell({ r, prepared }: { r: SituationResult; prepared: PreparedArea }) {
  const run = r.run;
  if (!run) return <span className="muted">No backup route found on mapped roads.</span>;
  const route = `${r.route === 'backup' ? 'Backup' : 'Main'}, ${wayOutName(prepared.waysOut, run.route).replace(/^Way out/, 'way out')}`;
  const b = run.binding;
  return (
    <>
      <span className="sit-route">{route}</span>
      {b ? (
        <span>
          <b>{b.name}</b> closes {fmtT(b.closeMin)} / you pass {fmtT(b.passMin)}
        </span>
      ) : (
        <span>You reach {destLabel(prepared, run.route.destinationId)} at {fmtT(run.arriveMin)}</span>
      )}
    </>
  );
}

function NextActionCell({ r }: { r: SituationResult }) {
  const words = nextActionWords(r);
  if (!r.nextAction || !words) {
    return <span className="muted">{r.outcome === 'short' || r.outcome === 'no_route' ? 'No change we can measure helps here. Follow official directions.' : 'Nothing more needed.'}</span>;
  }
  return (
    <>
      <span className="sit-action">{r.nextAction.text}</span>
      <span className="sit-gain">
        → {words} <Tag kind={r.nextAction.tag} />
      </span>
    </>
  );
}

/** "Situations chosen by AI for this household", or the rules line, or the quiet waiting line. */
export function SourceLine({ sit }: { sit: SituationsState }) {
  if (sit.status === 'loading') return <p className="sit-source muted" role="status">Choosing situations for your household...</p>;
  if (sit.source === 'ai')
    return (
      <p className="sit-source" role="status">
        Updated: the AI picked these situations to test where this household's plan is weakest. <Tag kind="ai" />
      </p>
    );
  return <p className="sit-source muted">Situations chosen by fixed rules</p>;
}

/** The results for the base drill, for the Results screen and its section. */
export function useSituationResults(prepared: PreparedArea | null, base: DrillRun | null, tasks: Task[]): SituationResult[] {
  const { state } = useApp();
  const specs = useMemo(() => effectiveSpecs(state.situations), [state.situations]);
  return useMemo(() => safeRunSituations(prepared, base, tasks, specs), [prepared, base, tasks, specs]);
}

// ---------- Results screen section ----------

export function SituationsSection({ prepared, base, tasks }: { prepared: PreparedArea; base: DrillRun; tasks: Task[] }) {
  const { state, dispatch } = useApp();
  const sit = state.situations;
  const results = useSituationResults(prepared, base, tasks);
  if (sit.status === 'idle' || results.length === 0) return null;
  const { pass, total } = passCount(results);
  const onParam = (kind: SituationKind, param: number) => dispatch({ type: 'situations/param', kind, param });

  return (
    <section className="sit" aria-labelledby="sit-h">
      <div className="stack-s">
        <h2 id="sit-h">Other situations, same fire</h2>
        <p className="sit-head">
          Your plan holds in <b>{pass} of {total}</b> harder days we tested. <Tag kind="calc" />
        </p>
        <p className="small muted">
          These are hard cases, picked on purpose to find weak spots. The same simulated fire, but the day goes differently. Times are calculated. The values in each situation are starting guesses you can change.
        </p>
        <SourceLine sit={sit} />
      </div>
      <div className="sit-wrap">
        <table className="sit-table">
          <thead>
            <tr>
              <th scope="col">Situation</th>
              <th scope="col">Leaves home</th>
              <th scope="col">Road</th>
              <th scope="col">Result</th>
              <th scope="col">Next action</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const w = resultWords(r);
              const delta = deltaWords(r, base.main);
              return (
                <tr key={r.spec.kind} className={`sit-row sit-tone-${w.tone}`}>
                  <td className="sit-what">
                    <b className="sit-title">{r.info.title}</b>
                    <Assumption r={r} edited={sit.editedParams[r.spec.kind] !== undefined} onParam={onParam} />
                    {r.spec.reason && (
                      <p className="sit-reason">
                        <span className="sit-reason-label">Why this one:</span> <i>{r.spec.reason}</i> <Tag kind="ai" />
                      </p>
                    )}
                  </td>
                  <td data-label="Leaves home">
                    <span className="sit-num">{fmtT(r.departMin)}</span> <Tag kind="calc" />
                  </td>
                  <td data-label="Road" className="sit-road">
                    <RoadCell r={r} prepared={prepared} />
                  </td>
                  <td data-label="Result" className="sit-result">
                    <span className={`sit-verdict is-${w.tone}`}>
                      <Icon name={w.icon} />
                      <b>{w.text}</b>
                    </span>
                    {delta && <span className="sit-delta">{delta}</span>}
                  </td>
                  <td data-label="Next action" className="sit-next">
                    <NextActionCell r={r} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- Fix screen: before and after counts ----------

/** Situations run on the run after changes: fixed tasks, and the swapped routes when the user switched. */
function afterResults(
  s: Pick<AppState, 'prepared' | 'after' | 'fixes' | 'household'>,
  specs: SituationSpec[],
): SituationResult[] | null {
  if (!s.prepared || !s.after || !hasFixes(s.fixes)) return null;
  const prepared = s.fixes.switchMainRoute ? { ...s.prepared, waysOut: swappedWaysOut(s.prepared.waysOut) } : s.prepared;
  return safeRunSituations(prepared, s.after, fixedTasks(s.household.tasks, s.fixes), specs);
}

/** Fix screen line: how many situations hold before and after the changes, and what still fails. */
export function FixSituations() {
  const { state } = useApp();
  const { prepared, before: base, after: run, fixes, household, situations } = state;
  const specs = useMemo(() => effectiveSpecs(situations), [situations]);
  const before = useMemo(() => safeRunSituations(prepared, base, household.tasks, specs), [prepared, base, household.tasks, specs]);
  const after = useMemo(() => afterResults({ prepared, after: run, fixes, household }, specs), [prepared, run, fixes, household, specs]);
  return <SituationsCompare before={before} after={after} sit={situations} />;
}

export function SituationsCompare({ before, after, sit }: { before: SituationResult[]; after: SituationResult[] | null; sit: SituationsState }) {
  if (before.length === 0 || sit.status === 'idle') return null;
  const b = passCount(before);
  const a = after ? passCount(after) : null;
  const failing = (after ?? before).filter((r) => r.outcome === 'short' || r.outcome === 'no_route');
  return (
    <div className="sit-compare">
      <p>
        <b>Situations that hold:</b>{' '}
        {a ? (
          <>
            {b.pass} of {b.total} before → {a.pass} of {a.total} after your changes
          </>
        ) : (
          <>
            {b.pass} of {b.total}. Choose changes to see how many more hold.
          </>
        )}{' '}
        <Tag kind="calc" />
      </p>
      {failing.length > 0 && (
        <ul className="sit-fails" aria-label={a ? 'Situations that still fail after your changes' : 'Situations that fail'}>
          {failing.map((r) => {
            const w = resultWords(r);
            const words = nextActionWords(r);
            return (
              <li key={r.spec.kind}>
                <Icon name={w.icon} />
                <span>
                  <b>{r.info.title}:</b> {w.text}.
                  {r.nextAction && words ? (
                    <>
                      {' '}Next: {r.nextAction.text} → {words} <Tag kind={r.nextAction.tag} />
                    </>
                  ) : (
                    ' No change we can measure helps here.'
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- Plan screen: printable list ----------

/** Plan screen: each situation on the latest run (after changes when there are any). No new AI call. */
export function PlanSituations() {
  const { state } = useApp();
  const { prepared, before, after, fixes, household, situations } = state;
  const specs = useMemo(() => effectiveSpecs(situations), [situations]);
  const results = useMemo(() => {
    const changed = after && hasFixes(fixes);
    if (!changed) return safeRunSituations(prepared, before, household.tasks, specs);
    return afterResults({ prepared, after, fixes, household }, specs) ?? [];
  }, [prepared, before, after, fixes, household, specs]);
  if (situations.status === 'idle' || results.length === 0) return null;
  const { pass, total } = passCount(results);
  return (
    <>
      <p>
        Your plan{after && hasFixes(fixes) ? ', with your changes,' : ''} holds in <b>{pass} of {total}</b> harder days we tested on the same simulated fire. <Tag kind="calc" />
      </p>
      <SituationsPlanList results={results} />
      <p className="small muted">
        These are hard cases, picked on purpose{situations.source === 'ai' ? ' by AI' : ' by fixed rules'} to find weak spots. The value in each "If" is a starting guess. Times are calculated.
      </p>
    </>
  );
}

export function SituationsPlanList({ results }: { results: SituationResult[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="sit-plan">
      {results.map((r) => {
        const w = resultWords(r);
        return (
          <li key={r.spec.kind} className={`plan-result is-${w.tone === 'short' ? 'short' : w.tone === 'spare' ? 'spare' : 'plain'}`}>
            <Icon name={w.icon} />
            <span>
              <b>{r.info.title}.</b> If: {r.info.assumption(r.spec.param)} <Tag kind="est" />{' '}
              Result: you leave home at {fmtT(r.departMin)}. <b>{w.text}.</b> <Tag kind="calc" />
              {r.nextAction && <> Next: {r.nextAction.text}.</>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
