// Loading and problem states (mockup 10-states): building the drill, load errors, and notes to read before continuing.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../app/state';
import { DEMO } from '../app/api';
import { go } from '../app/router';
import { CLIENT_CAP_MS, cancelLoad, capWords, consumeAutoAdvance, getProgress, lastWasDemo, mapNote, retryLoad, startLoad, stepText, subscribeProgress } from '../app/load';
import { Icon } from '../ui/Icon';
import '../styles/entry.css';

/** "Elevation service: fire spreads as if the ground is flat" -> ["Elevation service", "Fire spreads as if the ground is flat."] */
function splitNote(note: string): [string, string] {
  const i = note.indexOf(': ');
  if (i < 0) return [note, ''];
  const rest = note.slice(i + 2);
  return [note.slice(0, i), rest.charAt(0).toUpperCase() + rest.slice(1) + (/[.!?]$/.test(rest) ? '' : '.')];
}

/** Seconds since the load started, updated each second while `on`. */
function useElapsedS(startedAt: number, on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on, startedAt]);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function LoadingScreen() {
  const { state, dispatch } = useApp();
  const { load, area, prepared, isDemo } = state;
  const headRef = useRef<HTMLHeadingElement>(null);
  const progress = useSyncExternalStore(subscribeProgress, getProgress);
  const working = load.status === 'loading';
  const elapsedS = useElapsedS(progress.startedAt, working);
  const matched = state.entry.matched;

  const noWayOut = load.status === 'ready' && prepared !== null && prepared.waysOut.main === null;
  const outsideUs = load.status === 'ready' && area !== null && area.country !== 'us';
  const fallbacks = load.status === 'ready' && area ? area.fallbacksUsed : [];
  const hasNotes = noWayOut || outsideUs || fallbacks.length > 0;
  const next = isDemo ? 'map' : 'household';

  useEffect(() => {
    // Nothing to load (e.g. a reload on this page): back to the address.
    if (load.status === 'idle' || (load.status === 'error' && load.error?.code === 'cancelled')) {
      go('address');
      return;
    }
    if (load.status === 'ready' && !hasNotes && consumeAutoAdvance()) go(next);
  }, [load.status, load.error?.code, hasNotes, next]);

  // Move focus to a problem box when it appears.
  useEffect(() => {
    if (load.status === 'error' || (load.status === 'ready' && hasNotes)) headRef.current?.focus();
  }, [load.status, hasNotes]);

  function cancel() {
    cancelLoad(dispatch);
    go('address');
  }
  function changeAddress(e: { preventDefault(): void }) {
    e.preventDefault();
    cancel();
  }
  function tryDemo() {
    dispatch({ type: 'reset' });
    void startLoad(dispatch, DEMO, true);
  }
  function retry() {
    if (!retryLoad(dispatch)) go('address');
  }

  if (load.status === 'loading' || load.status === 'idle') {
    const note = mapNote(progress, elapsedS);
    return (
      <main className="narrow">
        <section className="box stack" aria-busy="true">
          <h2>Building your drill</h2>
          {matched && (
            <p className="entry-matched">
              Using: <b>{matched.label}</b>
              {matched.precision && matched.precision !== 'house' && (
                <span className="muted"> ({matched.precision === 'street' ? 'street-level match' : 'town or place match'}, not your exact house)</span>
              )}
              {' · '}
              <a href="#/address" onClick={changeAddress}>
                Not right? Change address
              </a>
            </p>
          )}
          <ul className="list entry-steps" aria-live="polite">
            {load.steps.map((s) => (
              <li key={s.label} className={s.state}>
                <Icon name={s.state === 'done' ? 'check' : s.state === 'working' ? 'clock' : 'pending'} />
                <div className={s.state === 'waiting' ? 'grow muted' : 'grow'}>{s.state === 'working' ? <b>{stepText(s)}…</b> : stepText(s)}</div>
                <div className={s.state === 'waiting' ? 'val muted' : 'val'}>{s.state === 'done' ? 'done' : s.state === 'working' ? 'working' : 'next'}</div>
              </li>
            ))}
          </ul>
          <p className="small">
            <span className="val">{elapsedS} s</span> so far. Most areas take under a minute. When the map server is busy it can take up to {capWords(CLIENT_CAP_MS)}.
          </p>
          {note && (
            <p className="small entry-note" role="status">
              <Icon name="clock" /> {note}
            </p>
          )}
          <div className="row">
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            {elapsedS >= 20 && lastWasDemo() !== true && (
              <button type="button" onClick={tryDemo}>
                Use demo address instead
              </button>
            )}
          </div>
        </section>
      </main>
    );
  }

  if (load.status === 'error') {
    const code = load.error?.code ?? 'unknown';
    const demoFailed = lastWasDemo() === true;
    const title =
      code === 'roads_unavailable'
        ? "We couldn't load the roads near you"
        : code === 'too_slow'
          ? 'Loading took too long'
          : code === 'network'
            ? "We couldn't reach the Safe Passage server"
            : "We couldn't build your drill";
    const body =
      code === 'roads_unavailable'
        ? progress.reason === 'busy'
          ? 'The map data server is busy right now. A drill needs roads, so it can\'t run without them. Retry in a minute, or try the demo address.'
          : progress.reason === 'timeout'
            ? "The map data server didn't answer in time. A drill needs roads, so it can't run without them."
            : "The road map service didn't answer. A drill needs roads, so it can't run without them."
        : code === 'too_slow'
          ? `The map data did not arrive within ${capWords(CLIENT_CAP_MS)}. The map server may be busy. Retry, or try the demo address.`
          : code === 'network'
            ? 'Check your connection and that the local server is running, then retry.'
            : 'Something went wrong while loading map data. Retry, or use another address.';
    return (
      <main className="narrow">
        <section className="box stack" aria-live="assertive">
          <h2 className="verdict" ref={headRef} tabIndex={-1}>
            <Icon name="warn" />
            {title}
          </h2>
          <p>{body}</p>
          {matched && !demoFailed && <p className="small muted">Address used: {matched.label}</p>}
          <div className="row">
            <button type="button" className="primary" onClick={retry}>
              Retry
            </button>
            {!demoFailed && (
              <button type="button" onClick={tryDemo}>
                Try demo address
              </button>
            )}
            <a href="#/address">Use another address</a>
          </div>
        </section>
      </main>
    );
  }

  // Ready.
  if (noWayOut) {
    return (
      <main className="narrow">
        <section className="box stack" aria-live="polite">
          <h2 className="verdict" ref={headRef} tabIndex={-1}>
            <Icon name="warn" />
            No way out found on mapped roads
          </h2>
          <p>OpenStreetMap has no road from your home to a destination outside the drill area. The map may be missing roads near you.</p>
          {area && <p className="small muted">Address used: {area.addressLabel}</p>}
          <div className="row">
            <a className="btn primary" href="#/address">
              Use another address
            </a>
            {!isDemo && (
              <button type="button" onClick={tryDemo}>
                Try demo address
              </button>
            )}
          </div>
        </section>
      </main>
    );
  }

  const continueLabel = isDemo ? 'Continue to home map' : 'Continue to household';
  return (
    <main className="narrow">
      <h1 ref={headRef} tabIndex={-1}>
        {hasNotes ? 'Before you continue' : 'Your drill is ready'}
      </h1>
      {area && (
        <p className="muted">
          Address: {area.addressLabel}
          {!isDemo && matched && matched.precision && matched.precision !== 'house' && (
            <> ({matched.precision === 'street' ? 'street-level match' : 'town or place match'}, not your exact house)</>
          )}
        </p>
      )}
      {outsideUs && (
        <section className="box stack">
          <h2 className="verdict">
            <Icon name="warn" />
            Outside the US: some data is not used here
          </h2>
          <p>You can still run a drill. US fire perimeters are not shown, and roads and destinations may be less complete in the map data. Follow your local emergency service.</p>
        </section>
      )}
      {fallbacks.length > 0 && (
        <section className="box stack">
          <h2 className="verdict">
            <Icon name="warn" />
            A data service didn't answer
          </h2>
          <p>The rest of your drill still works. Here is what changed:</p>
          <table>
            <thead>
              <tr>
                <th scope="col">Missing</th>
                <th scope="col">What we do instead</th>
              </tr>
            </thead>
            <tbody>
              {fallbacks.map((note) => {
                const [what, instead] = splitNote(note);
                return (
                  <tr key={note}>
                    <td>{what}</td>
                    <td>{instead}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={() => go(next)}>
          {continueLabel}
        </button>
        {fallbacks.length > 0 && (
          <button type="button" onClick={retry}>
            Retry
          </button>
        )}
        <a href="#/address">Use another address</a>
      </div>
    </main>
  );
}
