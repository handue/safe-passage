// Pure helpers for "Other situations, same fire": the key of the base drill, the body sent to
// the situation picker (counts, task names, road names and drill times only), and how its
// answer becomes the specs the engine runs. No React, no fetch.
import type { DrillRun, HouseholdCounts, PreparedForDrill } from '../engine/drill';
import type { DrillSetup, Task } from '../engine/types';
import { SITUATIONS, clampParam, runSituations, type SituationKind, type SituationResult, type SituationSpec } from '../engine/situations';
import type { SituationsRequest, SituationsResponse } from './api';

const MAX_TASKS = 20;
const MAX_LABEL = 60;

export type EditedParams = Partial<Record<SituationKind, number>>;

/** Identifies the base drill: the fire setup, the household's own tasks and its counts. */
export function situationsKey(setup: DrillSetup, tasks: Task[], h: HouseholdCounts): string {
  return JSON.stringify({
    i: [setup.ignition.x, setup.ignition.y],
    w: [setup.wind.fromDeg, setup.wind.speedMph],
    s: setup.start,
    seed: setup.seed,
    t: tasks.map((t) => [t.id, t.minutes]),
    h: [h.adults, h.children, h.needHelpMoving, h.dogs, h.catsAndSmallPets, h.cars],
  });
}

/** Task name as the picker gets it: built-in names as they are; tasks the user typed become "Another task". */
const pickerLabel = (t: Task) => (t.id.startsWith('custom-') ? 'Another task' : t.label).slice(0, MAX_LABEL);

const round = (n: number) => Math.round(n);
const finiteOrNull = (n: number) => (Number.isFinite(n) ? round(n) : null);

/** The request body. Only counts, task names and minutes, road names and drill minutes: never the address or coordinates. */
export function buildSituationsRequest(h: HouseholdCounts, tasks: Task[], base: DrillRun, available: SituationKind[]): SituationsRequest {
  const main = base.main;
  const b = main?.binding ?? null;
  return {
    household: {
      adults: h.adults,
      children: h.children,
      needHelpMoving: h.needHelpMoving,
      dogs: h.dogs,
      catsAndSmallPets: h.catsAndSmallPets,
      cars: h.cars,
    },
    tasks: tasks.slice(0, MAX_TASKS).map((t) => ({ id: t.id.startsWith('custom-') ? 'custom' : t.id, label: pickerLabel(t), minutes: round(t.minutes) })),
    start: base.setup.start,
    drill: {
      roadName: b?.name ?? '',
      closeMin: b ? finiteOrNull(b.closeMin) : null,
      passMin: b ? round(b.passMin) : main ? round(main.arriveMin) : 0,
      marginMin: b ? finiteOrNull(b.marginMin) : null,
      outcome: main?.outcome ?? 'never_closed',
      backupRoadNames: base.backup?.route.roadNames ?? [],
      mainRoadNames: main?.route.roadNames ?? [],
    },
    available: available.map((kind) => {
      const info = SITUATIONS[kind];
      return { kind, minParam: info.minParam, maxParam: info.maxParam, defaultParam: info.defaultParam, title: info.title };
    }),
  };
}

/**
 * Specs from the picker's answer: only kinds the engine said can apply, once each, params clamped.
 * Fewer than 3 usable picks, or a fallback answer, keep the rules specs.
 */
export function specsFromResponse(
  res: SituationsResponse,
  available: SituationKind[],
  rules: SituationSpec[],
): { specs: SituationSpec[]; source: 'ai' | 'rules'; note?: string } {
  const allowed = new Set<string>(available);
  const seen = new Set<string>();
  const specs: SituationSpec[] = [];
  if (res.source === 'ai') {
    for (const s of res.situations) {
      if (!s || typeof s.kind !== 'string' || !allowed.has(s.kind) || seen.has(s.kind)) continue;
      const kind = s.kind as SituationKind;
      seen.add(kind);
      const p = typeof s.param === 'number' && Number.isFinite(s.param) ? s.param : SITUATIONS[kind].defaultParam;
      const reason = typeof s.reason === 'string' && s.reason.trim() && !/\d/.test(s.reason) ? s.reason.trim().slice(0, 140) : undefined;
      specs.push({ kind, param: clampParam(kind, p), reason, source: 'ai' });
      if (specs.length >= 6) break;
    }
  }
  if (specs.length < 3) return { specs: rules, source: 'rules', note: res.note };
  return { specs, source: 'ai' };
}

/** Specs with the values the user typed in place of the assumed ones (clamped to each kind's range). */
export function withEditedParams(specs: SituationSpec[], edited: EditedParams): SituationSpec[] {
  return specs.map((s) => {
    const p = edited[s.kind];
    return p === undefined ? s : { ...s, param: clampParam(s.kind, p) };
  });
}

/** Runs the situations, or none when there is no base run. Never throws for the screens. */
export function safeRunSituations(prepared: PreparedForDrill | null, base: DrillRun | null, tasks: Task[], specs: SituationSpec[]): SituationResult[] {
  if (!prepared || !base || specs.length === 0) return [];
  try {
    return runSituations(prepared, base, tasks, specs);
  } catch (e) {
    console.error('runSituations failed', e);
    return [];
  }
}
