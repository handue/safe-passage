// Personal plan wording. Uses Meta Model API (muse-spark-1.3, Standard mode) when
// MODEL_API_KEY is set; otherwise, or on any failure, a fixed checklist built from
// the same inputs. The AI never sets times or routes: it only words what we pass in.
// Privacy: only counts, road names, destination short names and minutes are sent.

export const PLAN_MODEL = 'muse-spark-1.3';
const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';

export interface PlanRouteInput { roadNames: string[]; driveMin: number; destination: string }
export interface PlanInput {
  household: { adults: number; children: number; needHelpMoving: number; dogs: number; catsAndSmallPets: number; cars: number };
  tasks: { label: string; minutes: number }[];
  main: PlanRouteInput | null;
  backup: PlanRouteInput | null;
  /** Latest drill on this plan; null when the fire never closed a route. */
  /** onSharedStretch: that road is on the stretch both routes share, so the backup does not avoid it. */
  drill: { neededMin: number; closeMin: number; roadName: string; onSharedStretch: boolean } | null;
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

/** Keep only the fields the plan needs, with bounded sizes. Anything else in the body is dropped. */
export function sanitizePlanInput(body: unknown): PlanInput {
  const b = (body ?? {}) as Record<string, any>;
  const h = b.household ?? {};
  const route = (r: any): PlanRouteInput | null => r && Array.isArray(r.roadNames)
    ? { roadNames: r.roadNames.slice(0, 8).map((n: unknown) => cleanText(n, 60)), driveMin: clampInt(r.driveMin, 600), destination: cleanText(r.destination, 60) }
    : null;
  return {
    household: {
      adults: clampInt(h.adults, 20), children: clampInt(h.children, 20), needHelpMoving: clampInt(h.needHelpMoving, 20),
      dogs: clampInt(h.dogs, 20), catsAndSmallPets: clampInt(h.catsAndSmallPets, 20), cars: clampInt(h.cars, 10),
    },
    tasks: (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 20).map((t: any) => ({ label: cleanText(t?.label), minutes: clampInt(t?.minutes, 240) })),
    main: route(b.main),
    backup: route(b.backup),
    drill: b.drill ? { neededMin: clampInt(b.drill.neededMin, 1000), closeMin: clampInt(b.drill.closeMin, 1000), roadName: cleanText(b.drill.roadName, 60), onSharedStretch: b.drill.onSharedStretch === true } : null,
    changes: (Array.isArray(b.changes) ? b.changes : []).slice(0, 10).map((c: unknown) => cleanText(c, 100)),
  };
}

/** The road this plan treats as the one that may close: the drill's closing road, else the main route's second road. */
function closedRoadOf(input: PlanInput): string {
  if (input.drill?.roadName) return input.drill.roadName;
  return input.main ? input.main.roadNames[input.main.roadNames.length > 1 ? 1 : 0] ?? '' : '';
}

export function fallbackPlan(input: PlanInput, note?: string): PlanOutput {
  const h = input.household;
  const closed = closedRoadOf(input);
  // When the closing road is on the shared stretch, the backup is cut too: no backup spot to offer.
  const backupCut = input.drill?.onSharedStretch === true;
  const routeText = (r: PlanRouteInput) => `${r.roadNames.join(' to ')} toward ${r.destination}`;
  const parts = ['Leave as soon as officials tell you to.'];
  if (h.needHelpMoving > 0 && h.adults > 1) parts.push('One adult helps the person who needs support while another gets the pets and the go-bag.');
  else if (h.needHelpMoving > 0) parts.push('Help the person who needs support to the car first.');
  if (input.main) parts.push(`Take ${routeText(input.main)}.`);
  if (input.backup && input.main && closed) {
    parts.push(backupCut ? `Both routes use ${closed}. If it is closed, follow official directions.` : `If ${closed} is closed, take ${input.backup.roadNames.join(' to ')}.`);
  }
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
    meetingSpot: {
      primary: input.main ? `${input.main.destination}, front entrance` : 'A place everyone knows',
      ifClosed: input.backup && !backupCut ? `${input.backup.destination}, front entrance` : '',
      reason: !input.main
        ? ''
        : backupCut
          ? `${input.main.destination} is at the end of your main route. Both routes use ${closed}, so there is no backup meeting spot past it.`
          : `${input.main.destination} is at the end of your main route${input.backup ? `; ${input.backup.destination} is at the end of the backup, for when ${closed} is closed` : ''}.`,
    },
    goBag,
    thisWeek,
    note,
  };
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
- whenToLeave: 2-4 sentences. Start with "Leave as soon as officials tell you to." Say who does what for this household, then the main route by road names and, if given, the backup.
- meetingSpot: primary is the main destination's front entrance, ifClosed the backup destination's front entrance (empty string if no backup, or if drill.onSharedStretch is true, because then the backup also uses drill.roadName). When drill is given, "closed" means drill.roadName. reason: one sentence that only says which route each place is at the end of. Do not describe the places (size, parking, ease, safety).
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

/** Writes the plan. Never throws: every failure returns the fallback with a note. */
export async function writePlan(input: PlanInput, opts: { key?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<PlanOutput> {
  const key = opts.key ?? process.env.MODEL_API_KEY;
  if (!key) return fallbackPlan(input, 'No MODEL_API_KEY set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
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
    return {
      source: 'ai',
      model: PLAN_MODEL,
      whenToLeave: cleanText(parsed.whenToLeave, 800),
      meetingSpot: { primary: cleanText(parsed.meetingSpot.primary, 120), ifClosed: cleanText(parsed.meetingSpot.ifClosed, 120), reason: cleanText(parsed.meetingSpot.reason, 300) },
      goBag: parsed.goBag.slice(0, 10).map((s: string) => cleanText(s, 100)),
      thisWeek: parsed.thisWeek.slice(0, 6).map((s: string) => cleanText(s, 120)),
    };
  } catch (err) {
    return fallbackPlan(input, err instanceof Error && err.name === 'AbortError' ? 'Model API timed out' : 'Model API call failed');
  } finally {
    clearTimeout(timer);
  }
}
