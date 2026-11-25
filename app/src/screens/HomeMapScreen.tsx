// Screen 3: the home, its ways out on real roads, and today's wind and slope.
import { useId, useMemo, useState } from 'react';
import { useApp } from '../app/state';
import { go } from '../app/router';
import type { PreparedArea } from '../engine/area';
import { edgesLeavingGrid, tasksMinutes } from '../engine/drill';
import { cellCenter, cellOf } from '../engine/fire';
import { bearingDeg, compassName, dist } from '../engine/geo';
import { UNNAMED_ROAD } from '../engine/graph';
import type { AreaData, Route, Wind } from '../engine/types';
import { MapView, type MapViewProps } from '../ui/MapView';
import { Tag, fmtMin } from '../ui/Tag';
import { Icon } from '../ui/Icon';
import '../styles/home.css';

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;
/** Same threshold the drill uses for a "one way out" bottleneck (drill.ts ONE_WAY_OUT_MIN_M). */
const ONE_WAY_OUT_MIN_M = 200;
const SLOPE_RADIUS_M = 2000;
/** Below this rise (10 ft) the ground is called nearly flat. */
const FLAT_RISE_FT = 10;

const mi = (m: number) => (m / METERS_PER_MILE).toFixed(1);

/** Short name for a route: first and last named road. */
function routeName(r: Route): string {
  const named = r.roadNames.filter((n) => n !== UNNAMED_ROAD);
  if (named.length === 0) return 'Unnamed roads';
  if (named.length === 1) return named[0];
  return `${named[0]} to ${named[named.length - 1]}`;
}

/** Highest point within SLOPE_RADIUS_M of home, from the elevation per fire cell. */
function slopeNearHome(p: PreparedArea): { riseM: number; distM: number; bearing: number } | null {
  const elev = p.elevationPerCell;
  if (!elev) return null;
  const grid = p.fireGrid;
  const home = cellOf(grid, p.homeXY);
  if (!home) return null;
  const homeElev = elev[home.row * grid.size + home.col];
  let best: { riseM: number; distM: number; bearing: number } | null = null;
  for (let row = 0; row < grid.size; row++) {
    for (let col = 0; col < grid.size; col++) {
      if (row === home.row && col === home.col) continue;
      const c = cellCenter(grid, col, row);
      const d = dist(p.homeXY, c);
      if (d > SLOPE_RADIUS_M) continue;
      const rise = elev[row * grid.size + col] - homeElev;
      if (!Number.isFinite(rise)) continue;
      if (best === null || rise > best.riseM) best = { riseM: rise, distM: d, bearing: bearingDeg(p.homeXY, c) };
    }
  }
  return best;
}

function windSource(area: AreaData, wind: Wind): string {
  if (wind.source === 'manual') return 'set by hand';
  const key = Object.keys(area.fetchedAt).find((k) => k.startsWith('Wind:'));
  return key ? key.replace(/^Wind:\s*/, '') : 'forecast';
}

function fmtTime(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function HomeMapScreen() {
  const { state } = useApp();
  const { area, prepared } = state;
  if (!area || !prepared) {
    return (
      <main className="narrow">
        <h1>Your home and ways out</h1>
        <p>Enter an address first.</p>
        <p><a href="#/address">Go to address</a></p>
      </main>
    );
  }
  return <HomeMap area={area} prepared={prepared} />;
}

function HomeMap({ area, prepared }: { area: AreaData; prepared: PreparedArea }) {
  const { state } = useApp();
  const ids = useId();
  const [showWind, setShowWind] = useState(true);
  const [showTerrain, setShowTerrain] = useState(true);

  const w = prepared.waysOut;
  const { main, backup } = w;
  const destOf = (r: Route) => w.destinations.find((d) => d.id === r.destinationId) ?? null;

  const leaving = useMemo(() => edgesLeavingGrid(prepared.graph, prepared.fireGrid), [prepared]);
  const outsideM = (r: Route | null) => (r ? r.edgeIds.reduce((s, id) => s + (leaving.has(id) ? prepared.graph.edges[id].lengthM : 0), 0) : 0);
  const slope = useMemo(() => slopeNearHome(prepared), [prepared]);

  const wind = area.wind;
  const hasTerrain = prepared.elevationPerCell !== null;
  const householdMin = tasksMinutes(state.household.tasks, 'day');
  const gridKm = (prepared.fireGrid.cellM * prepared.fireGrid.size) / 1000;

  const ways = [
    main ? { key: 'A', route: main, which: 'main' as const } : null,
    backup ? { key: 'B', route: backup, which: 'backup' as const } : null,
  ].filter((x) => x !== null);

  const routes: MapViewProps['routes'] = ways.map((x) => ({ which: x.which, style: x.which, label: `Way out ${x.key}` }));
  const usedDests = ways.map((x) => destOf(x.route)).filter((d) => d !== null);
  const outside = ways.map((x) => ({ key: x.key, m: outsideM(x.route) })).filter((x) => x.m > 0);

  const ariaLabel = main
    ? `Map of roads around your home. Way out A, solid line, ${routeName(main)}.` + (backup ? ` Way out B, dashed line, ${routeName(backup)}.` : ' No second way out found.')
    : 'Map of roads around your home. No way out found on mapped roads.';

  return (
    <main className="split">
      <section className="stage" aria-labelledby={`${ids}-h1`}>
        <div className="row between">
          <h1 id={`${ids}-h1`}>Your home and ways out</h1>
          <fieldset className="row home-layers">
            <legend className="home-vh">Map layers</legend>
            <label className="row">
              <input type="checkbox" checked={showWind && wind !== null} disabled={wind === null} onChange={(e) => setShowWind(e.target.checked)} /> Wind
              {wind === null && <span className="small muted">(no forecast)</span>}
            </label>
            <label className="row">
              <input type="checkbox" checked={showTerrain && hasTerrain} disabled={!hasTerrain} onChange={(e) => setShowTerrain(e.target.checked)} /> Terrain
              {!hasTerrain && <span className="small muted">(no elevation data)</span>}
            </label>
            <label className="row home-disabled">
              <input type="checkbox" checked={false} disabled aria-describedby={`${ids}-ref`} /> Satellite heat and US fire perimeters (reference only)
              <span className="chip" id={`${ids}-ref`}>Coming soon</span>
            </label>
          </fieldset>
        </div>
        <MapView prepared={prepared} routes={routes} wind={showWind ? wind : null} terrain={showTerrain && hasTerrain} size="full" ariaLabel={ariaLabel} />
        <p className="small muted">
          {/* On phones the map's own note already gives the line key and the credit. */}
          <span className="home-mapkey">
            {main && <>Solid line: way out A. {backup && 'Dashed line: way out B. '}</>}
            Map data © OpenStreetMap contributors.{' '}
          </span>
          The reference layer will show NASA FIRMS heat detections and, in the US, NIFC fire perimeters. It is never part of a drill.
        </p>
      </section>

      <aside className="side" aria-label="Your ways out">
        <p>
          {area.addressLabel} {state.isDemo && <span className="chip">Demo address</span>}
        </p>

        {!main ? (
          <div className="box row home-callout is-short" role="status">
            <Icon name="closed" />
            <div className="grow">
              <b>No way out found on mapped roads</b>
              <div className="muted">We could not find a drive from your home to a candidate destination on OpenStreetMap roads. A drill needs one. Try a nearby address.</div>
            </div>
          </div>
        ) : !backup ? (
          <div className="box row home-callout">
            <Icon name="oneway" />
            <div className="grow">
              <b>Only one way out found</b>
              <div className="muted">No second route to a different destination on mapped roads. <Tag kind="calc" /></div>
            </div>
          </div>
        ) : w.sharedFromDoorM >= ONE_WAY_OUT_MIN_M ? (
          <div className="box row home-callout">
            <Icon name="oneway" />
            <div className="grow">
              <b>Only one way out for the first {mi(w.sharedFromDoorM)} mi</b>
              <div className="muted">{w.sharedRoadNames.join(', ') || 'Unnamed road'}, until the ways out split. <Tag kind="calc" /></div>
            </div>
          </div>
        ) : (
          <div className="box row home-callout">
            <Icon name="check" />
            <div className="grow">
              <b>More than one way out from your door</b>
              <div className="muted">Ways out A and B split within {ONE_WAY_OUT_MIN_M} m of home. <Tag kind="calc" /></div>
            </div>
          </div>
        )}

        {ways.length > 0 && (
          <div>
            <h2 className="home-h">Ways out <Tag kind="calc" /></h2>
            <ul className="list">
              {ways.map((x) => (
                <li key={x.key}>
                  <div className="grow">
                    <b>{x.key}. {routeName(x.route)}</b>
                    <div className="muted">to {destOf(x.route)?.label ?? 'destination'} · {mi(x.route.lengthM)} mi{x.key === 'B' ? ' · dashed' : ' · solid'}</div>
                  </div>
                  <div className="val">{fmtMin(x.route.driveMin)} min drive</div>
                </li>
              ))}
            </ul>
            {outside.length > 0 && (
              <p className="small muted home-note">
                {outside.map((o) => `Last ${mi(o.m)} mi of ${o.key}`).join(' and ')} {outside.length > 1 ? 'run' : 'runs'} outside the {gridKm} × {gridKm} km fire area. The drill does not model fire there.
              </p>
            )}
          </div>
        )}

        {usedDests.length > 0 && (
          <div className="stack-s">
            <h2 className="home-h">Candidate destinations</h2>
            <p>
              {usedDests.map((d) => (d.label.endsWith(d.name) ? d.label : `${d.label} (${d.name})`)).join(', ')}.{' '}
              <b>Candidate destinations, not confirmed shelters.</b> Check with your county.
            </p>
            {usedDests.some((d) => d.kind === 'exit_point') && (
              <p className="small muted">An exit point is where a main road leaves the mapped area, not a place to stay.</p>
            )}
          </div>
        )}

        <div className="stack-s">
          <h2 className="home-h">Today's conditions <Tag kind="calc" /></h2>
          <p>
            {wind ? (
              <>
                Wind from the {compassName(wind.fromDeg)}, {Math.round(wind.speedMph)} mph ({windSource(area, wind)}
                {fmtTime(wind.fetchedAt) ? `, ${fmtTime(wind.fetchedAt)}` : ''}).
              </>
            ) : (
              <>Wind forecast not available. You will set the wind for the drill.</>
            )}{' '}
            {slope === null ? (
              <>Flat (no elevation data).</>
            ) : slope.riseM * FEET_PER_METER < FLAT_RISE_FT ? (
              <>Nearly flat: no point within {mi(SLOPE_RADIUS_M)} mi is more than {FLAT_RISE_FT} ft above home.</>
            ) : (
              <>
                Ground rises {Math.round(slope.riseM * FEET_PER_METER)} ft toward the {compassName(slope.bearing)}, to the highest point within{' '}
                {mi(SLOPE_RADIUS_M)} mi ({Math.round((slope.riseM / slope.distM) * 100)}% average grade). Fire spreads faster uphill.
              </>
            )}
          </p>
        </div>

        {area.fallbacksUsed.length > 0 && (
          <div className="stack-s">
            <h2 className="home-h">Data notes</h2>
            <ul className="small muted home-notes">
              {area.fallbacksUsed.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </div>
        )}

        <div className="row">
          {main ? (
            <button type="button" className="primary" onClick={() => go('setup')}>Set up a drill</button>
          ) : (
            <button type="button" className="primary" onClick={() => go('address')}>Try another address</button>
          )}
          <a href="#/household">Edit household ({fmtMin(householdMin)} min)</a>
        </div>
      </aside>
    </main>
  );
}
