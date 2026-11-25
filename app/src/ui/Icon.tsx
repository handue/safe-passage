// The small icon set from the design (one stroke family).
import type { ReactElement } from 'react';
export type IconName = 'warn' | 'closed' | 'oneway' | 'clock' | 'check' | 'pending';

const PATHS: Record<IconName, { sw: number; d: ReactElement }> = {
  warn: { sw: 2, d: <><path d="M12 3 22 21H2Z" strokeLinejoin="round" /><path d="M12 10v5M12 18v.5" /></> },
  closed: { sw: 2.5, d: <><circle cx="12" cy="12" r="9" /><path d="M6 18 18 6" /></> },
  oneway: { sw: 2.5, d: <path d="M5 4v16M19 4v16M12 18V7M8 11l4-4 4 4" /> },
  clock: { sw: 2.5, d: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 3" /></> },
  check: { sw: 3, d: <path d="M4 12.5 10 18 20 6" /> },
  pending: { sw: 2.5, d: <circle cx="12" cy="12" r="9" strokeDasharray="3.5 3.5" /> },
};

export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  const p = PATHS[name];
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw} aria-hidden="true">
      {p.d}
    </svg>
  );
}
