// Page frame shared by every screen: header with steps, drill band, disclaimer footer.
import type { ReactNode } from 'react';
import type { ScreenId } from '../app/router';
import { Icon } from './Icon';

const STEPS: { id: string; label: string; href: ScreenId; match: ScreenId[] }[] = [
  { id: 'address', label: 'Address', href: 'address', match: ['address', 'loading'] },
  { id: 'household', label: 'Household', href: 'household', match: ['household'] },
  { id: 'map', label: 'Home map', href: 'map', match: ['map'] },
  { id: 'drill', label: 'Drill', href: 'setup', match: ['setup', 'running', 'results'] },
  { id: 'fix', label: 'Fix', href: 'fix', match: ['fix'] },
  { id: 'plan', label: 'Plan', href: 'plan', match: ['plan'] },
];

export const DISCLAIMER = 'Do not use it for real emergency decisions. In a real fire, follow official alerts and local evacuation orders.';

export function Shell({ screen, drill = false, ready, children }: { screen: ScreenId; drill?: boolean; ready: boolean; children: ReactNode }) {
  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="#/address">
          <svg className="mark" viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="#122a36" /><path d="M8 22v-6l8-4V6" fill="none" stroke="#3ddcf5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="22" r="2.6" fill="#eef3f9" /><path d="M12.5 9.5 16 6l3.5 3.5" fill="none" stroke="#3ddcf5" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Safe Passage
        </a>
        <nav aria-label="Progress">
          <ol className="steps">
            {STEPS.map((s) => {
              const current = s.match.includes(screen);
              const locked = !ready && s.id !== 'address';
              return (
                <li key={s.id}>
                  {locked ? (
                    <span aria-disabled="true" className="locked">{s.label}</span>
                  ) : (
                    <a href={`#/${s.href}`} aria-current={current ? 'step' : undefined}>{s.label}</a>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="end"><a href="#/how">How this plan was made</a></div>
      </header>
      {drill && <div className="drillband">DRILL · SIMULATED FIRE · NOT A LIVE ALERT</div>}
      {children}
      <footer className="disclaimer">
        <Icon name="warn" />
        <p><b>Simplified model for practice only.</b> {DISCLAIMER}</p>
      </footer>
    </div>
  );
}
