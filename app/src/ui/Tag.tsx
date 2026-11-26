// Provenance tags and the sample-data chip. Told apart by line style, not color.
import { displayMin } from '../engine/drill';
import type { Task } from '../engine/types';

export function Tag({ kind }: { kind: 'calc' | 'est' | 'ai' | 'timed' }) {
  const text = kind === 'calc' ? 'CALCULATED' : kind === 'est' ? 'YOUR ESTIMATE' : kind === 'timed' ? 'YOU TIMED IT' : 'AI-WRITTEN';
  return <span className={`tag ${kind}`}>{text}</span>;
}

/** Tags for a set of task minutes: YOU TIMED IT and/or YOUR ESTIMATE, by what the tasks are. */
export function TaskTags({ tasks }: { tasks: Pick<Task, 'source'>[] }) {
  const timed = tasks.some((t) => t.source === 'timed');
  const est = tasks.length === 0 || tasks.some((t) => t.source !== 'timed');
  return (
    <>
      {timed && <Tag kind="timed" />}
      {timed && est && ' '}
      {est && <Tag kind="est" />}
    </>
  );
}

/** Minutes as whole numbers; T+ times as "T+12". Both use the engine's one rounding rule. */
export const fmtMin = (m: number) => `${displayMin(m)}`;
export const fmtT = (m: number) => `T+${displayMin(m)}`;
