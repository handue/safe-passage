// Provenance tags and the sample-data chip. Told apart by line style, not color.
import { displayMin } from '../engine/drill';

export function Tag({ kind }: { kind: 'calc' | 'est' | 'ai' }) {
  const text = kind === 'calc' ? 'CALCULATED' : kind === 'est' ? 'YOUR ESTIMATE' : 'AI-WRITTEN';
  return <span className={`tag ${kind}`}>{text}</span>;
}

/** Minutes as whole numbers; T+ times as "T+12". Both use the engine's one rounding rule. */
export const fmtMin = (m: number) => `${displayMin(m)}`;
export const fmtT = (m: number) => `T+${displayMin(m)}`;
