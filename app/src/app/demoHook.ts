// Dev-only: with ?demo=1 in the URL, do what the "Try demo address" button does (load the demo
// address with the sample household; the store gives it the fixed demo wind), run the first
// suggested fire and apply the pets and meds fixes, so any screen can be opened directly
// (for screenshots). It sets nothing the button path does not. Does nothing in production builds.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useApp } from './state';
import { DEMO } from './api';
import { consumeAutoAdvance, startLoad } from './load';

const demoOn = (): boolean =>
  import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';

// True until the demo hook has finished setting up, so the plan screen does not ask the
// writer for a plan the next demo step would replace (that caused a second /api/plan call).
let settling = demoOn();
const listeners = new Set<() => void>();
function setSettling(v: boolean): void {
  if (settling === v) return;
  settling = v;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

/** True while the ?demo=1 setup is still changing the drill and fixes. */
export function useDemoSettling(): boolean {
  return useSyncExternalStore(subscribe, () => settling);
}

export function useDemoHook(): void {
  const { state, dispatch } = useApp();
  const stage = useRef(0);
  const on = demoOn();

  useEffect(() => {
    if (!on) return;
    if (state.load.status === 'error') {
      setSettling(false);
      return;
    }
    if (stage.current === 0 && state.load.status === 'idle') {
      stage.current = 1;
      void startLoad(dispatch, DEMO, true);
    } else if (stage.current === 1 && state.load.status === 'ready') {
      stage.current = 2;
      consumeAutoAdvance();
      // The button path keeps the first suggested ignition, already set by load/done.
      if (!state.setup.ignition) {
        setSettling(false);
        return;
      }
      dispatch({ type: 'drill/run' });
      const taskMinutes: Record<string, number> = {};
      for (const t of state.household.tasks) {
        if (t.id === 'pets' || t.id === 'meds') taskMinutes[t.id] = Math.max(1, Math.round(t.minutes / 3));
      }
      dispatch({ type: 'fixes/set', fixes: { taskMinutes, switchMainRoute: false } });
    } else if (stage.current === 2) {
      // This run sees the state after both dispatches, so the plan request can go out once.
      stage.current = 3;
      setSettling(false);
    }
  }, [on, state, dispatch]);
}
