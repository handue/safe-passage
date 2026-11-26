// "Other situations, same fire": the AI picks which stress-test situations fit this household
// and their assumed values, from the kinds the engine said it can compute. The AI never computes
// times. Without MODEL_API_KEY, or on any failure, the response is a fallback and the client uses
// its fixed rules (defaultSituations in the engine).
// Privacy: only counts, task labels and minutes, road names and drill minutes are sent.

import { cleanText, postModelWithRetry } from './plan.ts';

export const SITUATION_KINDS = ['night', 'late_order', 'adult_away', 'no_car', 'slow_traffic', 'road_blocked', 'pet_hides'] as const;
export type SituationKind = (typeof SITUATION_KINDS)[number];

export interface AvailableSituation { kind: SituationKind; minParam: number; maxParam: number; defaultParam: number; title: string }
export interface SituationsInput {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { id: string; label: string; minutes: number }[];
  start: 'day' | 'night';
  drill: { roadName: string; closeMin: number | null; passMin: number; marginMin: number | null; outcome: string; backupRoadNames: string[]; mainRoadNames: string[] };
  available: AvailableSituation[];
}
export interface SituationPick { kind: SituationKind; param: number; reason: string }
export interface SituationsOutput { situations: SituationPick[]; source: 'ai' | 'fallback'; note?: string }

export const MIN_PICKS = 3;
export const MAX_PICKS = 6;
export const MAX_REASON_CHARS = 140;

/** RouteRun['outcome'] in the engine. */
/** Words about the app's inputs rather than the household (see the prompt). */
const JARGON = /\b(lists?|fields?|inputs?|data|buffer|margins?|drill)\b/i;

const OUTCOMES = ['in_time', 'short', 'never_closed'];

const clampInt = (n: unknown, max: number): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
};
/** A finite number inside [-max, max], or null (Infinity, missing or not a number). */
const finiteOrNull = (n: unknown, max: number): number | null => {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(Math.round(v * 10) / 10, -max), max) : null;
};
const num = (n: unknown, fallback: number): number => {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
};
const isKind = (k: unknown): k is SituationKind => typeof k === 'string' && (SITUATION_KINDS as readonly string[]).includes(k);

/** Keep only the fields the AI needs, with bounded sizes. Anything else in the body (address, coordinates) is dropped. */
export function sanitizeSituationsInput(body: unknown): SituationsInput {
  const b = (body ?? {}) as Record<string, any>;
  const h = b.household ?? {};
  const d = b.drill ?? {};
  const names = (a: unknown): string[] => (Array.isArray(a) ? a : []).slice(0, 8).map((n: unknown) => cleanText(n, 60)).filter((n: string) => n.length > 0);
  const seen = new Set<string>();
  const available: AvailableSituation[] = [];
  for (const a of Array.isArray(b.available) ? b.available.slice(0, 20) : []) {
    if (!a || !isKind(a.kind) || seen.has(a.kind)) continue;
    seen.add(a.kind);
    const minParam = Math.min(Math.max(num(a.minParam, 0), 0), 1000);
    const maxParam = Math.min(Math.max(num(a.maxParam, minParam), minParam), 1000);
    const defaultParam = Math.min(Math.max(num(a.defaultParam, minParam), minParam), maxParam);
    available.push({ kind: a.kind, minParam, maxParam, defaultParam, title: cleanText(a.title, 60) });
  }
  return {
    household: {
      adults: clampInt(h.adults, 20), children: clampInt(h.children, 20), needHelpMoving: clampInt(h.needHelpMoving, 20),
      dogs: clampInt(h.dogs, 20), catsAndSmallPets: clampInt(h.catsAndSmallPets, 20), cars: clampInt(h.cars, 10),
    },
    tasks: (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 20).map((t: any) => ({
      id: cleanText(t?.id, 40), label: cleanText(t?.label, 60), minutes: clampInt(t?.minutes, 240),
    })),
    start: b.start === 'night' ? 'night' : 'day',
    drill: {
      roadName: cleanText(d.roadName, 60),
      closeMin: finiteOrNull(d.closeMin, 10000),
      passMin: clampInt(d.passMin, 10000),
      marginMin: finiteOrNull(d.marginMin, 10000),
      outcome: OUTCOMES.includes(d.outcome) ? d.outcome : '',
      backupRoadNames: names(d.backupRoadNames),
      mainRoadNames: names(d.mainRoadNames),
    },
    available,
  };
}

export function fallbackSituations(note: string): SituationsOutput {
  return { situations: [], source: 'fallback', note };
}

/**
 * Turn the model's picks into safe picks: only kinds from `available`, no duplicates, param clamped
 * into the kind's range (default when not a number), at most MAX_PICKS, reason one line without digits.
 */
export function cleanPicks(raw: unknown, available: AvailableSituation[]): SituationPick[] {
  const byKind = new Map(available.map((a) => [a.kind, a]));
  const out: SituationPick[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_PICKS) break;
    const a = item && isKind(item.kind) ? byKind.get(item.kind) : undefined;
    if (!a || seen.has(a.kind)) continue;
    seen.add(a.kind);
    const p = Number(item.param);
    const param = Number.isFinite(p) ? Math.min(Math.max(Math.round(p * 10) / 10, a.minParam), a.maxParam) : a.defaultParam;
    let reason = cleanText(item.reason, 400).replace(/\s+/g, ' ');
    // The AI never states a number: a reason with a digit is dropped, the pick is kept.
    if (/\d/.test(reason)) reason = '';
    // App words are jargon to the household and talk about inputs, not people: drop that reason too.
    if (JARGON.test(reason)) reason = '';
    // One sentence only, at most MAX_REASON_CHARS: keep the first sentence, else cut at a word.
    const first = reason.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? reason;
    reason = first;
    if (reason.length > MAX_REASON_CHARS) {
      const cut = reason.slice(0, MAX_REASON_CHARS - 1);
      const space = cut.lastIndexOf(' ');
      reason = `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}.`;
    }
    out.push({ kind: a.kind, param, reason });
  }
  return out;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['situations'],
  properties: {
    situations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'param', 'reason'],
        properties: {
          kind: { type: 'string', enum: [...SITUATION_KINDS] },
          param: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You choose stress-test situations for a household's wildfire leaving drill in a practice tool. The fire stays the same; only the household's situation changes. The app computes every time and result itself: you do not compute, estimate or state any time.
- Pick ${MIN_PICKS} to ${MAX_PICKS} situations, ONLY kinds listed in "available", each at most once, ordered from most to least important for this household.
- Prefer the situations most likely to hurt this household: someone who needs help moving -> adult_away; dogs or cats -> pet_hides; a small or negative drill.marginMin -> late_order; few roads or a backup that shares roads with the main route -> road_blocked; no car -> no_car.
- param: the assumed value for that situation, inside [minParam, maxParam] of that kind. Use defaultParam unless this household gives a clear reason for a harder value.
- reason: one short plain-English sentence (under ${MAX_REASON_CHARS} characters) on why this situation matters for THIS household, based only on the counts, tasks and road names given. Talk about the household's people, pets, car and the named roads in plain everyday words. No digits, no times, no numbers. No alarm words.
- Do not mention this app or its inputs: never use words like list, field, data, input, buffer, margin, drill or backup list.
- Do not say whether the plan passes or fails, or whether this situation makes things better, worse or the same: the app works that out.`;

/**
 * Picks the situations. Never throws: every failure returns the fallback with a note.
 * opts.signal: abort the model call when the browser closed the request.
 */
export async function pickSituations(
  input: SituationsInput,
  opts: { key?: string; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<SituationsOutput> {
  const key = opts.key ?? process.env.MODEL_API_KEY;
  if (!key) return fallbackSituations('No MODEL_API_KEY set');
  if (input.available.length < MIN_PICKS) return fallbackSituations('Too few situations can apply');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await postModelWithRetry(
      key,
      { system: SYSTEM, user: JSON.stringify(input), schemaName: 'drill_situations', schema: SCHEMA },
      controller.signal,
      opts.fetchImpl ?? globalThis.fetch,
    );
    if (!res.ok) return fallbackSituations(`Model API returned ${res.status}`);
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    if (choice?.finish_reason && choice.finish_reason !== 'stop') return fallbackSituations(`Model stopped: ${choice.finish_reason}`);
    const text = choice?.message?.content;
    const parsed = typeof text === 'string' ? JSON.parse(text) : null;
    const picks = cleanPicks(parsed?.situations, input.available);
    if (picks.length < MIN_PICKS) return fallbackSituations('Model picked too few valid situations');
    return { situations: picks, source: 'ai' };
  } catch (err) {
    if (opts.signal?.aborted) return fallbackSituations('Request cancelled');
    return fallbackSituations(err instanceof Error && err.name === 'AbortError' ? 'Model API timed out' : 'Model API call failed');
  } finally {
    clearTimeout(timer);
  }
}
