// Personal plan wording. Uses Meta Model API (muse-spark-1.3, Standard mode) when
// MODEL_API_KEY is set; otherwise, or on any failure, a fixed checklist built from
// the same inputs. The AI never sets times or routes: it only words what we pass in.
// Privacy: only counts, road names, destination short names and minutes are sent.

export const PLAN_MODEL = 'muse-spark-1.3';
const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';

/** exitPoint: the destination is a point where a road leaves the area, not a place to wait or meet. */
export interface PlanRouteInput { roadNames: string[]; driveMin: number; destination: string; exitPoint: boolean }
export interface PlanInput {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { label: string; minutes: number }[];
  main: PlanRouteInput | null;
  backup: PlanRouteInput | null;
  /**
   * Latest drill on this plan; null when the fire never closed the main route.
   * onSharedStretch: the closing spot is on a stretch both routes drive, so the backup does not avoid it.
   * backupCut: in this drill the fire also closed the backup before the car could pass.
   */
  drill: { neededMin: number; closeMin: number; roadName: string; onSharedStretch: boolean; backupCut: boolean } | null;
  /**
   * When the road that may close is also on the backup route (same name, other direction):
   * the compass word for the way the backup goes on it, like "west". Empty otherwise.
   */
  backupTurn: string;
  changes: string[]; // changes the user chose on the compare screen
}
export interface PlanOutput {
  source: 'ai' | 'fallback';
  model?: string;
  whenToLeave: string;
  meetingSpot: { primary: string; ifClosed: string; reason: string };
  goBag: string[];
  thisWeek: string[];
  note?: string; // why the fallback was used
}

const clampInt = (n: unknown, max: number): number => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : 0;
};
const cleanText = (s: unknown, max = 80): string => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, max);

const COMPASS_WORDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Keep only the fields the plan needs, with bounded sizes. Anything else in the body is dropped. */
export function sanitizePlanInput(body: unknown): PlanInput {
  const b = (body ?? {}) as Record<string, any>;
  const h = b.household ?? {};
  const route = (r: any): PlanRouteInput | null => r && Array.isArray(r.roadNames)
    ? { roadNames: r.roadNames.slice(0, 8).map((n: unknown) => cleanText(n, 60)), driveMin: clampInt(r.driveMin, 600), destination: cleanText(r.destination, 60), exitPoint: r.exitPoint === true }
    : null;
  const turn = String(b.backupTurn ?? '');
  return {
    household: {
      adults: clampInt(h.adults, 20), children: clampInt(h.children, 20), needHelpMoving: clampInt(h.needHelpMoving, 20),
      dogs: clampInt(h.dogs, 20), catsAndSmallPets: clampInt(h.catsAndSmallPets, 20), cars: clampInt(h.cars, 10),
    },
    tasks: (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 20).map((t: any) => ({ label: cleanText(t?.label), minutes: clampInt(t?.minutes, 240) })),
    main: route(b.main),
    backup: route(b.backup),
    drill: b.drill
      ? {
          neededMin: clampInt(b.drill.neededMin, 1000), closeMin: clampInt(b.drill.closeMin, 1000), roadName: cleanText(b.drill.roadName, 60),
          onSharedStretch: b.drill.onSharedStretch === true, backupCut: b.drill.backupCut === true,
        }
      : null,
    backupTurn: COMPASS_WORDS.includes(turn) ? turn : '',
    changes: (Array.isArray(b.changes) ? b.changes : []).slice(0, 10).map((c: unknown) => cleanText(c, 100)),
  };
}

/** The road this plan treats as the one that may close: the drill's closing road, else the main route's second road. */
function closedRoadOf(input: PlanInput): string {
  if (input.drill?.roadName) return input.drill.roadName;
  return input.main ? input.main.roadNames[input.main.roadNames.length > 1 ? 1 : 0] ?? '' : '';
}

/** How the backup relates to the road that may close. */
type BackupCase = 'none' | 'cut' | 'shared' | 'turn' | 'other_roads';

function backupCase(input: PlanInput): BackupCase {
  const closed = closedRoadOf(input);
  if (!input.main || !input.backup || !closed) return 'none';
  if (input.drill?.backupCut) return 'cut';
  if (input.drill?.onSharedStretch) return 'shared';
  if (input.backup.roadNames.includes(closed)) return input.backupTurn ? 'turn' : 'shared';
  return 'other_roads';
}

/**
 * The sentence about the backup, built from calculated facts only. It never says
 * "If X is closed, take X": when the backup also uses X it says which way to turn,
 * and when the backup is cut too it says to follow official directions.
 */
export function backupSentence(input: PlanInput): string {
  const closed = closedRoadOf(input);
  const main = input.main;
  const backup = input.backup;
  if (!main || !backup || !closed) return '';
  switch (backupCase(input)) {
    case 'cut':
      return 'In this drill the fire closed both routes before you could pass. If that happens, follow official directions.';
    case 'shared':
      return `Both routes use ${closed}. If it is closed, follow official directions.`;
    case 'turn': {
      const i = backup.roadNames.indexOf(closed);
      const before = backup.roadNames.slice(0, i);
      const after = backup.roadNames.slice(i + 1);
      const steps: string[] = [];
      if (before.length > 0) steps.push(`take ${before.join(' to ')}`);
      steps.push(`turn ${input.backupTurn} on ${closed}`);
      if (after.length > 0) steps.push(`take ${after.join(' to ')}`);
      return `Both routes use ${closed}. If it is closed on the way to ${main.destination}, ${steps.join(', then ')} toward ${backup.destination}.`;
    }
    case 'other_roads':
      return `If ${closed} is closed, take ${backup.roadNames.join(' to ')} toward ${backup.destination}.`;
    default:
      return '';
  }
}

/** True when the backup is a usable second way past the road that may close. */
function backupUsable(input: PlanInput): boolean {
  const c = backupCase(input);
  return c === 'turn' || c === 'other_roads';
}

/** Meeting spot at a destination: none at an exit point, which is a road, not a place to wait. */
function spotAt(r: PlanRouteInput | null): string {
  return r && !r.exitPoint ? `${r.destination}, front entrance` : '';
}

function meetingReason(input: PlanInput): string {
  const main = input.main;
  if (!main) return '';
  const closed = closedRoadOf(input);
  const backup = input.backup;
  const parts: string[] = [];
  if (main.exitPoint) parts.push(`${main.destination} is where your main route leaves the area, not a place to wait. Choose a place everyone knows.`);
  else parts.push(`${main.destination} is at the end of your main route.`);
  if (backup && backupUsable(input)) {
    parts.push(backup.exitPoint
      ? `${backup.destination} is where the backup leaves the area, so choose a second place for when ${closed} is closed.`
      : `${backup.destination} is at the end of the backup, for when ${closed} is closed.`);
  }
  // When the backup is not usable the plan page shows its own note (agree on a spot, follow
  // official directions), so the reason does not repeat it.
  return parts.join(' ');
}

/** The meeting spot as calculated from the routes; the writer's wording never overrides these rules. */
function meetingSpotFor(input: PlanInput): PlanOutput['meetingSpot'] {
  return {
    primary: input.main ? spotAt(input.main) : 'A place everyone knows',
    ifClosed: backupUsable(input) ? spotAt(input.backup) : '',
    reason: meetingReason(input),
  };
}

export function fallbackPlan(input: PlanInput, note?: string): PlanOutput {
  const h = input.household;
  const routeText = (r: PlanRouteInput) => `${r.roadNames.join(' to ')} toward ${r.destination}`;
  const parts = ['Leave as soon as officials tell you to.'];
  if (h.needHelpMoving > 0 && h.adults > 1) parts.push('One adult helps the person who needs support while another gets the pets and the go-bag.');
  else if (h.needHelpMoving > 0) parts.push('Help the person who needs support to the car first.');
  if (input.main) parts.push(`Take ${routeText(input.main)}.`);
  const b = backupSentence(input);
  if (b) parts.push(b);
  const goBag = ['Medications and a list of doses', 'ID and insurance papers', 'Phone chargers', 'Water for 3 days'];
  if (h.needHelpMoving > 0) goBag.splice(1, 0, 'Mobility aids');
  if (h.dogs + h.catsAndSmallPets > 0) goBag.push('Pet carriers, leash, food');
  if (h.children > 0) goBag.push("Child's comfort item");
  if (h.cars === 0) goBag.push('Numbers of neighbors who can drive you');
  const thisWeek = input.changes.length ? [...input.changes] : [];
  if (input.backup) thisWeek.push('Drive the backup route once');
  return {
    source: 'fallback',
    whenToLeave: parts.join(' '),
    meetingSpot: meetingSpotFor(input),
    goBag,
    thisWeek,
    note,
  };
}

/**
 * The writer's "when told to leave" with any sentence about closed roads or the backup
 * replaced by the calculated backup sentence, so it cannot send anyone onto a closed road.
 */
export function withBackupSentence(text: string, input: PlanInput): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((t) => t.trim().length > 0);
  const kept = sentences.filter((t) => !/\b(closed|closes|blocked|cut|backup|official directions)\b/i.test(t));
  const b = backupSentence(input);
  return [...kept, ...(b ? [b] : [])].join(' ');
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['whenToLeave', 'meetingSpot', 'goBag', 'thisWeek'],
  properties: {
    whenToLeave: { type: 'string' },
    meetingSpot: {
      type: 'object', additionalProperties: false, required: ['primary', 'ifClosed', 'reason'],
      properties: { primary: { type: 'string' }, ifClosed: { type: 'string' }, reason: { type: 'string' } },
    },
    goBag: { type: 'array', items: { type: 'string' } },
    thisWeek: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You write a household's wildfire leaving plan for a practice tool. The facts you receive (routes, minutes, household counts) were calculated by the app; do not change, add or invent times, distances, roads, destinations, shelters or official instructions. Plain, calm English. Short sentences. No alarm words.
- whenToLeave: 2-3 sentences. Start with "Leave as soon as officials tell you to." Say who does what for this household, then the main route by road names. Do not write about closed roads or the backup route: the app adds that sentence itself.
- meetingSpot: primary is the main destination's front entrance, ifClosed the backup destination's front entrance. Use an empty string for a destination with exitPoint true (it is a road leaving the area, not a place to meet), for ifClosed when there is no backup, and for ifClosed when drill.onSharedStretch or drill.backupCut is true. reason: one sentence that only says which route each place is at the end of. Do not describe the places (size, parking, ease, safety).
- goBag: 5-8 items fitted to this household (people needing help, pets, children, no car).
- thisWeek: up to 4 concrete tasks; include the user's chosen changes, worded as actions. Only preparation the household does at home or on the routes given; no advice about official procedures.
Destinations are candidate places, not confirmed shelters; never call them shelters.`;

function validOutput(o: any): o is Omit<PlanOutput, 'source'> {
  return o && typeof o.whenToLeave === 'string' && o.whenToLeave.length > 0 && o.meetingSpot && typeof o.meetingSpot.primary === 'string'
    && Array.isArray(o.goBag) && o.goBag.every((x: unknown) => typeof x === 'string') && Array.isArray(o.thisWeek);
}

async function callModel(key: string, input: PlanInput, effort: string | null, signal: AbortSignal): Promise<Response> {
  const body: Record<string, unknown> = {
    model: PLAN_MODEL,
    max_completion_tokens: 4000,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: JSON.stringify(input) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'leaving_plan', strict: true, schema: SCHEMA } },
  };
  if (effort) body.reasoning_effort = effort;
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Writes the plan. Never throws: every failure returns the fallback with a note.
 * opts.signal: abort the model call when the browser no longer wants this plan (it closed the request).
 */
export async function writePlan(
  input: PlanInput,
  opts: { key?: string; timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PlanOutput> {
  const key = opts.key ?? process.env.MODEL_API_KEY;
  if (!key) return fallbackPlan(input, 'No MODEL_API_KEY set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    // Low reasoning effort keeps this fast and cheap; retry once without it if the API rejects the value.
    let res = await callModel(key, input, 'low', controller.signal);
    if (res.status === 400) res = await callModel(key, input, null, controller.signal);
    if (!res.ok) return fallbackPlan(input, `Model API returned ${res.status}`);
    const data: any = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content;
    if (choice?.finish_reason && choice.finish_reason !== 'stop') return fallbackPlan(input, `Model stopped: ${choice.finish_reason}`);
    const parsed = typeof text === 'string' ? JSON.parse(text) : null;
    if (!validOutput(parsed)) return fallbackPlan(input, 'Model output did not match the plan format');
    // Meeting spots follow the calculated rules when a destination is an exit point or the backup is not usable.
    const rules = meetingSpotFor(input);
    const strict = !!input.main?.exitPoint || !!input.backup?.exitPoint || !backupUsable(input);
    return {
      source: 'ai',
      model: PLAN_MODEL,
      whenToLeave: withBackupSentence(cleanText(parsed.whenToLeave, 800), input),
      meetingSpot: strict
        ? rules
        : { primary: cleanText(parsed.meetingSpot.primary, 120), ifClosed: cleanText(parsed.meetingSpot.ifClosed, 120), reason: cleanText(parsed.meetingSpot.reason, 300) },
      goBag: parsed.goBag.slice(0, 10).map((s: string) => cleanText(s, 100)),
      thisWeek: parsed.thisWeek.slice(0, 6).map((s: string) => cleanText(s, 120)),
    };
  } catch (err) {
    if (opts.signal?.aborted) return fallbackPlan(input, 'Request cancelled');
    return fallbackPlan(input, err instanceof Error && err.name === 'AbortError' ? 'Model API timed out' : 'Model API call failed');
  } finally {
    clearTimeout(timer);
  }
}
