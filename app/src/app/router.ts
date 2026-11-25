// Hash routes, one per screen. Hash routing keeps deep links working with any static host.
import { useEffect, useState } from 'react';

export type ScreenId = 'address' | 'loading' | 'household' | 'map' | 'setup' | 'running' | 'results' | 'fix' | 'plan' | 'how';

const IDS: ScreenId[] = ['address', 'loading', 'household', 'map', 'setup', 'running', 'results', 'fix', 'plan', 'how'];

function read(): ScreenId {
  const id = window.location.hash.replace(/^#\/?/, '') as ScreenId;
  return IDS.includes(id) ? id : 'address';
}

export function go(id: ScreenId) {
  window.location.hash = `/${id}`;
  window.scrollTo(0, 0);
}

export function useScreen(): ScreenId {
  const [id, setId] = useState<ScreenId>(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return id;
}
