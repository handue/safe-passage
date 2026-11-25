// Screen 4: choose the practice fire (ignition point, wind, start time), then run it.
import { useEffect, useState } from 'react';
import { useApp, isDemoWind } from '../app/state';
import { go } from '../app/router';
import { MapView } from '../ui/MapView';
import { Icon } from '../ui/Icon';
import { checkIgnitionPoint, type IgnitionPointCheck } from '../engine/ignition';
import { NIGHT_WAKE_MIN } from '../engine/drill';
import type { StartTime, Wind, XY } from '../engine/types';
import { fmtSpeed, localizeKm, speedToMph, speedUnit, speedValue, speedWords, unitsFor } from '../ui/units';
import '../styles/drill.css';

const COMPASS_ABBR = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const COMPASS_WORD = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const STRONG_WIND_MPH = 25;
/** Slider top: 60 mph, or 100 km/h. */
const SLIDER_MAX = { mi: 60, km: 100 } as const;

/** Why a clicked point cannot start the fire, or null when it can. */
export function pickRefusal(check: IgnitionPointCheck): string | null {
  if (check === 'outside') return 'That point is outside the area the fire model covers. Pick a point closer to home.';
  if (check === 'water') return 'That point is on the sea, where fire cannot start. Pick a point on land.';
  return null;
}

/** Index 0..7 of the nearest 8-way compass direction. */
function compassIndex(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return Math.round(d / 45) % 8;
}

const sameXY = (a: XY | null, b: XY | null) => !!a && !!b && a.x === b.x && a.y === b.y;

function fmtClock(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function DrillSetupScreen() {
  const { state, dispatch } = useApp();
  const { prepared, area, setup, suggestions } = state;
  // Which suggestion is selected, so it follows the new suggestions when the wind changes.
  const [pickedIdx, setPickedIdx] = useState<number | null>(() => {
    const i = suggestions.findIndex((s) => sameXY(s.xy, setup.ignition));
    return i >= 0 ? i : null;
  });
  const [pickMsg, setPickMsg] = useState<string | null>(null);

  // A picked suggestion that no longer exists (fewer suggestions after a wind change) falls back to the first.
  const selIdx = pickedIdx === null || suggestions.length === 0 ? null : pickedIdx < suggestions.length ? pickedIdx : 0;
  useEffect(() => {
    if (selIdx === null) return;
    const s = suggestions[selIdx];
    if (!sameXY(s.xy, setup.ignition)) dispatch({ type: 'setup/set', patch: { ignition: s.xy } });
  }, [suggestions, selIdx, setup.ignition, dispatch]);

  if (!prepared || !area) return null;

  const units = unitsFor(area.country);
  // Any later change to the fire clears an old "cannot start here" message.
  const setWind = (w: Wind) => {
    setPickMsg(null);
    dispatch({ type: 'setup/set', patch: { wind: w } });
  };
  const windIdx = compassIndex(setup.wind.fromDeg);
  const today = area.wind;
  const windService = Object.keys(area.fetchedAt).find((k) => /^wind/i.test(k));
  const fetched = fmtClock(today?.fetchedAt ?? (windService ? area.fetchedAt[windService] : undefined));
  const usingToday = !!today && setup.wind.source === 'forecast' && setup.wind.fromDeg === today.fromDeg && setup.wind.speedMph === today.speedMph;
  const custom = setup.ignition !== null && selIdx === null;

  const pickSuggestion = (i: number) => {
    setPickedIdx(i);
    setPickMsg(null);
    dispatch({ type: 'setup/set', patch: { ignition: suggestions[i].xy } });
  };
  const pickPoint = (xy: XY) => {
    const refusal = pickRefusal(checkIgnitionPoint(prepared.fireGrid, prepared.elevationPerCell, xy));
    if (refusal) {
      setPickMsg(refusal);
      return;
    }
    setPickMsg(null);
    setPickedIdx(null);
    dispatch({ type: 'setup/set', patch: { ignition: xy } });
  };

  const noRoute = prepared.waysOut.main === null;
  const notes = [...area.fallbacksUsed];
  if (area.elevation === null && !notes.some((n) => /elevation/i.test(n))) notes.push('No elevation data: the fire spreads as if the ground is flat.');

  const start = () => {
    if (!setup.ignition) return;
    dispatch({ type: 'drill/run' });
    go('running');
  };

  return (
    <main className="split">
      <section className="stage">
        <div className="row between">
          <h1>Where does the practice fire start?</h1>
          {state.isDemo && <span className="chip">Demo address</span>}
        </div>
        <p>Click the map, or choose one of the suggested points.</p>
        <MapView
          prepared={prepared}
          routes={[
            { which: 'main', style: 'main' },
            ...(prepared.waysOut.backup ? [{ which: 'backup' as const, style: 'backup' as const }] : []),
          ]}
          wind={setup.wind}
          units={units}
          ignition={{ suggestions, selected: setup.ignition, onPick: pickPoint }}
          ariaLabel="Map of the roads around home. Click to place the practice fire."
        />
        <div aria-live="polite">
          {pickMsg && (
            <p className="pick-msg"><Icon name="warn" />{pickMsg}</p>
          )}
        </div>
      </section>

      <form
        className="side"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <fieldset>
          <legend>Ignition point</legend>
          {suggestions.length === 0 && !custom && (
            <p className="small muted">No suggested points for this area. Click the map to place the fire.</p>
          )}
          <div className="seg ig-seg">
            {suggestions.map((s, i) => (
              <label key={`${s.xy.x},${s.xy.y}`}>
                <input type="radio" name="ignition" checked={selIdx === i} onChange={() => pickSuggestion(i)} />
                <span className="ig-text">
                  <span>{i + 1}. {localizeKm(s.label, units)}</span>
                  <span className="ig-reason">{s.reason}</span>
                </span>
              </label>
            ))}
            {custom && (
              <label>
                <input type="radio" name="ignition" checked readOnly />
                <span className="ig-text">
                  <span>Your point on the map</span>
                  <span className="ig-reason">Click the map again to move it.</span>
                </span>
              </label>
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend>Wind blows from</legend>
          <div className="seg wind-seg">
            {COMPASS_ABBR.map((abbr, i) => (
              <label key={abbr} title={COMPASS_WORD[i]}>
                <input
                  type="radio"
                  name="wind-dir"
                  aria-label={COMPASS_WORD[i]}
                  checked={windIdx === i}
                  onChange={() => setWind({ fromDeg: i * 45, speedMph: setup.wind.speedMph, source: 'manual' })}
                />
                {abbr}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="stack-s">
          <label htmlFor="wind-speed">Wind speed: <output htmlFor="wind-speed">{speedValue(setup.wind.speedMph, units)}</output> {speedUnit(units)}</label>
          <input
            id="wind-speed"
            type="range"
            min={0}
            max={SLIDER_MAX[units]}
            step={1}
            value={speedValue(setup.wind.speedMph, units)}
            aria-valuetext={`${speedValue(setup.wind.speedMph, units)} ${speedWords(units)}`}
            onChange={(e) => setWind({ fromDeg: setup.wind.fromDeg, speedMph: speedToMph(Number(e.target.value), units), source: 'manual' })}
          />
          <div className="btn-row">
            <button type="button" disabled={!today || usingToday} onClick={() => today && setWind(today)}>
              Use today's wind
            </button>
            <button
              type="button"
              disabled={setup.wind.speedMph === STRONG_WIND_MPH}
              onClick={() => setWind({ fromDeg: setup.wind.fromDeg, speedMph: STRONG_WIND_MPH, source: 'manual' })}
            >
              Strong wind day
            </button>
          </div>
          {today ? (
            <span className="small muted">
              Today: from the {COMPASS_WORD[compassIndex(today.fromDeg)]} at {fmtSpeed(today.speedMph, units)}
              {windService ? `, ${windService.replace(/^wind:\s*/i, '')}` : ''}
              {fetched ? `, fetched ${fetched}` : ''}.
              {usingToday ? ' In use.' : ''}
            </span>
          ) : (
            <p className="drill-note"><Icon name="warn" />The wind forecast is not available. Set the wind by hand.</p>
          )}
          {state.isDemo && isDemoWind(setup.wind) && (
            <span className="small muted">Demo preset: a strong wind day from the northeast, so the same practice fire runs every time. Use today's wind to try the forecast.</span>
          )}
          <span className="small muted">Strong wind day sets {fmtSpeed(STRONG_WIND_MPH, units)} and keeps the direction. Changing the wind updates the suggested points.</span>
        </div>

        <fieldset>
          <legend>Start time</legend>
          <div className="seg">
            {(['day', 'night'] as StartTime[]).map((t) => (
              <label key={t}>
                <input
                  type="radio"
                  name="start"
                  checked={setup.start === t}
                  onChange={() => {
                    setPickMsg(null);
                    dispatch({ type: 'setup/set', patch: { start: t } });
                  }}
                />
                {t === 'day' ? 'Day' : 'Night'}
              </label>
            ))}
          </div>
          <p className="small muted" style={{ marginTop: 'var(--s2)' }}>
            Night adds a {NIGHT_WAKE_MIN} min "wake up" step before your tasks. This is a fixed app default, not your estimate. It does not change how the fire spreads.
          </p>
        </fieldset>

        {notes.length > 0 && (
          <ul className="drill-notes" aria-label="Data notes">
            {notes.map((n) => (
              <li key={n} className="drill-note"><Icon name="warn" />{n}</li>
            ))}
          </ul>
        )}
        {noRoute && (
          <p className="drill-note"><Icon name="closed" />No way out found on mapped roads. The drill still shows the fire, but there is no route to time.</p>
        )}

        <p>In this drill, the order to leave reaches you the moment the fire starts. Real orders can come later.</p>
        {/* Sticky on desktop with a solid band, so text scrolls behind it and is never half covered. */}
        <div className="start-bar">
          <button className="primary" type="submit" disabled={!setup.ignition}>Start drill</button>
          {!setup.ignition && <p className="small muted">Choose an ignition point first.</p>}
        </div>
      </form>
    </main>
  );
}
