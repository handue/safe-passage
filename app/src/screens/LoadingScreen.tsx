// Loading and problem states (mockup 10-states): building the drill, load errors, and notes to read before continuing.
import { useEffect, useRef } from 'react';
import { useApp } from '../app/state';
import { DEMO } from '../app/api';
import { go } from '../app/router';
import { cancelLoad, consumeAutoAdvance, lastWasDemo, retryLoad, startLoad } from '../app/load';
import { Icon } from '../ui/Icon';
import '../styles/entry.css';

/** "Elevation service: fire spreads as if the ground is flat" -> ["Elevation service", "Fire spreads as if the ground is flat."] */
function splitNote(note: string): [string, string] {
  const i = note.indexOf(': ');
  if (i < 0) return [note, ''];
  const rest = note.slice(i + 2);
  return [note.slice(0, i), rest.charAt(0).toUpperCase() + rest.slice(1) + (/[.!?]$/.test(rest) ? '' : '.')];
}

export function LoadingScreen() {
  const { state, dispatch } = useApp();
  const { load, area, prepared, isDemo } = state;
  const headRef = useRef<HTMLHeadingElement>(null);

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
  function tryDemo() {
    dispatch({ type: 'reset' });
    void startLoad(dispatch, DEMO, true);
  }
  function retry() {
    if (!retryLoad(dispatch)) go('address');
  }

  if (load.status === 'loading' || load.status === 'idle') {
    return (
      <main className="narrow">
        <section className="box stack" aria-live="polite" aria-busy="true">
          <h2>Building your drill</h2>
          <ul className="list entry-steps">
            {load.steps.map((s) => (
              <li key={s.label} className={s.state}>
                <Icon name={s.state === 'done' ? 'check' : s.state === 'working' ? 'clock' : 'pending'} />
                <div className={s.state === 'waiting' ? 'grow muted' : 'grow'}>{s.state === 'working' ? <b>{s.label}</b> : s.label}</div>
                <div className={s.state === 'waiting' ? 'val muted' : 'val'}>{s.state}</div>
              </li>
            ))}
          </ul>
          <div>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (load.status === 'error') {
    const code = load.error?.code ?? 'unknown';
    const demoFailed = lastWasDemo() === true;
    const title = code === 'roads_unavailable' ? "We couldn't load the roads near you" : code === 'network' ? "We couldn't reach the Safe Passage server" : "We couldn't build your drill";
    const body =
      code === 'roads_unavailable'
        ? "The road map service didn't answer. A drill needs roads, so it can't run without them."
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
      {area && <p className="muted">Address: {area.addressLabel}</p>}
      {outsideUs && (
        <section className="box stack">
          <h2 className="verdict">
            <Icon name="warn" />
            Outside the US: map data may be thinner
          </h2>
          <p>You can still run a drill. Road and destination data may be incomplete here. Follow your local emergency service.</p>
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
