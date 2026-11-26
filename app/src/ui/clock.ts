// Stopwatch helpers for "Time it for real".

/** Whole minutes from measured seconds: nearest minute, at least 1 so a done task never reads as nothing. */
export function timedMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** "4:07" from seconds. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
