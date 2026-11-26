// "Time it for real": a stopwatch that walks the household through its tasks one by one and
// replaces each estimate with the minutes it really took. Nothing is sent anywhere.
import { useEffect, useRef, useState } from 'react';
import type { Task } from '../engine/types';
import { Icon } from '../ui/Icon';
import { clockText, timedMinutes } from '../ui/clock';


type Phase = { kind: 'ready' } | { kind: 'running'; index: number; startedAt: number } | { kind: 'done' };

export function TaskTimer({ tasks, onTimed, onClose }: { tasks: Task[]; onTimed: (id: string, minutes: number) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const [now, setNow] = useState(() => Date.now());
  const [log, setLog] = useState<{ id: string; label: string; text: string; saved: boolean }[]>([]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // The task list is fixed while timing, so a minute change does not move the walk-through.
  const [list] = useState(tasks);
  const running = phase.kind === 'running';

  // Keyboard focus follows the walk-through: the heading on open, Done while timing, Close at the end.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (phase.kind === 'done') closeRef.current?.focus();
    else if (phase.kind === 'running') doneRef.current?.focus();
  }, [phase.kind]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  const start = () => {
    const t = Date.now();
    setNow(t);
    setPhase(list.length > 0 ? { kind: 'running', index: 0, startedAt: t } : { kind: 'done' });
  };
  const next = (index: number) => {
    const t = Date.now();
    setNow(t);
    setPhase(index + 1 < list.length ? { kind: 'running', index: index + 1, startedAt: t } : { kind: 'done' });
  };
  const finish = () => {
    if (phase.kind !== 'running') return;
    const task = list[phase.index];
    const seconds = (Date.now() - phase.startedAt) / 1000;
    // The table stays editable while timing; a task removed meanwhile is not saved anywhere.
    if (!tasks.some((t) => t.id === task.id)) {
      setLog((l) => [...l, { id: task.id, label: task.label, text: `${clockText(seconds)}, not saved (task was removed)`, saved: false }]);
      next(phase.index);
      return;
    }
    const minutes = timedMinutes(seconds);
    onTimed(task.id, minutes);
    setLog((l) => [...l, { id: task.id, label: task.label, text: `${clockText(seconds)}, saved as ${minutes} min`, saved: true }]);
    next(phase.index);
  };
  const skip = () => {
    if (phase.kind !== 'running') return;
    const task = list[phase.index];
    const live = tasks.find((t) => t.id === task.id);
    const kept = !live ? 'skipped (task was removed)' : live.source === 'timed' ? 'skipped, timed value kept' : 'skipped, estimate kept';
    setLog((l) => [...l, { id: task.id, label: task.label, text: kept, saved: false }]);
    next(phase.index);
  };

  const current = phase.kind === 'running' ? list[phase.index] : null;
  const live = current ? tasks.find((t) => t.id === current.id) : undefined;
  const savedCount = log.filter((l) => l.saved).length;
  const elapsed = phase.kind === 'running' ? (now - phase.startedAt) / 1000 : 0;

  return (
    <section className="box timer" aria-labelledby="timer-h">
      <div className="row between">
        <h2 id="timer-h" ref={headingRef} tabIndex={-1}>Time it for real</h2>
        <button type="button" ref={closeRef} onClick={onClose}>{phase.kind === 'done' ? 'Close' : 'Stop timing'}</button>
      </div>
      {phase.kind === 'ready' && (
        <>
          <p>
            Do each task for real, or walk through it at full speed, one after another. Press <b>Done</b> when a task is finished and the next one starts at once.
            Each time is saved to the nearest minute and marked as timed.
          </p>
          <button type="button" className="primary" onClick={start} disabled={list.length === 0}>
            Start with: {list[0]?.label ?? 'no tasks'}
          </button>
        </>
      )}
      {current && (
        <div className="timer-now">
          <p className="small muted">Task {phase.kind === 'running' ? phase.index + 1 : 0} of {list.length}</p>
          <p className="timer-task"><b>{current.label}</b> <span className="muted">{!live ? '(removed from the list)' : live.source === 'timed' ? `(timed before: ${live.minutes} min)` : `(your estimate: ${live.minutes} min)`}</span></p>
          <div className="timer-clock" role="timer" aria-label={`Time on this task: ${clockText(elapsed)}`}>{clockText(elapsed)}</div>
          <div className="row">
            <button type="button" className="primary" ref={doneRef} onClick={finish}>Done{phase.kind === 'running' && phase.index + 1 < list.length ? ', next task' : ''}</button>
            <button type="button" onClick={skip}>Skip this task</button>
          </div>
        </div>
      )}
      {phase.kind === 'done' && (
        <p role="status">
          <Icon name="check" />{' '}
          {savedCount === 0
            ? 'Timing finished. No tasks were timed, so your minutes are unchanged.'
            : `Timing finished. ${savedCount} of ${list.length} tasks now use your timed minutes, in the table below.`}
        </p>
      )}
      {log.length > 0 && (
        <ul className="list timer-log" aria-label="Timed so far" aria-live="polite">
          {log.map((l) => (
            <li key={l.id}><div className="grow">{l.label}</div><div className="val">{l.text}</div></li>
          ))}
        </ul>
      )}
    </section>
  );
}
