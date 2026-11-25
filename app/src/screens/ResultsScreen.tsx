// Screen 6: drill results. Every number here comes from the drill run in state (CALCULATED)
// or from the household's task minutes (YOUR ESTIMATE).
import type { MouseEvent, ReactNode } from 'react';
import { useApp, windSourceWord } from '../app/state';
import { go, type ScreenId } from '../app/router';
import type { DrillRun } from '../engine/drill';
import type { PreparedArea } from '../engine/area';
import type { AreaData, Bottleneck, Route, RouteRun, Task, Wind, WaysOut } from '../engine/types';
import { NIGHT_WAKE_MIN, destTitle, displayDiffMin } from '../engine/drill';
import { compassName } from '../engine/geo';
import { UNNAMED_ROAD } from '../engine/graph';
import { Icon, type IconName } from '../ui/Icon';
import { Tag, fmtMin, fmtT } from '../ui/Tag';
import { MapView } from '../ui/MapView';
import { TimeBars, type TimeBar } from '../ui/TimeBars';
import { fmtSpeed, fmtSquare, localizeMiles, minLong, unitsFor, type Units } from '../ui/units';
import '../styles/results.css';

// ---------- Helpers shared with the Fix screen ----------

/** Link that navigates with go() so the page scrolls to top. */
export function NavLink({ to, primary, children }: { to: ScreenId; primary?: boolean; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    go(to);
  };
  return (
    <a className={primary ? 'btn primary' : undefined} href={`#/${to}`} onClick={onClick}>
      {children}
    </a>
  );
}

export function DemoChip({ show }: { show: boolean }) {
  return show ? <span className="chip">Demo address</span> : null;
}

/** "Wind from northeast 25 mph": the same compass word as the map label and the plan. */
export function windText(w: Wind, capital = false, units: Units = 'mi'): string {
  const dir = compassName(w.fromDeg);
  return `${capital ? 'W' : 'w'}ind from ${dir} ${fmtSpeed(w.speedMph, units)}`;
}

/** Verdict for one route run, from rounded T+ values so the words match the numbers shown. */
export function verdictOf(run: RouteRun): { kind: 'short' | 'spare' | 'open'; n: number; text: string; shortText: string } {
  const b = run.binding;
  if (!b) {
    const n = Math.round(run.arriveMin);
    return { kind: 'open', n, text: 'not closed by this fire', shortText: 'Not closed by this fire' };
  }
  const n = run.outcome === 'short' ? displayDiffMin(b.passMin, b.closeMin) : displayDiffMin(b.closeMin, b.passMin);
  const what = run.outcome === 'short' ? 'short' : 'to spare';
  return n <= 0
    ? { kind: run.outcome === 'short' ? 'short' : 'spare', n: 0, text: `under 1 minute ${what}`, shortText: `Under 1 min ${what}` }
    : { kind: run.outcome === 'short' ? 'short' : 'spare', n, text: `${minLong(n)} ${what}`, shortText: `${n} min ${what}` };
}

// ---------- One name per way out, the same on every screen ----------

/** The first named road on this route that the other route does not use; else its last named road. */
export function distinctiveRoad(route: Route, other: Route | null): string {
  const named = route.roadNames.filter((n) => n !== UNNAMED_ROAD);
  const own = named.find((n) => !other || !other.roadNames.includes(n));
  return own ?? named[named.length - 1] ?? 'unnamed roads';
}

const sameRoute = (a: Route | null, b: Route) =>
  !!a && a.destinationId === b.destinationId && a.edgeIds.length === b.edgeIds.length && a.edgeIds.every((id, i) => id === b.edgeIds[i]);

/** "A" for the main way out found for this address, "B" for the second. */
export function wayOutKey(ways: Pick<WaysOut, 'main' | 'backup'>, route: Route): 'A' | 'B' | null {
  if (sameRoute(ways.main, route)) return 'A';
  if (sameRoute(ways.backup, route)) return 'B';
  return null;
}

/** "Way out A via Skyway": computed from the address's two ways out, so a route keeps its name on every screen. */
export function wayOutName(ways: Pick<WaysOut, 'main' | 'backup'>, route: Route): string {
  const key = wayOutKey(ways, route);
  const other = key === 'A' ? ways.backup : key === 'B' ? ways.main : null;
  return `${key ? `Way out ${key}` : 'Route'} via ${distinctiveRoad(route, other)}`;
}

/** Minute the household reaches the end of its bar: the binding point, or the destination if nothing closed. */
export function endMin(run: RouteRun): number {
  return run.binding ? run.binding.passMin : run.arriveMin;
}


export function destLabel(prepared: PreparedArea, destinationId: string): string {
  const d = prepared.waysOut.destinations.find((x) => x.id === destinationId);
  return d ? destTitle(d) : 'the destination';
}

/** The time bar for one run's main route. */
export function barFor(run: DrillRun, tasks: Task[], name?: string, fixedIds?: string[]): TimeBar | null {
  const main = run.main;
  if (!main) return null;
  return {
    name,
    tasks,
    wakeMin: run.setup.start === 'night' ? NIGHT_WAKE_MIN : 0,
    fixedIds,
    driveMin: Math.max(0, endMin(main) - main.departMin),
    closeRoad: main.binding?.name ?? null,
    closeMin: main.binding?.closeMin ?? null,
  };
}

function distinctNames(prepared: PreparedArea, edgeIds: number[]): string[] {
  return [...new Set(edgeIds.map((id) => prepared.graph.edges[id]?.name ?? 'Unnamed road'))];
}

/** Notes on what this drill could not model: fallbacks, flat ground, hand-set wind, legs outside the fire area. */
export function ModelNotes({ run, area, prepared, which = 'main' }: { run: DrillRun; area: AreaData; prepared: PreparedArea; which?: 'main' | 'both' }) {
  const units = unitsFor(area.country);
  const notes: string[] = [...area.fallbacksUsed];
  if (area.elevation === null && !notes.some((n) => /elevation|flat/i.test(n))) notes.push('No elevation data: the fire spreads as if the ground is flat.');
  if (run.setup.wind.source === 'manual' && area.wind === null && !notes.some((n) => /wind/i.test(n))) notes.push('No wind forecast: you set the wind by hand.');
  const square = fmtSquare(prepared.fireGrid.size * prepared.fireGrid.cellM, units);
  const mainOut = run.coverage.mainUnmodeledEdgeIds;
  if (mainOut.length > 0) {
    const name = run.main ? `, ${wayOutName(prepared.waysOut, run.main.route).replace(/^Way out/, 'way out')},` : '';
    notes.push(`Part of your main route${name} runs outside the ${square} fire area (${distinctNames(prepared, mainOut).join(', ')}). Closures there are not modeled.`);
  }
  const backOut = run.coverage.backupUnmodeledEdgeIds;
  if (which === 'both' && backOut.length > 0) {
    const name = run.backup ? `, ${wayOutName(prepared.waysOut, run.backup.route).replace(/^Way out/, 'way out')},` : '';
    notes.push(`Part of the backup route${name} runs outside the fire area (${distinctNames(prepared, backOut).join(', ')}) and is not modeled.`);
  }
  if (notes.length === 0) return null;
  return (
    <ul className="notes" aria-label="What this drill could not model">
      {notes.map((n) => (
        <li key={n}>
          <Icon name="warn" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

/** Shown when there is no drill, no way out, or the fire started outside the area. Returns null if the run is usable. */
/** Data sources for this run; the wind entry names where the drill wind really came from. */
export function dataSources(area: AreaData, wind: Wind, isDemo: boolean): string {
  const keys = Object.keys(area.fetchedAt).filter((k) => !/^wind\b/i.test(k));
  const word = windSourceWord(wind, isDemo);
  if (word === 'forecast') keys.push(...Object.keys(area.fetchedAt).filter((k) => /^wind\b/i.test(k)));
  else keys.push(word === 'demo preset' ? 'Wind: demo preset (a strong wind day)' : 'Wind: set by you');
  return keys.join(', ') || 'saved area data';
}

export function DrillProblem({ run, prepared, isDemo }: { run: DrillRun | null; prepared: PreparedArea; isDemo: boolean }) {
  if (!run) {
    return (
      <main className="narrow">
        <section className="box stack state-box">
          <h1 className="verdict"><Icon name="pending" />No drill yet <DemoChip show={isDemo} /></h1>
          <p>Pick a fire and run the drill first. Results show up here.</p>
          <div className="row"><NavLink to="setup" primary>Set up a drill</NavLink></div>
        </section>
      </main>
    );
  }
  if (!run.main || !prepared.waysOut.main) {
    return (
      <main className="narrow">
        <section className="box stack state-box">
          <h1 className="verdict"><Icon name="warn" />No way out found on mapped roads <DemoChip show={isDemo} /></h1>
          <p>OpenStreetMap has no road from your home to a destination outside the drill area. The map may be missing roads near you.</p>
          <div className="row"><NavLink to="address" primary>Use another address</NavLink><NavLink to="map">Back to the home map</NavLink></div>
        </section>
      </main>
    );
  }
  if (!run.coverage.ignitionInGrid) {
    return (
      <main className="narrow">
        <section className="box stack state-box">
          <h1 className="verdict"><Icon name="warn" />This fire started outside the drill area <DemoChip show={isDemo} /></h1>
          <p>The model only covers the area around your home, so no fire was simulated and no road closures can be shown. Pick a starting point on the map.</p>
          <div className="row"><NavLink to="setup" primary>Try a different fire</NavLink></div>
        </section>
      </main>
    );
  }
  return null;
}

/**
 * Warning when the simulated fire reaches the destination itself (engine destinationFire).
 * Null when the fire never comes near it, or the destination is outside the fire area.
 */
export function destinationFireText(run: RouteRun, destName: string): string | null {
  const df = run.destinationFire;
  if (!df || !df.inGrid || !Number.isFinite(df.fireMin)) return null;
  if (df.beforeArrival) {
    return `The simulated fire reaches ${destName} at ${fmtT(df.fireMin)}, before you would arrive at ${fmtT(run.arriveMin)}. Pick a destination farther from the fire.`;
  }
  return `The simulated fire reaches ${destName} at ${fmtT(df.fireMin)}, after you would arrive at ${fmtT(run.arriveMin)}. A destination can be in the fire's path too.`;
}

/** Caption for a map that shows the fire at one minute: when you pass the closing road, or arrive. */
export function fireCaptionFor(run: RouteRun): string {
  const b = run.binding;
  if (!b) return `Fire shown at ${fmtT(run.arriveMin)}, when you arrive`;
  return run.outcome === 'short' ? `Fire shown at ${fmtT(b.passMin)}, when you would reach ${b.name}` : `Fire shown at ${fmtT(b.passMin)}, when you pass ${b.name}`;
}

// ---------- Results screen ----------

const BOTTLENECK_ICON: Record<Bottleneck['kind'], IconName> = {
  road_closed: 'closed',
  one_way_out: 'oneway',
  longest_task: 'clock',
};

function backupLine(run: DrillRun, prepared: PreparedArea): ReactNode {
  const b = run.backup;
  if (!b) return <>No backup route found on mapped roads.</>;
  const name = wayOutName(prepared.waysOut, b.route);
  const v = verdictOf(b);
  if (!b.binding) {
    return (
      <>
        <b>Backup, {name}:</b> not closed by this fire. You would reach {destLabel(prepared, b.route.destinationId)} at {fmtT(b.arriveMin)}.
      </>
    );
  }
  return (
    <>
      <b>Backup, {name}:</b> {b.binding.name} closes at {fmtT(b.binding.closeMin)}; you would pass at {fmtT(b.binding.passMin)}, {v.text}.
    </>
  );
}

export function ResultsScreen() {
  const { state } = useApp();
  const { prepared, area, before: run, isDemo, household } = state;
  if (!prepared || !area) return null;
  const problem = DrillProblem({ run, prepared, isDemo });
  if (problem || !run || !run.main) return problem;

  const main = run.main;
  const v = verdictOf(main);
  const end = endMin(main);
  const b = main.binding;
  const bar = barFor(run, household.tasks)!;
  const fireMin = b ? b.passMin : main.arriveMin;
  const routeNames = main.route.roadNames.join(', ');
  const horizonH = Math.round(run.fire.horizonMin / 60);
  const units = unitsFor(area.country);
  const mainName = wayOutName(prepared.waysOut, main.route);
  const destName = destLabel(prepared, main.route.destinationId);
  const destFire = destinationFireText(main, destName);
  const caption = fireCaptionFor(main);

  const headline =
    v.kind === 'short' ? (
      <>This plan is <span className="is-short">{v.text}.</span></>
    ) : v.kind === 'spare' ? (
      <>This plan gets past {b!.name} with <span className="is-spare">{v.text}.</span></>
    ) : (
      <>This fire did not close your way out.</>
    );

  const mapLabel = b
    ? `Map of ${mainName}, your main route, via ${routeNames}. ${caption}. ${b.name} closes at ${fmtT(b.closeMin)}, marked on the route.`
    : `Map of ${mainName}, your main route, via ${routeNames}. ${caption}; the fire did not close the route.`;

  return (
    <main className="split">
      <section className="stage" style={{ gap: 'var(--s5)' }}>
        <div className="stack-s res-head">
          <h1 className="big">
            {headline} <DemoChip show={isDemo} />
          </h1>
          {b ? (
            <p>
              {b.name} closes at {fmtT(b.closeMin)}. Your household would get past it at {fmtT(b.passMin)}. <Tag kind="calc" />
            </p>
          ) : (
            <p>
              In {horizonH} hours of simulated time, the fire never reached your main route, {mainName}{run.coverage.mainUnmodeledEdgeIds.length > 0 ? ', inside the fire area' : ''}. You would reach{' '}
              {destName} at {fmtT(main.arriveMin)}. That is one fire, not a promise. Try a point closer to your
              roads or a stronger wind. <Tag kind="calc" />
            </p>
          )}
          {destFire && (
            <p className="res-dest-fire" role="status">
              <Icon name="warn" />
              <span><b>Fire at the destination.</b> {destFire} <Tag kind="calc" /></span>
            </p>
          )}
          <p className="backup-line">
            {backupLine(run, prepared)} <Tag kind="calc" />
          </p>
          <div className="conds" aria-label="Drill conditions">
            <span className="chip">{windText(run.setup.wind, true, units)} ({windSourceWord(run.setup.wind, isDemo)})</span>
            <span className="chip">{run.setup.start === 'night' ? `Night start, +${NIGHT_WAKE_MIN} min to wake up` : 'Day start'}</span>
            <span className="chip">{prepared.elevationPerCell ? 'Slope from elevation data' : 'Flat ground (no elevation data)'}</span>
          </div>
          <ModelNotes run={run} area={area} prepared={prepared} />
        </div>

        <div className="stack-s">
          <h2>Where the {fmtMin(end)} minutes go</h2>
          <TimeBars bars={[bar]} />
          <p className="barkey">
            Task minutes <Tag kind="est" /> {b ? 'Drive to the closure point and closure time' : 'Drive to the destination'} <Tag kind="calc" />
          </p>
        </div>

        <MapView
          prepared={prepared}
          routes={[
            { which: 'main', style: main.outcome === 'short' ? 'closed' : 'main', label: 'Way out A' },
            ...(prepared.waysOut.backup ? [{ which: 'backup' as const, style: 'backup' as const, label: 'Way out B' }] : []),
          ]}
          fire={{ run, minute: fireMin }}
          closure={b ? { xy: b.xy, label: `${b.name} closes ${fmtT(b.closeMin)}` } : null}
          wind={run.setup.wind}
          size="short"
          units={units}
          fireCaption={caption}
          ariaLabel={mapLabel}
        />

        <section className="how" aria-labelledby="how6">
          <div className="row between">
            <h2 id="how6">How this plan was made</h2>
            <NavLink to="how">Sources, assumptions and limits</NavLink>
          </div>
          <div className="how-cols">
            <div>
              <Tag kind="calc" />
              <p>
                {b ? `Fire spread, when ${b.name} closes, and drive time` : 'Fire spread, whether your routes close, and drive time'}, by our grid model. Times count from the fire's
                start, as if the order to leave came at once.
              </p>
            </div>
            <div>
              <Tag kind="est" />
              <p>Minutes for each task at home.</p>
            </div>
            <div>
              <Tag kind="ai" />
              <p>Nothing on this screen. AI only words your plan.</p>
            </div>
          </div>
          <p className="how-data">
            Data: {dataSources(area, run.setup.wind, state.isDemo)}. Routes: our own shortest-time routing on the OpenStreetMap road graph.
          </p>
        </section>
      </section>

      <aside className="side">
        <div>
          <h2>What held you back</h2>
          <ul className="list">
            {run.bottlenecks.map((bn) => (
              <li key={bn.kind}>
                <Icon name={BOTTLENECK_ICON[bn.kind]} />
                <div className="grow">
                  <b>{bn.title}</b>
                  <div className="muted">
                    {localizeMiles(bn.detail, units)} {bn.kind === 'longest_task' && <Tag kind="est" />}
                  </div>
                </div>
                {bn.kind === 'longest_task' && bn.minutes !== undefined && <div className="val">{fmtMin(bn.minutes)} min</div>}
              </li>
            ))}
            {run.bottlenecks.length === 0 && (
              <li><div className="grow muted">Nothing held this plan back in this fire.</div></li>
            )}
          </ul>
        </div>
        <div>
          <h2>Key moments <Tag kind="calc" /></h2>
          <ul className="list">
            {run.keyMoments.map((m) => (
              <li key={m.label}>
                <div className={`grow${m.label.endsWith(' closes') ? ' closes' : ''}`}>{localizeMiles(m.label, units)}</div>
                <div className="val">{fmtT(m.min)}</div>
              </li>
            ))}
          </ul>
        </div>
        <NavLink to="fix" primary>Fix the plan</NavLink>
        <NavLink to="setup">Try a different fire</NavLink>
      </aside>
    </main>
  );
}
