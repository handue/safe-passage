// "Other situations, same fire": the fire stays the same and the household's day goes differently.
// Every time here is calculated by the engine (runSituations) on the drill's own fire. The values in
// each situation are starting guesses the user can change. The AI only picks which situations to
// show and writes the one-line reasons (AI-WRITTEN). A situation the user types is turned by the AI
// into the engine's levers only; the user checks every value before the engine runs it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { effectiveSpecs, fixedTasks, hasFixes, swappedWaysOut, useApp, type AppState, type SituationsState } from '../app/state';
import {
  MAX_CUSTOM,
  MAX_SITUATION_TEXT,
  buildInterpretRequest,
  cleanSituationText,
  customFromDraft,
  customFromPick,
  draftFromResponse,
  pickableKinds,
  rebaseCustom,
  rowKey,
  safeRunCustom,
  safeRunSituations,
  type CustomDraft,
} from '../app/situations';
import { requestInterpretSituation } from '../app/api';
import { displayDiffMin, displayMin, type DrillRun } from '../engine/drill';
import type { PreparedArea } from '../engine/area';
import type { RouteRun, Task } from '../engine/types';
import {
  SITUATIONS,
  applicableKinds,
  clampParam,
  emptyParts,
  passCount,
  sanitizeCustomParts,
  type CustomParts,
  type CustomSituation,
  type SituationKind,
  type SituationResult,
  type SituationSpec,
} from '../engine/situations';
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

/** A small number input inside a sentence. It keeps what is typed until blur, then shows the stored value. */
export function NumInput(props: { value: number; min: number; max: number; decimal?: boolean; label: string; onValue: (n: number) => void }) {
  const { value, min, max, decimal, label, onValue } = props;
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      inputMode={decimal ? 'decimal' : 'numeric'}
      className="sit-param"
      min={min}
      max={max}
      step={decimal ? 0.1 : 1}
      value={draft ?? paramText(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number.parseFloat(e.target.value);
        if (Number.isFinite(n)) onValue(n);
      }}
      onBlur={() => setDraft(null)}
      aria-label={`${label}, from ${min} to ${max}`}
    />
  );
}

function ParamInput({ r, onParam }: { r: SituationResult; onParam: (kind: SituationKind, p: number) => void }) {
  const { info, spec } = r;
  return (
    <NumInput
      value={spec.param}
      min={info.minParam}
      max={info.maxParam}
      decimal={info.paramUnit === 'x'}
      label={`${info.title}: ${info.paramLabel || 'value'}`}
      onValue={(n) => onParam(spec.kind, n)}
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

/** The results for the base drill, for the Results screen and its section: catalog rows, then the user's own. */
export function useSituationResults(prepared: PreparedArea | null, base: DrillRun | null, tasks: Task[]): SituationResult[] {
  const { state } = useApp();
  const specs = useMemo(() => effectiveSpecs(state.situations), [state.situations]);
  const custom = state.customSituations;
  return useMemo(
    () => [...safeRunSituations(prepared, base, tasks, specs), ...safeRunCustom(prepared, base, tasks, custom)],
    [prepared, base, tasks, specs, custom],
  );
}

// ---------- Describe your own situation ----------

export const EXAMPLE_SITUATIONS = [
  'My partner is at work and has the car',
  'Grandma is upstairs and needs help on the stairs',
  'We also have a horse trailer to hitch',
];

const clampTaskMin = (n: number, lo: number) => Math.min(60, Math.max(lo, Math.round(n)));

/** One part of the interpretation as a sentence, with its number as an input in place. */
function PartLine({ children, label, onRemove, removable }: { children: ReactNode; label: string; onRemove: () => void; removable: boolean }) {
  return (
    <li>
      <span className="own-part-text">{children}</span>
      {removable && (
        <button type="button" className="own-link" onClick={onRemove} aria-label={`Remove: ${label}`}>
          Remove
        </button>
      )}
    </li>
  );
}

/** The sentence for one situation kind, with its value as an input where the value appears. */
function KindSentence({ kind, param, onParam }: { kind: SituationKind; param: number; onParam: (p: number) => void }) {
  const info = SITUATIONS[kind];
  const sentence = info.assumption(param);
  if (info.minParam >= info.maxParam) return <>{sentence}</>;
  const p = paramText(param);
  const at = sentence.indexOf(p);
  const input = <NumInput value={param} min={info.minParam} max={info.maxParam} decimal={info.paramUnit === 'x'} label={`${info.title}: ${info.paramLabel || 'value'}`} onValue={onParam} />;
  return at >= 0 ? (
    <>
      {sentence.slice(0, at)}
      {input}
      {sentence.slice(at + p.length)} <Tag kind="est" />
    </>
  ) : (
    <>
      {sentence} {input} {info.paramLabel} <Tag kind="est" />
    </>
  );
}

/** "The AI read this as:" with every number editable, the title editable, and what the drill cannot measure. */
function InterpretCard(props: {
  draft: CustomDraft;
  tasks: Task[];
  editing: boolean;
  /** No room for another row: adding is turned off and the card says so. */
  full?: boolean;
  onChange: (d: CustomDraft) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const { draft, tasks, editing, full, onChange, onAdd, onCancel } = props;
  const { parts } = draft;
  const setParts = (p: CustomParts) => onChange({ ...draft, parts: p, partsEdited: true });
  // Move focus to the card when it opens, so keyboard and screen-reader users land on it.
  const head = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => head.current?.focus(), []);
  const count = parts.situations.length + parts.addTasks.length + Object.keys(parts.taskMinutes).length;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const fromAi = draft.text !== '';
  return (
    <div className="own-card" role="group" aria-labelledby="own-card-h">
      <p id="own-card-h" className="own-card-h" tabIndex={-1} ref={head}>
        {fromAi ? (
          <>
            The AI read this as: <Tag kind="ai" />
          </>
        ) : (
          'This situation:'
        )}
      </p>
      {fromAi && <q className="own-quote">{draft.text}</q>}
      <label className="own-title">
        <span>Name</span>
        <input
          type="text"
          maxLength={50}
          value={draft.title}
          onChange={(e) => onChange({ ...draft, title: e.target.value, titleSource: 'user' })}
        />
        {draft.titleSource === 'ai' && <Tag kind="ai" />}
      </label>
      <ul className="own-parts">
        {parts.situations.map((s, i) => (
          <PartLine key={s.kind} label={SITUATIONS[s.kind].title} removable={count > 1} onRemove={() => setParts({ ...parts, situations: parts.situations.filter((_, j) => j !== i) })}>
            <KindSentence
              kind={s.kind}
              param={s.param}
              onParam={(n) => setParts({ ...parts, situations: parts.situations.map((x, j) => (j === i ? { ...x, param: clampParam(x.kind, n) } : x)) })}
            />
          </PartLine>
        ))}
        {parts.addTasks.map((t, i) => (
          <PartLine key={`add-${i}`} label={`Added task: ${t.label}`} removable={count > 1} onRemove={() => setParts({ ...parts, addTasks: parts.addTasks.filter((_, j) => j !== i) })}>
            Added task: {t.label}, taking{' '}
            <NumInput
              value={t.minutes}
              min={1}
              max={60}
              label={`Minutes for ${t.label}`}
              onValue={(n) => setParts({ ...parts, addTasks: parts.addTasks.map((x, j) => (j === i ? { ...x, minutes: clampTaskMin(n, 1) } : x)) })}
            />{' '}
            min. <Tag kind="est" />
          </PartLine>
        ))}
        {Object.entries(parts.taskMinutes).map(([id, m]) => {
          const t = byId.get(id);
          if (!t) return null;
          return (
            <PartLine
              key={`task-${id}`}
              label={t.label}
              removable={count > 1}
              onRemove={() => {
                const next = { ...parts.taskMinutes };
                delete next[id];
                setParts({ ...parts, taskMinutes: next });
              }}
            >
              {t.label} takes{' '}
              <NumInput value={m} min={0} max={60} label={`Minutes for ${t.label}`} onValue={(n) => setParts({ ...parts, taskMinutes: { ...parts.taskMinutes, [id]: clampTaskMin(n, 0) } })} />{' '}
              min instead of {Math.round(t.minutes)} min{m === 0 ? ' (skipped)' : ''}. <Tag kind="est" />
            </PartLine>
          );
        })}
      </ul>
      <p className="small muted">Each number is a starting guess. Change any that look wrong. The drill then calculates the times.</p>
      {draft.cannotModel && (
        <p className="own-cannot">
          Not measured by this drill: {draft.cannotModel} <Tag kind="ai" />
        </p>
      )}
      {full && !editing && (
        <p className="small muted">You are testing {MAX_CUSTOM} of your own situations, the most this drill holds. Remove one to add this.</p>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={onAdd} disabled={(full && !editing) || emptyParts(sanitizeCustomParts(parts, tasks))}>
          {editing ? 'Save changes' : 'Add to the test'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

type OwnPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'card'; draft: CustomDraft }
  | { kind: 'unmeasurable'; cannotModel: string };

/** A row being changed: its id and the draft shown in the card. */
export interface OwnEdit {
  id: string;
  draft: CustomDraft;
}

export function draftOf(c: CustomSituation): CustomDraft {
  return { text: c.text, title: c.title, titleSource: c.titleSource, parts: c.parts, cannotModel: '', partsEdited: c.partsEdited };
}

/** "Describe your own situation": type a sentence, check what the AI read, add it to the table. */
function OwnSituation(props: { prepared: PreparedArea; base: DrillRun; tasks: Task[]; edit: OwnEdit | null; onEdit: (e: OwnEdit | null) => void }) {
  const { prepared, base, tasks, edit, onEdit } = props;
  const { state, dispatch } = useApp();
  const custom = state.customSituations;
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<OwnPhase>({ kind: 'idle' });
  const [aiDown, setAiDown] = useState(false);
  const [pick, setPick] = useState('');
  const abort = useRef<AbortController | null>(null);
  const available = useMemo(() => applicableKinds(state.household, prepared, base), [state.household, prepared, base]);
  const pickable = pickableKinds(available, effectiveSpecs(state.situations), custom);

  useEffect(() => () => abort.current?.abort(), []);
  // "Change" is clicked in a row above: bring the card into view.
  const section = useRef<HTMLElement | null>(null);
  const editId = edit?.id ?? null;
  useEffect(() => {
    if (!editId) return;
    section.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    // A reply arriving now would close the edit card: stop the request instead.
    if (abort.current) {
      abort.current.abort();
      abort.current = null;
      setPhase({ kind: 'idle' });
    }
  }, [editId]);

  // Where focus goes after the form is swapped: the text input, the "not available" line, or the Cancel button.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const downRef = useRef<HTMLParagraphElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const headRef = useRef<HTMLHeadingElement | null>(null);
  const focusNext = useRef<'input' | 'down' | 'cancel' | null>(null);
  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    focusNext.current = null;
    const el = f === 'cancel' ? cancelRef.current : f === 'down' ? downRef.current : inputRef.current ?? headRef.current;
    el?.focus();
  });

  const full = custom.length >= MAX_CUSTOM;
  const clean = cleanSituationText(text);

  const submit = () => {
    if (!clean || full) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    focusNext.current = 'cancel';
    setPhase({ kind: 'loading' });
    const body = buildInterpretRequest(clean, state.household, tasks, available);
    void requestInterpretSituation(body, controller.signal).then((res) => {
      if (controller.signal.aborted || abort.current !== controller) return;
      abort.current = null;
      const out = draftFromResponse(res, clean, tasks);
      if (out.kind === 'fallback') {
        focusNext.current = 'down';
        setAiDown(true);
        setPhase({ kind: 'idle' });
      } else if (out.kind === 'unmeasurable') {
        focusNext.current = 'input';
        setPhase({ kind: 'unmeasurable', cannotModel: out.cannotModel });
      } else {
        setAiDown(false);
        onEdit(null);
        setPhase({ kind: 'card', draft: out.draft });
      }
    });
  };
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    focusNext.current = 'input';
    setPhase({ kind: 'idle' });
  };
  const addDraft = (d: CustomDraft) => {
    if (full) return;
    focusNext.current = 'input';
    dispatch({ type: 'custom/add', custom: customFromDraft(d) });
    setText('');
    setPhase({ kind: 'idle' });
  };
  const addPick = () => {
    const kind = pickable.find((k) => k === pick) ?? pickable[0];
    if (!kind || full) return;
    dispatch({ type: 'custom/add', custom: customFromPick(kind) });
    setPick('');
  };

  if (edit) {
    return (
      <section className="own" aria-labelledby="own-h" ref={section}>
        <h3 id="own-h">Change your situation</h3>
        <InterpretCard
          key={edit.id}
          draft={edit.draft}
          tasks={tasks}
          editing
          onChange={(draft) => onEdit({ ...edit, draft })}
          onAdd={() => {
            dispatch({ type: 'custom/edit', id: edit.id, parts: edit.draft.parts, title: edit.draft.title, titleSource: edit.draft.titleSource, partsEdited: edit.draft.partsEdited });
            focusNext.current = 'input';
            onEdit(null);
          }}
          onCancel={() => {
            focusNext.current = 'input';
            onEdit(null);
          }}
        />
      </section>
    );
  }

  if (phase.kind === 'card') {
    return (
      <section className="own" aria-labelledby="own-h">
        <h3 id="own-h">Describe your own situation</h3>
        <InterpretCard draft={phase.draft} tasks={tasks} editing={false} full={full} onChange={(draft) => setPhase({ kind: 'card', draft })} onAdd={() => addDraft(phase.draft)} onCancel={cancel} />
      </section>
    );
  }

  return (
    <section className="own" aria-labelledby="own-h">
      <h3 id="own-h" tabIndex={-1} ref={headRef}>
        Describe your own situation
      </h3>
      {full ? (
        <p className="small muted">You are testing {MAX_CUSTOM} of your own situations, the most this drill holds. Remove one to add another.</p>
      ) : (
        <>
          {aiDown ? (
            <div className="own-down">
              <p tabIndex={-1} ref={downRef}>
                Typing a situation needs the AI writer, which is not available now.
              </p>
              <button type="button" className="own-link" onClick={() => setAiDown(false)}>
                Try typing again
              </button>
            </div>
          ) : (
            <>
              <form
                className="own-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <label htmlFor="own-text" className="small">
                  What could go differently on your day?
                </label>
                <div className="own-inputrow">
                  <input
                    id="own-text"
                    ref={inputRef}
                    type="text"
                    maxLength={MAX_SITUATION_TEXT}
                    value={text}
                    placeholder="For example: my partner is at work and has the car"
                    onChange={(e) => setText(e.target.value)}
                    disabled={phase.kind === 'loading'}
                    aria-describedby="own-privacy"
                  />
                  <button type="submit" disabled={!clean || phase.kind === 'loading'}>
                    Test this situation
                  </button>
                </div>
                <p id="own-privacy" className="small muted">
                  Don't type names, addresses or phone numbers. The text is sent to the AI writer.
                </p>
              </form>
              <div className="own-chips" aria-label="Examples">
                {EXAMPLE_SITUATIONS.map((ex) => (
                  <button key={ex} type="button" className="own-chip" onClick={() => setText(ex)} disabled={phase.kind === 'loading'}>
                    {ex}
                  </button>
                ))}
              </div>
              {phase.kind === 'loading' && (
                <div className="own-wait">
                  <p className="muted" role="status">
                    Reading your situation...
                  </p>
                  <button type="button" className="own-link" onClick={cancel} ref={cancelRef}>
                    Cancel
                  </button>
                </div>
              )}
              {phase.kind === 'unmeasurable' && (
                <div className="own-note" role="status">
                  {phase.cannotModel && (
                    <p>
                      Not measured by this drill: {phase.cannotModel} <Tag kind="ai" />
                    </p>
                  )}
                  <p>Try other words, or pick a situation from the list.</p>
                </div>
              )}
            </>
          )}
          {pickable.length > 0 && (
            <div className="own-pick">
              <label htmlFor="own-pick">{aiDown ? 'Pick a situation from the list' : 'Or pick from the list'}</label>
              <div className="own-inputrow">
                <select id="own-pick" value={pick || pickable[0]} onChange={(e) => setPick(e.target.value)}>
                  {pickable.map((k) => (
                    <option key={k} value={k}>
                      {SITUATIONS[k].title}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={addPick} disabled={phase.kind === 'loading'}>
                  Add
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The "what" cell for a row the user described or picked. */
function OwnWhat({ r, onEdit, onRemove }: { r: SituationResult; onEdit: () => void; onRemove: () => void }) {
  const c = r.custom!;
  return (
    <>
      <span className="sit-own-label">Your situation</span>
      <b className="sit-title">
        {c.title} {c.titleSource === 'ai' && <Tag kind="ai" />}
      </b>
      {c.text && <q className="own-quote">{c.text}</q>}
      <p className="sit-assume">
        {r.info.assumption(0)} <span className="sit-origin">{c.partsEdited ? 'your values' : 'starting guesses'} <Tag kind="est" /></span>
      </p>
      <span className="sit-own-actions">
        <button type="button" className="own-link" onClick={onEdit} aria-label={`Change ${c.title}`}>
          Change
        </button>
        <button type="button" className="own-link" onClick={onRemove} aria-label={`Remove ${c.title}`}>
          Remove
        </button>
      </span>
    </>
  );
}

// ---------- Results screen section ----------

export function SituationsSection({ prepared, base, tasks }: { prepared: PreparedArea; base: DrillRun; tasks: Task[] }) {
  const { state, dispatch } = useApp();
  const sit = state.situations;
  const results = useSituationResults(prepared, base, tasks);
  const [edit, setEdit] = useState<OwnEdit | null>(null);
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
              const c = r.custom;
              return (
                <tr key={rowKey(r)} className={`sit-row sit-tone-${w.tone}${c ? ' sit-own' : ''}`}>
                  <td className="sit-what">
                    {c ? (
                      <OwnWhat
                        r={r}
                        onEdit={() => setEdit({ id: c.id, draft: draftOf(c) })}
                        onRemove={() => {
                          if (edit?.id === c.id) setEdit(null);
                          dispatch({ type: 'custom/remove', id: c.id });
                        }}
                      />
                    ) : (
                      <>
                        <b className="sit-title">{r.info.title}</b>
                        <Assumption r={r} edited={sit.editedParams[r.spec.kind] !== undefined} onParam={onParam} />
                        {r.spec.reason && (
                          <p className="sit-reason">
                            <span className="sit-reason-label">Why this one:</span> <i>{r.spec.reason}</i> <Tag kind="ai" />
                          </p>
                        )}
                      </>
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
      <OwnSituation prepared={prepared} base={base} tasks={tasks} edit={edit && state.customSituations.some((c) => c.id === edit.id) ? edit : null} onEdit={setEdit} />
    </section>
  );
}

// ---------- Fix screen: before and after counts ----------

/** Situations run on the run after changes: fixed tasks, and the swapped routes when the user switched. */
function afterResults(
  s: Pick<AppState, 'prepared' | 'after' | 'fixes' | 'household'>,
  specs: SituationSpec[],
  custom: CustomSituation[],
): SituationResult[] | null {
  if (!s.prepared || !s.after || !hasFixes(s.fixes)) return null;
  const prepared = s.fixes.switchMainRoute ? { ...s.prepared, waysOut: swappedWaysOut(s.prepared.waysOut) } : s.prepared;
  const tasks = fixedTasks(s.household.tasks, s.fixes);
  // A typed task change follows a Fix to the same task (rebased), so the Fix is measured on that row too.
  return [...safeRunSituations(prepared, s.after, tasks, specs), ...safeRunCustom(prepared, s.after, tasks, rebaseCustom(custom, s.household.tasks, tasks))];
}

/** Catalog rows then the user's own, on the base drill. */
function beforeResults(s: Pick<AppState, 'prepared' | 'before' | 'household'>, specs: SituationSpec[], custom: CustomSituation[]): SituationResult[] {
  return [...safeRunSituations(s.prepared, s.before, s.household.tasks, specs), ...safeRunCustom(s.prepared, s.before, s.household.tasks, custom)];
}

/** Fix screen line: how many situations hold before and after the changes, and what still fails. */
export function FixSituations() {
  const { state } = useApp();
  const { prepared, before: base, after: run, fixes, household, situations, customSituations: custom } = state;
  const specs = useMemo(() => effectiveSpecs(situations), [situations]);
  const before = useMemo(() => beforeResults({ prepared, before: base, household }, specs, custom), [prepared, base, household, specs, custom]);
  const after = useMemo(() => afterResults({ prepared, after: run, fixes, household }, specs, custom), [prepared, run, fixes, household, specs, custom]);
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
              <li key={rowKey(r)}>
                <Icon name={w.icon} />
                <span>
                  <b>{r.custom ? `Your situation, ${r.info.title}` : r.info.title}:</b> {w.text}.
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
  const { prepared, before, after, fixes, household, situations, customSituations: custom } = state;
  const specs = useMemo(() => effectiveSpecs(situations), [situations]);
  const results = useMemo(() => {
    const changed = after && hasFixes(fixes);
    if (!changed) return beforeResults({ prepared, before, household }, specs, custom);
    return afterResults({ prepared, after, fixes, household }, specs, custom) ?? [];
  }, [prepared, before, after, fixes, household, specs, custom]);
  if (situations.status === 'idle' || results.length === 0) return null;
  const { pass, total } = passCount(results);
  return (
    <>
      <p>
        Your plan{after && hasFixes(fixes) ? ', with your changes,' : ''} holds in <b>{pass} of {total}</b> harder days we tested on the same simulated fire. <Tag kind="calc" />
      </p>
      <SituationsPlanList results={results} />
      <p className="small muted">
        These are hard cases, picked on purpose{situations.source === 'ai' ? ' by AI' : ' by fixed rules'} to find weak spots
        {custom.length > 0 ? ', plus the ones you described' : ''}. The value in each "If" is a starting guess. Times are calculated.
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
          <li key={rowKey(r)} className={`plan-result is-${w.tone === 'short' ? 'short' : w.tone === 'spare' ? 'spare' : 'plain'}`}>
            <Icon name={w.icon} />
            <span>
              <b>{r.custom ? `Your situation: ${r.info.title}` : r.info.title}.</b> If: {r.info.assumption(r.spec.param)} <Tag kind="est" />{' '}
              Result: you leave home at {fmtT(r.departMin)}. <b>{w.text}.</b> <Tag kind="calc" />
              {r.nextAction && <> Next: {r.nextAction.text}.</>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
