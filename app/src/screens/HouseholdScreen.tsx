// Screen 2: who is leaving, and the tasks before the car can go (the user's own minute estimates).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '../app/state';
import { go } from '../app/router';
import { defaultTasks, NIGHT_WAKE_MIN, tasksMinutes, type HouseholdCounts } from '../engine/drill';
import type { Household, Task } from '../engine/types';
import { Tag, fmtMin } from '../ui/Tag';
import { Icon } from '../ui/Icon';
import { TaskTimer } from './TaskTimer';
import '../styles/home.css';

const MAX_COUNT = 20;
const MAX_MINUTES = 240;

const COUNT_FIELDS: { key: keyof HouseholdCounts; label: string; hint?: string }[] = [
  { key: 'adults', label: 'Adults' },
  { key: 'children', label: 'Children' },
  { key: 'needHelpMoving', label: 'Need help moving' },
  { key: 'dogs', label: 'Dogs' },
  { key: 'catsAndSmallPets', label: 'Cats and small pets' },
  { key: 'cars', label: 'Cars you can use', hint: '0 adds a "reach a ride" task.' },
];

function countsOf(h: Household): HouseholdCounts {
  return { adults: h.adults, children: h.children, needHelpMoving: h.needHelpMoving, dogs: h.dogs, catsAndSmallPets: h.catsAndSmallPets, cars: h.cars };
}

function sameTasks(a: Task[], b: Task[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.label === b[i].label && t.minutes === b[i].minutes);
}

/** Whole number in [0, max], or null when the text is not one. */
function parseWhole(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/**
 * Number input that lets the user clear the box while typing.
 * It reports only valid whole numbers and shows the saved value again on blur.
 */
function WholeInput({ value, max, onValue, ...rest }: { value: number; max: number; onValue: (n: number) => void; id?: string; 'aria-label'?: string; 'aria-describedby'?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Follow outside changes (for example a reset) unless the box already shows that value.
    setText((t) => (parseWhole(t, max) === value ? t : String(value)));
  }, [value, max]);
  const bad = parseWhole(text, max) === null;
  return (
    <input
      {...rest}
      type="number"
      inputMode="numeric"
      min={0}
      max={max}
      step={1}
      value={text}
      aria-invalid={bad || undefined}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseWhole(e.target.value, max);
        if (n !== null) onValue(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

export function HouseholdScreen() {
  const { state, dispatch } = useApp();
  const h = state.household;
  const counts = countsOf(h);
  const suggested = defaultTasks(counts);
  const [countsEdited, setCountsEdited] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newMin, setNewMin] = useState('5');
  const [addError, setAddError] = useState('');
  const [timing, setTiming] = useState(false);
  const timerButton = useRef<HTMLButtonElement>(null);
  const ids = useId();

  const save = (next: Household) => dispatch({ type: 'household/set', household: next });
  const setCount = (key: keyof HouseholdCounts, n: number) => {
    if (h[key] === n) return;
    setCountsEdited(true);
    save({ ...h, [key]: n });
  };
  const setMinutes = (id: string, n: number) => {
    if (h.tasks.find((t) => t.id === id)?.minutes === n) return;
    // A typed number is an estimate again, even if the task was timed before.
    save({ ...h, tasks: h.tasks.map((t) => (t.id === id ? { ...t, minutes: n, source: 'estimate' } : t)) });
  };
  const setTimed = (id: string, n: number) => {
    save({ ...h, tasks: h.tasks.map((t) => (t.id === id ? { ...t, minutes: n, source: 'timed' } : t)) });
  };
  const openTimer = () => {
    setTiming(true);
    requestAnimationFrame(() => document.getElementById('timer-h')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const closeTimer = () => {
    setTiming(false);
    // Back to the button that opened it, so keyboard users keep their place.
    requestAnimationFrame(() => timerButton.current?.focus());
  };
  const removeTask = (id: string) => save({ ...h, tasks: h.tasks.filter((t) => t.id !== id) });
  const resetTasks = () => {
    save({ ...h, tasks: suggested });
    setCountsEdited(false);
  };
  const addTask = (e: FormEvent) => {
    e.preventDefault();
    const label = newLabel.trim();
    const minutes = parseWhole(newMin, MAX_MINUTES);
    if (!label) return setAddError('Name the task.');
    if (minutes === null) return setAddError(`Minutes must be a whole number from 0 to ${MAX_MINUTES}.`);
    let n = h.tasks.length + 1;
    while (h.tasks.some((t) => t.id === `custom-${n}`)) n++;
    save({ ...h, tasks: [...h.tasks, { id: `custom-${n}`, label, minutes, source: 'estimate' }] });
    setNewLabel('');
    setNewMin('5');
    setAddError('');
  };

  const total = tasksMinutes(h.tasks, 'day');
  const timedCount = h.tasks.filter((t) => t.source === 'timed').length;
  const night = tasksMinutes(h.tasks, 'night');
  const showReset = countsEdited && !sameTasks(h.tasks, suggested);
  const hasCustom = h.tasks.some((t) => t.id.startsWith('custom-'));

  return (
    <main className="split">
      <section className="stage home-stage" aria-labelledby={`${ids}-h1`}>
        <h1 id={`${ids}-h1`}>Who is leaving with you?</h1>
        <div className="cols3">
          {COUNT_FIELDS.map((f) => (
            <div className="stack-s" key={f.key}>
              <label htmlFor={`${ids}-${f.key}`}>{f.label}</label>
              <WholeInput id={`${ids}-${f.key}`} value={h[f.key]} max={MAX_COUNT} onValue={(n) => setCount(f.key, n)} aria-describedby={f.hint ? `${ids}-${f.key}-hint` : undefined} />
              {f.hint && <span className="small muted" id={`${ids}-${f.key}-hint`}>{f.hint}</span>}
            </div>
          ))}
        </div>

        <div className="stack-s">
          <h2>Getting ready to leave</h2>
          <p className="muted">Starting guesses based on your household. Change any of them to match your home. Tasks are counted one after another.</p>

          {showReset && (
            <div className="box row home-reset" role="status">
              <Icon name="clock" />
              <div className="grow">
                <b>Your household changed.</b>
                <div className="muted">
                  Suggested times for it add up to {fmtMin(tasksMinutes(suggested, 'day'))} min.
                  {hasCustom ? ' Resetting also removes tasks you added.' : ''} Your current minutes stay until you choose.
                </div>
              </div>
              <button type="button" onClick={resetTasks}>Reset tasks to suggested times</button>
            </div>
          )}

          {timing && <TaskTimer tasks={h.tasks} onTimed={setTimed} onClose={closeTimer} />}

          <table className="home-tasks">
            <thead>
              <tr>
                <th>Task</th>
                <th className="home-col-min">Minutes</th>
                <th className="home-col-src">Source</th>
                <th className="home-col-x"><span className="home-vh">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {h.tasks.length === 0 && (
                <tr><td colSpan={4} className="muted">No tasks yet. Add the things you do before the car can leave.</td></tr>
              )}
              {h.tasks.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td><WholeInput value={t.minutes} max={MAX_MINUTES} onValue={(n) => setMinutes(t.id, n)} aria-label={`Minutes: ${t.label}`} /></td>
                  <td><Tag kind={t.source === 'timed' ? 'timed' : 'est'} /></td>
                  <td><button type="button" className="home-remove" onClick={() => removeTask(t.id)} aria-label={`Remove task: ${t.label}`}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>

          <form className="home-add" onSubmit={addTask} noValidate aria-label="Add a task">
            <div className="stack-s grow">
              <label htmlFor={`${ids}-new-label`}>New task</label>
              <input id={`${ids}-new-label`} type="text" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="For example: Close windows" maxLength={60} aria-describedby={addError ? `${ids}-add-hint ${ids}-add-err` : `${ids}-add-hint`} />
            </div>
            <div className="stack-s home-col-min">
              <label htmlFor={`${ids}-new-min`}>Minutes</label>
              <input id={`${ids}-new-min`} type="number" inputMode="numeric" min={0} max={MAX_MINUTES} step={1} value={newMin} onChange={(e) => setNewMin(e.target.value)} />
            </div>
            <button type="submit">Add a task</button>
          </form>
          <p className="small muted" id={`${ids}-add-hint`}>No names needed. Tasks you add stay in this browser: the plan writer only gets "Another task" and its minutes.</p>
          {addError && <p className="small home-error" id={`${ids}-add-err`} role="alert"><Icon name="warn" className="icon home-inline-icon" /> {addError}</p>}
        </div>
      </section>

      <aside className="side" aria-label="Time to get out the door">
        <div className="stack-s">
          <h2>Time to get out the door</h2>
          <div className="hero">{fmtMin(total)}<small>min</small></div>
          <p className="muted">Sum of your tasks. <Tag kind="calc" /></p>
        </div>
        <p className="muted">At night, waking everyone adds {NIGHT_WAKE_MIN} min (a fixed app default): {fmtMin(night)} min in all. <Tag kind="calc" /></p>
        <div className="stack-s">
          <p>
            {h.tasks.length === 0
              ? 'No tasks yet. Add a task to time it.'
              : timedCount === 0
              ? 'These minutes are guesses. Time each task once at home, with the stopwatch, to use real minutes.'
              : timedCount === h.tasks.length
                ? `All ${h.tasks.length} tasks timed.`
                : `${timedCount} of ${h.tasks.length} tasks timed; the rest are estimates.`}
          </p>
          {!timing && h.tasks.length > 0 && (
            <button type="button" ref={timerButton} onClick={openTimer}><Icon name="clock" /> Time it for real</button>
          )}
        </div>
        <button type="button" className="primary" onClick={() => go('map')}>Show my home map</button>
        <a href="#/address">Back to address</a>
      </aside>
    </main>
  );
}
