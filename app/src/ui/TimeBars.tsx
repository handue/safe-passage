// Time bars: where the minutes go, on one shared minute axis, with the road closure marked.
// Segments: prep tasks (slate), the slowest task (hatched), fixed tasks (outlined), drive (cyan).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '../engine/types';
import { fmtMin, fmtT } from './Tag';
import { minShort } from './units';
import '../styles/results.css';

export interface TimeBar {
  /** Row name, e.g. "Before". Omit for a single bar. */
  name?: string;
  tasks: Task[];
  /** Night wake-up minutes added before the tasks (0 by day). */
  wakeMin: number;
  /** Task ids the user changed; drawn outlined. */
  fixedIds?: string[];
  /** Drive from home to the end point (the binding closure point, or the destination). */
  driveMin: number;
  /** Road where the closure line sits for this bar; null when the fire never closed the route. */
  closeRoad: string | null;
  closeMin: number | null;
}

type Kind = 'prep' | 'slow' | 'fixed' | 'drive';
interface Seg { kind: Kind; short: string; word: string; min: number; left: number }

const SHORT: Record<string, [string, string]> = {
  gather: ['Gather', 'gather'],
  help: ['Help', 'help'],
  pets: ['Pets', 'pets'],
  meds: ['Meds', 'medications'],
  docs: ['Docs', 'documents'],
  load: ['Load', 'load'],
  ride: ['Ride', 'reach a ride'],
};

function names(t: Task): [string, string] {
  if (SHORT[t.id]) return SHORT[t.id];
  const first = t.label.split(/[\s,]+/)[0] || 'Task';
  return [first, first.toLowerCase()];
}

function segments(bar: TimeBar): { segs: Seg[]; end: number } {
  const fixed = new Set(bar.fixedIds ?? []);
  let slowId: string | null = null;
  let slowMin = 0;
  for (const t of bar.tasks) {
    if (!fixed.has(t.id) && t.minutes > slowMin) {
      slowMin = t.minutes;
      slowId = t.id;
    }
  }
  const segs: Seg[] = [];
  let t = 0;
  const push = (kind: Kind, short: string, word: string, min: number) => {
    if (min <= 0) return;
    segs.push({ kind, short, word, min, left: t });
    t += min;
  };
  push('prep', 'Wake', 'wake up', bar.wakeMin);
  for (const task of bar.tasks) {
    const [short, word] = names(task);
    push(fixed.has(task.id) ? 'fixed' : task.id === slowId ? 'slow' : 'prep', short, word, task.minutes);
  }
  push('drive', 'Drive', 'drive', bar.driveMin);
  return { segs, end: t };
}

/** Whole minutes; a sliver under half a minute reads "<1", not "0". */
const segMin = (min: number) => (min > 0 && min < 0.5 ? '<1' : fmtMin(min));
const pct = (min: number, axis: number) => `${((min / axis) * 100).toFixed(2)}%`;
/** Share of the axis a segment needs to show its name; and the on-screen width it needs for
 * its name and for its number. Narrower segments rely on the written key under the bars. */
const NAME_FIT = 0.08;
const NAME_MIN_PX = 52;
const NUMBER_MIN_PX = 20;

/** "gather 5 min, drive 1 min (slowest)": each part carries its own unit, so "1 min" is never "1 minutes". */
export function keyText(segs: Pick<Seg, 'kind' | 'word' | 'min'>[]): string {
  return segs
    .map((s) => `${s.word} ${minShort(s.min)}${s.kind === 'slow' ? ' (slowest)' : s.kind === 'fixed' ? ' (changed)' : ''}`)
    .join(', ');
}

function Cut({ road, min, axis }: { road: string; min: number; axis: number }) {
  const left = (min / axis) * 100;
  return (
    <div className={`cut${left < 50 ? ' flip' : ''}`} style={{ left: `${left.toFixed(2)}%` }}>
      <b>{road} closes {fmtT(min)}</b>
    </div>
  );
}

/** `note` (optional) sits between the axis ends, e.g. provenance tags for the bars. */
/** Rendered width of the bar track in CSS pixels (null until measured). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.getBoundingClientRect().width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function TimeBars({ bars, note }: { bars: TimeBar[]; note?: ReactNode }) {
  const [trackRef, trackPx] = useWidth();
  const built = bars.map((b) => ({ bar: b, ...segments(b) }));
  const top = Math.max(...built.map((b) => Math.max(b.end, b.bar.closeMin ?? 0)), 1);
  const axis = Math.ceil(top) + 5;

  // One closure line across all bars when they share it; otherwise one per bar.
  const first = bars[0];
  const shared = bars.every((b) => b.closeRoad === first.closeRoad && b.closeMin === first.closeMin);

  // Before the first measure, assume a desktop-width track.
  const segPx = (min: number) => (min / axis) * (trackPx ?? 800);
  const showName = (s: Seg) => s.min / axis >= NAME_FIT && segPx(s.min) >= NAME_MIN_PX;
  // The drive segment is left-aligned with padding, so it needs a little more room.
  const showNumber = (s: Seg) => segPx(s.min) >= NUMBER_MIN_PX + (s.kind === 'drive' ? 8 : 0);
  const allNamed = built.every(({ segs }) => segs.every(showName));

  const summary = built
    .map(({ bar, segs, end }) => {
      const head = bar.name ? `${bar.name}: ` : '';
      const close =
        bar.closeRoad && bar.closeMin !== null
          ? ` ${bar.closeRoad} closes at minute ${fmtMin(bar.closeMin)}; this plan reaches that point at minute ${fmtMin(end)}.`
          : ` The fire did not close this route; total ${minShort(end)}.`;
      return `${head}${keyText(segs)}.${close}`;
    })
    .join(' ');

  return (
    <div className="stack-s">
      <div ref={trackRef} className={`timewrap${bars.length > 1 ? ' compare-bars' : ''}`} role="img" aria-label={summary}>
        {built.map(({ bar, segs }, i) => (
          <div key={i} className={shared ? undefined : 'tb-row'}>
            {bar.name && <b className="barname">{bar.name}</b>}
            <div className="bar">
              {segs.map((s, j) => (
                <span key={j} className={s.kind} style={{ left: pct(s.left, axis), width: pct(s.min, axis) }} title={`${s.short} ${segMin(s.min)} min`}>
                  {showName(s) && <em>{s.short} </em>}
                  {showNumber(s) && segMin(s.min)}
                </span>
              ))}
            </div>
            {!shared && bar.closeRoad && bar.closeMin !== null && <Cut road={bar.closeRoad} min={bar.closeMin} axis={axis} />}
          </div>
        ))}
        {shared && first.closeRoad && first.closeMin !== null && <Cut road={first.closeRoad} min={first.closeMin} axis={axis} />}
      </div>
      {/* The written key shows on narrow screens, and always when a segment is too small for its name. */}
      <p className={allNamed ? 'barkey keytext' : 'barkey'}>
        {built.map(({ bar, segs }) => `${bar.name ? `${bar.name}, in order` : 'In order'}: ${keyText(segs)}.`).join(' ')}
      </p>
      <div className="row between small muted">
        <span>T+0, order to leave</span>
        {note && <span className="tb-note">{note}</span>}
        <span>{fmtT(axis)}</span>
      </div>
    </div>
  );
}
