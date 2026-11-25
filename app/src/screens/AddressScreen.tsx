// Screen 1: address entry, with an example drill computed at the demo address.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp, initialState, routeShape, DEMO_WIND } from '../app/state';
import { DEMO, ApiError, fetchArea } from '../app/api';
import { go } from '../app/router';
import { MAX_QUERY_CHARS, isGenericMatch, searchAddress, startLoad, type Place } from '../app/load';
import { prepareArea, type PreparedArea } from '../engine/area';
import { runDrill, type DrillRun } from '../engine/drill';
import { suggestIgnitions } from '../engine/ignition';
import type { Wind } from '../engine/types';
import { MapView } from '../ui/MapView';
import { Icon } from '../ui/Icon';
import { Tag, fmtT } from '../ui/Tag';
import '../styles/entry.css';

const MAX_CHOICES = 5;

type Phase =
  | { kind: 'idle' }
  | { kind: 'empty' }
  | { kind: 'searching' }
  | { kind: 'notfound'; query: string }
  | { kind: 'toolong' }
  | { kind: 'rejected' }
  | { kind: 'choose'; results: Place[]; generic: boolean }
  | { kind: 'error'; code: string };

export function AddressScreen() {
  const { state, dispatch } = useApp();
  const saved = state.entry;
  const [query, setQuery] = useState(saved.query);
  // Coming back to this screen: show the pick list from the last search again.
  const [phase, setPhase] = useState<Phase>(
    saved.choices && saved.choices.length > 1 ? { kind: 'choose', results: saved.choices, generic: isGenericMatch(saved.query, saved.choices) } : { kind: 'idle' },
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const hintId = useId();

  // Keep what was typed when leaving the screen, even without a search.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => () => dispatch({ type: 'entry/set', patch: { query: queryRef.current } }), [dispatch]);

  // Move focus to a new problem or choice box so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (phase.kind === 'notfound' || phase.kind === 'choose' || phase.kind === 'error') statusRef.current?.focus();
    // Too long or turned down: keep focus in the box so the address can be fixed there.
    if (phase.kind === 'toolong' || phase.kind === 'rejected') inputRef.current?.focus();
  }, [phase.kind]);

  function begin(place: Place) {
    void startLoad(dispatch, place, false);
    go('loading');
  }

  function tryDemo() {
    // Fresh state, so the sample household is the one already in the store.
    dispatch({ type: 'reset' });
    void startLoad(dispatch, DEMO, true);
    go('loading');
  }

  async function search(e?: FormEvent | { preventDefault(): void }) {
    e?.preventDefault();
    const q = query.trim();
    if (!q) {
      setPhase({ kind: 'empty' });
      inputRef.current?.focus();
      return;
    }
    if (q.length > MAX_QUERY_CHARS) {
      setPhase({ kind: 'toolong' });
      return;
    }
    dispatch({ type: 'entry/set', patch: { query: q, choices: null } });
    setPhase({ kind: 'searching' });
    try {
      const results = await searchAddress(q);
      if (results.length === 0) setPhase({ kind: 'notfound', query: q });
      else if (results.length === 1) begin(results[0]);
      else {
        const choices = results.slice(0, MAX_CHOICES);
        dispatch({ type: 'entry/set', patch: { choices } });
        setPhase({ kind: 'choose', results: choices, generic: isGenericMatch(q, choices) });
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      if (code === 'query_too_long') setPhase({ kind: 'toolong' });
      else if (code === 'query_rejected') setPhase({ kind: 'rejected' });
      else setPhase({ kind: 'error', code });
    }
  }

  const searching = phase.kind === 'searching';
  const input = (
    <input
      ref={inputRef}
      id="addr"
      type="text"
      placeholder="Street address, town or city"
      autoComplete="street-address"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      aria-describedby={phase.kind === 'empty' || phase.kind === 'toolong' ? hintId : undefined}
      aria-invalid={phase.kind === 'empty' || phase.kind === 'notfound' || phase.kind === 'toolong' ? true : undefined}
      style={{ flex: '1 1 300px' }}
    />
  );
  const submit = (
    <button className="primary" type="submit" disabled={searching}>
      {searching ? 'Searching…' : phase.kind === 'notfound' ? 'Search again' : 'Build my drill'}
    </button>
  );
  const demoButton = (
    <button type="button" onClick={tryDemo}>
      Try demo address
    </button>
  );

  return (
    <main className="landing">
      <div className="landing-copy">
        <div className="stack">
          <h1 style={{ fontSize: 'var(--t-2xl)' }}>Practice leaving home before you have to.</h1>
          <p style={{ fontSize: 'var(--t-m)' }}>
            Enter your address. Run a simulated wildfire. Find what slows your household down, fix it, and run the same fire again.
          </p>
        </div>

        {phase.kind === 'notfound' ? (
          <form className="box stack" onSubmit={search} aria-live="polite">
            <h2 className="verdict" ref={statusRef} tabIndex={-1}>
              <Icon name="warn" />
              We couldn't find that address
            </h2>
            <p>Check the spelling, or add the town or city and the state or region.</p>
            <label htmlFor="addr">Home address</label>
            <div className="row">
              {input}
              {submit}
            </div>
            <div className="row">{demoButton}</div>
          </form>
        ) : (
          <form className="stack" onSubmit={search}>
            <label htmlFor="addr">Home address</label>
            <div className="row">
              {input}
              {submit}
            </div>
            {phase.kind === 'empty' && (
              <p id={hintId} className="small entry-hint" role="alert">
                <Icon name="warn" /> Type your home address first.
              </p>
            )}
            {phase.kind === 'toolong' && (
              <p id={hintId} className="small entry-hint" role="alert">
                <Icon name="warn" />
                That address is too long. Enter the street, the town or city, and the state or region ({MAX_QUERY_CHARS} characters at most).
              </p>
            )}
            {phase.kind === 'rejected' && (
              <p className="small entry-hint" role="alert">
                <Icon name="warn" />
                The address service could not read that. Check the address, or shorten it to the street, town or city, and state.
              </p>
            )}
            <div className="row">
              {demoButton}
              <span className="muted">Boulder Creek Library, CA, with a sample household. Nothing to type.</span>
            </div>
            <p className="small muted">
              Your address is sent to map, route, terrain and weather services to build the drill. The AI writer gets road names, times and task names, not your house number.
            </p>
          </form>
        )}

        {phase.kind === 'choose' && (
          <section className="box stack" aria-live="polite">
            <h2 ref={statusRef} tabIndex={-1}>Which one is your home?</h2>
            <p className="muted">We found {phase.results.length} matches. Pick one, or search again with more detail.</p>
            {phase.generic && (
              <p className="small">
                <b>Tip:</b> These matches are in different places. Add the town or city and the state or region to your search to narrow them.
              </p>
            )}
            <ul className="list entry-choices">
              {phase.results.map((r, i) => (
                <li key={`${r.lat},${r.lon},${i}`}>
                  <button type="button" className="entry-choice" onClick={() => begin(r)}>
                    {r.label}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {phase.kind === 'error' && (
          <section className="box stack" aria-live="polite">
            <h2 className="verdict" ref={statusRef} tabIndex={-1}>
              <Icon name="warn" />
              The address search didn't answer
            </h2>
            <p>
              {phase.code === 'network'
                ? 'We could not reach the Safe Passage server. Check your connection, then try again.'
                : 'The address service did not respond. Try again in a moment, or use the demo address.'}
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => void search()}>
                Try again
              </button>
              {demoButton}
            </div>
          </section>
        )}

        <ol className="cols3" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          <li className="stack-s">
            <h2 style={{ fontSize: 'var(--t-m)' }}>1. Rehearse</h2>
            <p className="muted">A practice fire spreads with wind and slope near your home.</p>
          </li>
          <li className="stack-s">
            <h2 style={{ fontSize: 'var(--t-m)' }}>2. Find weak spots</h2>
            <p className="muted">One way out, a road the fire closes, or the task that takes longest.</p>
          </li>
          <li className="stack-s">
            <h2 style={{ fontSize: 'var(--t-m)' }}>3. Fix and compare</h2>
            <p className="muted">Change the plan and see before and after on the same fire.</p>
          </li>
        </ol>
        <p className="box">
          <b>This is not a fire alert app.</b> It does not track live fires or tell you when to leave.
        </p>
      </div>
      <ExampleDrill />
    </main>
  );
}

// ---------- Example drill at the demo address ----------

interface Example {
  prepared: PreparedArea;
  run: DrillRun;
  wind: Wind;
  minute: number;
}

let exampleCache: Promise<Example | null> | null = null;

/** Loads the demo area (cached on the server) and runs the same fire as "Try demo address":
 * the demo wind preset, the first suggested ignition and the sample household. */
function loadExample(): Promise<Example | null> {
  exampleCache ??= fetchArea(DEMO, true)
    .then((area) => {
      const prepared = prepareArea(area);
      const { main, backup } = prepared.waysOut;
      if (!main) return null;
      const base = initialState();
      const wind = DEMO_WIND;
      const first = suggestIgnitions(prepared.fireGrid, prepared.elevationPerCell, wind, prepared.homeXY, routeShape(prepared, main), [
        routeShape(prepared, backup),
      ])[0];
      if (!first) return null;
      const run = runDrill(prepared, base.household.tasks, { ignition: first.xy, wind, start: base.setup.start, seed: base.setup.seed });
      if (!run.coverage.ignitionInGrid || !run.main) return null;
      // Draw the fire when the road closes; if it never does, when the household would arrive.
      const minute = run.main.binding ? run.main.binding.closeMin : Math.min(run.main.arriveMin, run.fire.horizonMin);
      return { prepared, run, wind, minute };
    })
    .catch(() => null)
    .then((ex) => {
      if (!ex) exampleCache = null; // try again on the next visit
      return ex;
    });
  return exampleCache;
}

function ExampleDrill() {
  const [ex, setEx] = useState<Example | null | 'loading'>('loading');
  useEffect(() => {
    let alive = true;
    loadExample().then((r) => alive && setEx(r));
    return () => {
      alive = false;
    };
  }, []);

  if (ex === 'loading' || ex === null) {
    return (
      <figure className="preview">
        <div className="map entry-placeholder">
          <p>{ex === 'loading' ? 'Loading an example drill at the demo address…' : 'Your map appears here after you choose an address'}</p>
        </div>
        <figcaption>
          <b>Example drill</b> · A practice fire, your route out and the wind, drawn from real map data around your home.
        </figcaption>
      </figure>
    );
  }

  const binding = ex.run.main?.binding ?? null;
  const t = fmtT(ex.minute);
  const n = Math.round(ex.minute);
  return (
    <figure className="preview">
      <MapView
        prepared={ex.prepared}
        routes={[{ which: 'main', style: 'main' }]}
        fire={{ run: ex.run, minute: ex.minute }}
        closure={binding ? { xy: binding.xy, label: `${binding.name} closes ${fmtT(binding.closeMin)}` } : null}
        wind={ex.wind}
        ariaLabel={
          binding
            ? `Example drill at the demo address: a simulated fire reaches ${binding.name} on the route out ${n} minutes after it starts.`
            : `Example drill at the demo address: a simulated fire shown ${n} minutes after it starts; it does not close the route out.`
        }
      />
      <figcaption>
        <b>Example drill at the demo address</b> <span className="chip">Demo address</span> ·{' '}
        {binding ? (
          <>
            A practice fire moves toward the road out. Cyan line: route out. Arrow: wind (demo preset, a strong wind day). {t} <Tag kind="calc" /> means{' '}
            {binding.name} closes {n} minutes after the fire starts.
          </>
        ) : (
          <>
            A practice fire near the demo address. In this example it does not close the road out. Cyan line: route out. Arrow: wind (demo preset, a strong wind day). Fire shown at {t} <Tag kind="calc" />, {n} minutes after it starts.
          </>
        )}
      </figcaption>
    </figure>
  );
}
