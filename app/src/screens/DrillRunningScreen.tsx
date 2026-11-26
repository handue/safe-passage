// Screen 5: the practice fire plays out minute by minute against the household's plan.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app/state';
import { go } from '../app/router';
import { MapView } from '../ui/MapView';
import { Icon } from '../ui/Icon';
import { Tag, TaskTags, fmtT } from '../ui/Tag';
import { NIGHT_WAKE_MIN, destTitle, displayDiffMin, displayMin } from '../engine/drill';
import type { XY } from '../engine/types';
import { fmtSpeed, localizeKm, unitsFor } from '../ui/units';
import { wayOutName } from './ResultsScreen';
import '../styles/drill.css';

/** 1.2 s of real time per 10 simulated minutes at 1x. */
const MIN_PER_SEC = 10 / 1.2;
const SPEEDS = [1, 2, 4];
const COMPASS_ABBR = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const abbr = (deg: number) => COMPASS_ABBR[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const sameXY = (a: XY, b: XY) => a.x === b.x && a.y === b.y;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Minutes left until a moment, counted from its shown T+ value (the engine's displayMin), so the
 * countdown and the T+ label always agree. Never 0 while the moment has not come.
 */
export function minutesUntil(momentMin: number, minute: number): number {
  return Math.max(1, displayMin(momentMin) - minute);
}

/** The moment has come once the clock reaches its shown T+ value. */
export const reached = (momentMin: number, minute: number) => minute >= displayMin(momentMin);

/** Verdict words from rounded T+ values, the same rule as the results screen. */
export function shortBy(passMin: number, closeMin: number): string {
  const m = displayDiffMin(passMin, closeMin);
  return m < 1 ? 'Under 1 min short on this plan' : `${m} min short on this plan`;
}
export function spare(closeMin: number, passMin: number): string {
  const m = displayDiffMin(closeMin, passMin);
  return m < 1 ? 'Under 1 min to spare' : `${m} min to spare`;
}

const NARROW_QUERY = '(max-width: 900px)';

/** True on narrow screens, where the hero numbers move above the map. */
function useNarrow(): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function StateBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="narrow">
      <div className="state-box">
        <h1><Icon name="warn" />{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function DrillRunningScreen() {
  const { state } = useApp();
  const run = state.before;
  const prepared = state.prepared;
  const horizon = run?.fire.horizonMin ?? 0;
  const [reduced] = useState(prefersReducedMotion);
  const narrow = useNarrow();

  const [minute, setMinute] = useState(0);
  const [playing, setPlaying] = useState(!reduced);
  const [speedIdx, setSpeedIdx] = useState(0);
  const tRef = useRef(0); // precise simulated minute while playing
  const listRef = useRef<HTMLUListElement>(null);

  const animate = !!run && run.coverage.ignitionInGrid;

  useEffect(() => {
    if (!playing || !animate) return;
    let raf = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      if (last !== null) {
        tRef.current = Math.min(horizon, tRef.current + ((now - last) / 1000) * MIN_PER_SEC * SPEEDS[speedIdx]);
        const m = Math.floor(tRef.current);
        setMinute((prev) => (prev === m ? prev : m));
        if (tRef.current >= horizon) {
          setPlaying(false);
          return;
        }
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, animate, horizon, speedIdx]);

  // Keep the current household row in sight when the list scrolls inside a short side panel.
  // Only the list scrolls (never the page), and without smooth scrolling.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('li.now');
    if (!list || !row || list.scrollHeight <= list.clientHeight) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
  });

  if (!run || !prepared) {
    return (
      <StateBox title="No drill to show yet">
        <p>Choose a practice fire first.</p>
        <div><button type="button" className="primary" onClick={() => go('setup')}>Back to setup</button></div>
      </StateBox>
    );
  }

  if (!run.coverage.ignitionInGrid) {
    return (
      <StateBox title="This fire starts outside the model's area">
        <p>The practice fire starts outside the area the fire model covers, so nothing was simulated. Pick a point closer to home.</p>
        <div><button type="button" className="primary" onClick={() => go('setup')}>Back to setup</button></div>
      </StateBox>
    );
  }

  const seek = (m: number) => {
    const v = Math.max(0, Math.min(horizon, Math.round(m)));
    tRef.current = v;
    setMinute(v);
  };
  const togglePlay = () => {
    if (playing) {
      tRef.current = minute;
      setPlaying(false);
      return;
    }
    if (minute >= horizon) seek(0);
    else tRef.current = minute;
    setPlaying(true);
  };
  const step = () => {
    setPlaying(false);
    seek(minute + 1);
  };

  const { setup, main } = run;
  const binding = main?.binding ?? null;
  const graph = prepared.graph;

  // Chip: which fire, wind, day or night.
  const sIdx = state.suggestions.findIndex((s) => sameXY(s.xy, setup.ignition));
  const units = unitsFor(state.area?.country);
  const igLabel = sIdx >= 0 ? `Ignition ${sIdx + 1}, ${localizeKm(state.suggestions[sIdx].label, units)}` : 'Your ignition point';
  const chip = `${igLabel} · Wind ${abbr(setup.wind.fromDeg)} ${fmtSpeed(setup.wind.speedMph, units)} · ${setup.start === 'night' ? 'Night' : 'Day'}`;

  // Household timeline: tasks one after another, then the drive.
  const tasks = [
    ...(setup.start === 'night' ? [{ id: 'wake', label: 'Wake everyone up', minutes: NIGHT_WAKE_MIN }] : []),
    ...state.household.tasks,
  ];
  let acc = 0;
  const timeline = tasks.map((t) => {
    const startMin = acc;
    acc += t.minutes;
    return { ...t, startMin, endMin: acc };
  });
  const departMin = main?.departMin ?? run.tasksMin;

  const unmodeledNames = [...new Set(run.coverage.mainUnmodeledEdgeIds.map((id) => graph.edges[id].name))];
  const destination = main ? prepared.waysOut.destinations.find((d) => d.id === main.route.destinationId) : undefined;

  const closed = binding ? reached(binding.closeMin, minute) : false;
  const past = binding ? reached(binding.passMin, minute) : false;
  // The drive ends at the closed road when the plan is short, else at the destination.
  const blocked = main?.outcome === 'short' && binding !== null;
  const driveEnd = main ? (blocked && binding ? binding.passMin : main.arriveMin) : 0;
  const destName = destination ? destTitle(destination) : 'the destination';
  const destFire = main?.destinationFire ?? null;
  const destFireShown = !!destFire && destFire.inGrid && Number.isFinite(destFire.fireMin) && reached(destFire.fireMin, minute);
  const hours = Math.round((horizon / 60) * 10) / 10;
  const routeName = main ? wayOutName(prepared.waysOut, main.route) : null;
  const demoChip = state.isDemo ? <p className="run-demo"><span className="chip">Demo address</span></p> : null;

  // The two hero numbers. On narrow screens they sit above the map, so the fire and Play come next.
  const heroes =
    main && binding ? (
      <div className="run-heroes-top">
        {demoChip}
        <div className="stack-s">
          <h2>{closed ? `${binding.name} closed at` : `${binding.name} closes in`}</h2>
          <div className="hero is-fire">
            {closed ? fmtT(binding.closeMin) : <>{minutesUntil(binding.closeMin, minute)}<small>min</small></>}
          </div>
        </div>
        <div className="stack-s">
          {/* Once the road has closed, both heroes read as clock times, never a countdown to a closed road. */}
          <h2>{past ? (main.outcome === 'short' ? 'You would reach it at' : 'Past it at') : closed ? 'You would reach it at' : 'You need to get past it'}</h2>
          <div className="hero">
            {past || closed ? fmtT(binding.passMin) : <>{minutesUntil(binding.passMin, minute)}<small>min</small></>}
          </div>
        </div>
        {main.outcome === 'short' ? (
          <p className="verdict is-short callout"><Icon name="warn" />{shortBy(binding.passMin, binding.closeMin)}</p>
        ) : (
          <p className="verdict is-spare"><Icon name="check" />{spare(binding.closeMin, binding.passMin)}</p>
        )}
        <p className="small muted">Both times <Tag kind="calc" /> from the fire model, {routeName ?? 'the route'} and your task minutes.</p>
      </div>
    ) : null;

  return (
    <main className="split wide-side running">
      <section className="stage">
        <div className="row between">
          <h1>Practice fire, {fmtT(minute)} min</h1>
          <span className="chip">{chip}</span>
        </div>
        {narrow && heroes}
        <MapView
          prepared={prepared}
          routes={main ? [{ which: 'main', style: 'main', label: 'Way out A' }] : []}
          fire={{ run, minute }}
          closure={binding ? { xy: binding.xy, label: closed ? `${binding.name} closed ${fmtT(binding.closeMin)}` : `${binding.name} closes ${fmtT(binding.closeMin)}` } : null}
          wind={setup.wind}
          units={units}
          ariaLabel={`Map of the practice fire at ${fmtT(minute)} minutes${binding ? `. ${binding.name} closes at ${fmtT(binding.closeMin)}` : ''}.`}
        />
        <div className="legend">
          <span><i style={{ background: 'var(--fire)' }}></i>Simulated fire (cells; bright edge, hatched burned area)</span>
          {main && <span><i style={{ background: 'var(--route)', borderColor: 'var(--route)', height: 5, verticalAlign: 2 }}></i>Your route, {routeName} (solid)</span>}
        </div>
        <div className="play-row">
          <button type="button" onClick={togglePlay}>{playing ? 'Pause' : minute >= horizon ? 'Replay' : 'Play'}</button>
          <button type="button" onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)} aria-label={`Speed ${SPEEDS[speedIdx]} times. Change speed`}>
            Speed {SPEEDS[speedIdx]}×
          </button>
          <button type="button" onClick={step} disabled={minute >= horizon}>Step 1 min</button>
          <input
            type="range"
            min={0}
            max={horizon}
            step={1}
            value={minute}
            aria-label="Drill time in minutes"
            aria-valuetext={`${fmtT(minute)} minutes`}
            onChange={(e) => {
              setPlaying(false);
              seek(Number(e.target.value));
            }}
          />
        </div>
        {reduced && minute === 0 && !playing && <p className="small muted">Reduced motion is on, so the drill starts paused. Use Step or the time slider, or press Play.</p>}
      </section>

      <aside className="side">
        {!main ? (
          <div className="stack-s">
            {demoChip}
            <h2>No way out found on mapped roads</h2>
            <p className="verdict is-short callout"><Icon name="closed" />No route to time on this plan</p>
            <p className="small muted">The road data around home did not connect to a candidate destination. The fire is still shown on the map.</p>
          </div>
        ) : !binding ? (
          <div className="stack-s">
            {demoChip}
            <h2>Your way out</h2>
            <p className="verdict plain"><Icon name="check" />This fire did not close your way out in {hours} hours</p>
            <p className="small muted">Result <Tag kind="calc" /> from the fire model and the route. Try a fire that starts somewhere else or with stronger wind.</p>
            <div><button type="button" onClick={() => go('setup')}>Try another fire</button></div>
          </div>
        ) : (
          !narrow && heroes
        )}

        {unmodeledNames.length > 0 && (
          <p className="drill-note"><Icon name="warn" />Part of your route ({unmodeledNames.join(', ')}) runs outside the fire model's area. Closures there are not modeled.</p>
        )}
        {state.area && state.area.fallbacksUsed.length > 0 && (
          <ul className="drill-notes" aria-label="Data notes">
            {state.area.fallbacksUsed.map((n) => <li key={n} className="drill-note"><Icon name="warn" />{n}</li>)}
          </ul>
        )}

        <div className="household-now">
          <h3>Your household now <TaskTags tasks={state.household.tasks} /></h3>
          <ul className="list" ref={listRef}>
            {timeline.map((t) => {
              const done = minute >= t.endMin;
              const now = !done && minute >= t.startMin;
              return (
                <li key={t.id} className={done ? 'done' : now ? 'now' : undefined}>
                  <Icon name={done ? 'check' : now ? 'clock' : 'pending'} />
                  <div className="grow">{now ? <b>{t.label} (now)</b> : t.label}</div>
                  <div className={`val${done ? ' muted' : ''}`}>{done ? 'done' : now ? `${minutesUntil(t.endMin, minute)} min left` : `${t.minutes} min`}</div>
                </li>
              );
            })}
            {main && minute >= departMin && minute < driveEnd && (
              <li className="now">
                <Icon name="clock" />
                <div className="grow"><b>Driving (now)</b></div>
                <div className="val">left home {fmtT(departMin)}</div>
              </li>
            )}
            {main && minute >= driveEnd && minute >= departMin && (
              blocked && binding ? (
                <li className="done">
                  <Icon name="closed" />
                  <div className="grow">Reached {binding.name} after it closed</div>
                  <div className="val muted">{fmtT(binding.passMin)}</div>
                </li>
              ) : (
                <li className="done">
                  <Icon name="check" />
                  <div className="grow">Arrived at {destName}</div>
                  <div className="val muted">{fmtT(main.arriveMin)}</div>
                </li>
              )
            )}
            {main && destFireShown && destFire && (
              <li className="done">
                <Icon name="warn" />
                <div className="grow">Fire reaches {destName} <Tag kind="calc" /></div>
                <div className="val muted">{fmtT(destFire.fireMin)}</div>
              </li>
            )}
          </ul>
        </div>

        <button type="button" className="primary" onClick={() => go('results')}>Skip to results</button>
      </aside>
    </main>
  );
}
