// Dev-only: with ?demo=1 in the URL, do what the "Try demo address" button does (load the demo
// address with the sample household; the store gives it the fixed demo wind), run the first
// suggested fire and apply the pets and meds fixes, so any screen can be opened directly
// (for screenshots). It sets nothing the button path does not. Does nothing in production builds.
import { useEffect, useRef } from 'react';
import { useApp } from './state';
import { DEMO } from './api';
import { consumeAutoAdvance, startLoad } from './load';

export function useDemoHook(): void {
  const { state, dispatch } = useApp();
  const stage = useRef(0);
  const on = import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1';

  useEffect(() => {
    if (!on) return;
    if (stage.current === 0 && state.load.status === 'idle') {
      stage.current = 1;
      void startLoad(dispatch, DEMO, true);
    } else if (stage.current === 1 && state.load.status === 'ready') {
      stage.current = 2;
      consumeAutoAdvance();
      // The button path keeps the first suggested ignition, already set by load/done.
      if (!state.setup.ignition) return;
      dispatch({ type: 'drill/run' });
      const taskMinutes: Record<string, number> = {};
      for (const t of state.household.tasks) {
        if (t.id === 'pets' || t.id === 'meds') taskMinutes[t.id] = Math.max(1, Math.round(t.minutes / 3));
      }
      dispatch({ type: 'fixes/set', fixes: { taskMinutes, switchMainRoute: false } });
    }
  }, [on, state, dispatch]);
}
