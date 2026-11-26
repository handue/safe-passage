import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM,
  buildInterpretRequest,
  buildSituationsRequest,
  cleanSituationText,
  customFromDraft,
  customFromPick,
  draftFromResponse,
  fallbackTitle,
  pickableKinds,
  rebaseCustom,
  rowKey,
  situationsKey,
  specsFromResponse,
  withEditedParams,
} from './situations';
import type { InterpretResponse } from './api';
import type { DrillRun } from '../engine/drill';
import type { DrillSetup, RouteRun, Task } from '../engine/types';
import type { SituationSpec } from '../engine/situations';

const h = { adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 0, cars: 1 };
const tasks: Task[] = [
  { id: 'gather', label: 'Gather everyone', minutes: 4, source: 'estimate' },
  { id: 'custom-1', label: 'Get Grandma Rose from 12 Oak St', minutes: 5, source: 'estimate' },
];
const setup: DrillSetup = { ignition: { x: 120, y: -340 }, wind: { fromDeg: 45, speedMph: 25, source: 'manual' }, start: 'day', seed: 1 };

function run(binding: RouteRun['binding'], outcome: RouteRun['outcome']): DrillRun {
  const route = { destinationId: 'd1', edgeIds: [1], lengthM: 1000, driveMin: 4, roadNames: ['Oak St', 'Highway 9'] };
  const main = { route, departMin: 9, legs: [], binding, outcome, arriveMin: 13.4 } as RouteRun;
  const backup = { ...main, route: { ...route, roadNames: ['Pine Rd'] } } as RouteRun;
  return { setup, main, backup, coverage: {} } as unknown as DrillRun;
}

const short = run({ edgeId: 1, name: 'Highway 9', closeMin: 10.4, passMin: 12.6, marginMin: -2.2, xy: { x: 55, y: 66 } }, 'short');

describe('buildSituationsRequest', () => {
  it('sends counts, task names, road names and drill minutes only: no address, coordinates or user-typed task names', () => {
    const body = buildSituationsRequest(h, tasks, short, ['late_order', 'night']);
    const text = JSON.stringify(body);
    expect(Object.keys(body).sort()).toEqual(['available', 'drill', 'household', 'start', 'tasks']);
    expect(text).not.toMatch(/"(lat|lon|x|y|xy|ignition|address|addressLabel|home)"/);
    expect(text).not.toContain('Grandma');
    expect(body.tasks[1]).toEqual({ id: 'custom', label: 'Another task', minutes: 5 });
    expect(body.drill).toEqual({ roadName: 'Highway 9', closeMin: 10, passMin: 13, marginMin: -2, outcome: 'short', backupRoadNames: ['Pine Rd'], mainRoadNames: ['Oak St', 'Highway 9'] });
    expect(body.available.map((a) => a.kind)).toEqual(['late_order', 'night']);
    expect(body.available[0]).toMatchObject({ minParam: 5, maxParam: 30, defaultParam: 10 });
  });

  it('sends null closure minutes when the fire never closed the road', () => {
    const body = buildSituationsRequest(h, tasks, run(null, 'never_closed'), []);
    expect(body.drill).toMatchObject({ roadName: '', closeMin: null, marginMin: null, passMin: 13, outcome: 'never_closed' });
    expect(JSON.stringify(body)).not.toContain('Infinity');
  });

  it('keeps at most 20 tasks with labels up to 60 characters', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, label: 'x'.repeat(80), minutes: 1, source: 'estimate' as const }));
    const body = buildSituationsRequest(h, many, short, []);
    expect(body.tasks).toHaveLength(20);
    expect(body.tasks[0].label).toHaveLength(60);
  });
});

describe('situationsKey', () => {
  it('changes with the fire, the tasks or the household, and not otherwise', () => {
    const k = situationsKey(setup, tasks, h);
    expect(situationsKey({ ...setup }, [...tasks], { ...h })).toBe(k);
    expect(situationsKey({ ...setup, seed: 2 }, tasks, h)).not.toBe(k);
    expect(situationsKey(setup, [{ ...tasks[0], minutes: 5 }, tasks[1]], h)).not.toBe(k);
    expect(situationsKey(setup, tasks, { ...h, dogs: 0 })).not.toBe(k);
  });
});

describe('specsFromResponse', () => {
  const rules: SituationSpec[] = [{ kind: 'late_order', param: 10, source: 'rules' }];
  const available = ['late_order', 'night', 'pet_hides', 'adult_away'] as const;

  it('keeps only available kinds once each, clamps params and drops reasons with digits', () => {
    const out = specsFromResponse(
      {
        source: 'ai',
        situations: [
          { kind: 'pet_hides', param: 99, reason: 'Your dog may hide.' },
          { kind: 'pet_hides', param: 5, reason: 'again' },
          { kind: 'no_car', param: 10, reason: 'not available' },
          { kind: 'late_order', param: 15, reason: 'Orders can come 20 minutes late.' },
          { kind: 'night', param: 2, reason: '' },
        ],
      },
      [...available],
      rules,
    );
    expect(out.source).toBe('ai');
    expect(out.specs).toEqual([
      { kind: 'pet_hides', param: 30, reason: 'Your dog may hide.', source: 'ai' },
      { kind: 'late_order', param: 15, reason: undefined, source: 'ai' },
      { kind: 'night', param: 2, reason: undefined, source: 'ai' },
    ]);
  });

  it('keeps the rules picks on a fallback answer or fewer than 3 usable picks', () => {
    expect(specsFromResponse({ source: 'fallback', situations: [], note: 'no key' }, [...available], rules)).toEqual({ specs: rules, source: 'rules', note: 'no key' });
    const two = specsFromResponse({ source: 'ai', situations: [{ kind: 'night', param: 3, reason: '' }, { kind: 'late_order', param: 9, reason: '' }] }, [...available], rules);
    expect(two.specs).toBe(rules);
    expect(two.source).toBe('rules');
  });
});

describe('withEditedParams', () => {
  it('puts the user value in place, clamped, and keeps the source', () => {
    const specs: SituationSpec[] = [{ kind: 'late_order', param: 10, source: 'ai', reason: 'r' }, { kind: 'night', param: 3, source: 'ai' }];
    expect(withEditedParams(specs, { late_order: 50 })).toEqual([{ kind: 'late_order', param: 30, source: 'ai', reason: 'r' }, specs[1]]);
  });
});

describe('buildInterpretRequest', () => {
  it('sends only the text, household counts, tasks and available kinds: never address or coordinates', () => {
    const body = buildInterpretRequest('  My partner   is at work\n and has the car ', { ...h, addressLabel: '12 Oak St', lat: 37.1, lon: -122.1 } as typeof h, tasks, ['adult_away', 'no_car']);
    expect(Object.keys(body).sort()).toEqual(['available', 'household', 'tasks', 'text']);
    expect(Object.keys(body.household).sort()).toEqual(['adults', 'cars', 'catsAndSmallPets', 'children', 'dogs', 'needHelpMoving']);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/"(lat|lon|x|y|xy|ignition|address|addressLabel|home|label_?full)"/);
    expect(text).not.toContain('Oak St');
    expect(text).not.toContain('Grandma');
    expect(body.text).toBe('My partner is at work and has the car');
    // The id stays so the reader can change a task's minutes; the typed name does not.
    expect(body.tasks).toEqual([
      { id: 'gather', label: 'Gather everyone', minutes: 4 },
      { id: 'custom-1', label: 'Another task', minutes: 5 },
    ]);
    expect(body.available).toEqual([
      { kind: 'adult_away', title: 'One adult away', minParam: 1.2, maxParam: 2, defaultParam: 1.5 },
      { kind: 'no_car', title: 'Car not available', minParam: 5, maxParam: 30, defaultParam: 10 },
    ]);
  });

  it('caps the text at 200 characters and tasks at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, label: 't', minutes: 1, source: 'estimate' as const }));
    const body = buildInterpretRequest('a'.repeat(300), h, many, []);
    expect(body.text).toHaveLength(200);
    expect(body.tasks).toHaveLength(20);
  });
});

describe('cleanSituationText and fallbackTitle', () => {
  it('collapses spaces and drops digits from the fallback title', () => {
    expect(cleanSituationText('  a \t b  ')).toBe('a b');
    expect(fallbackTitle('We have 2 horses and 1 trailer to hitch before we can leave home')).toBe('We have horses and trailer to hitch befo');
    expect(fallbackTitle('123')).toBe('Your situation');
  });
});

describe('draftFromResponse', () => {
  const res = (patch: Partial<InterpretResponse>): InterpretResponse => ({
    status: 'ok',
    title: 'Partner away with the car',
    parts: { situations: [], addTasks: [], taskMinutes: {} },
    cannotModel: '',
    ...patch,
  });

  it('makes a card with sanitized parts: unknown kinds and task ids dropped, values clamped', () => {
    const out = draftFromResponse(
      res({
        title: 'Partner away 2 days',
        parts: {
          situations: [{ kind: 'adult_away', param: 9 }, { kind: 'teleport', param: 1 }, { kind: 'no_car', param: 12 }],
          addTasks: [{ label: 'Hitch the horse trailer', minutes: 90 }],
          taskMinutes: { gather: 7, nope: 3 },
        },
        cannotModel: 'Where your partner works.',
      }),
      'My partner is at work and has the car',
      tasks,
    );
    expect(out.kind).toBe('card');
    if (out.kind !== 'card') return;
    expect(out.draft.title).toBe('Partner away days');
    expect(out.draft.titleSource).toBe('ai');
    expect(out.draft.cannotModel).toBe('Where your partner works.');
    expect(out.draft.parts).toEqual({
      situations: [{ kind: 'adult_away', param: 2 }, { kind: 'no_car', param: 12 }],
      addTasks: [{ label: 'Hitch the horse trailer', minutes: 60 }],
      taskMinutes: { gather: 7 },
    });
  });

  it('reads nothing usable as unmeasurable and a fallback as fallback', () => {
    expect(draftFromResponse(res({ parts: { situations: [{ kind: 'teleport', param: 1 }], addTasks: [], taskMinutes: {} }, cannotModel: 'Weather.' }), 'x', tasks)).toEqual({
      kind: 'unmeasurable',
      cannotModel: 'Weather.',
    });
    expect(draftFromResponse(res({ status: 'unmeasurable', cannotModel: 'Feelings.' }), 'x', tasks)).toEqual({ kind: 'unmeasurable', cannotModel: 'Feelings.' });
    expect(draftFromResponse(res({ status: 'fallback', note: 'no key' }), 'x', tasks)).toEqual({ kind: 'fallback', note: 'no key' });
  });

  it('uses the typed text for the title when the AI gave none', () => {
    const out = draftFromResponse(res({ title: '42', parts: { situations: [{ kind: 'late_order', param: 20 }], addTasks: [], taskMinutes: {} } }), 'Order comes 20 min late', tasks);
    expect(out.kind === 'card' && out.draft.title).toBe('Order comes min late');
    // A title made from the user's words is theirs, not AI-written.
    expect(out.kind === 'card' && out.draft.titleSource).toBe('user');
    const fromServer = draftFromResponse(res({ title: 'Order comes min late', titleFromText: true, parts: { situations: [{ kind: 'late_order', param: 20 }], addTasks: [], taskMinutes: {} } }), 'Order comes 20 min late', tasks);
    expect(fromServer.kind === 'card' && fromServer.draft.titleSource).toBe('user');
  });

  it('takes numbers out of the AI-written "not measured" text', () => {
    expect(draftFromResponse(res({ status: 'unmeasurable', cannotModel: 'You will be 8 min short.' }), 'x', tasks)).toEqual({ kind: 'unmeasurable', cannotModel: 'You will be short.' });
  });
});

describe('rebaseCustom', () => {
  it('rebases a typed task change onto the fixed task and leaves other rows as they are', () => {
    const base: Task[] = [{ id: 'help', label: 'Help', minutes: 6, source: 'estimate' }];
    const fixed: Task[] = [{ id: 'help', label: 'Help', minutes: 2, source: 'estimate' }];
    const a = { id: 'a', text: '', title: 'A', titleSource: 'user' as const, parts: { situations: [], addTasks: [], taskMinutes: { help: 10 } } };
    const b = { id: 'b', text: '', title: 'B', titleSource: 'user' as const, parts: { situations: [{ kind: 'night' as const, param: 5 }], addTasks: [], taskMinutes: {} } };
    const [ra, rb] = rebaseCustom([a, b], base, fixed);
    expect(ra.parts.taskMinutes).toEqual({ help: 3 });
    expect(rb).toBe(b);
  });
});

describe('custom rows', () => {
  it('a pick uses the kind title and starting value; a draft keeps its title or falls back to the text', () => {
    expect(customFromPick('pet_hides', 'own-a')).toEqual({
      id: 'own-a',
      text: '',
      title: 'A pet hides',
      titleSource: 'user',
      parts: { situations: [{ kind: 'pet_hides', param: 10 }], addTasks: [], taskMinutes: {} },
    });
    const parts = { situations: [], addTasks: [{ label: 'Hitch', minutes: 15 }], taskMinutes: {} };
    expect(customFromDraft({ text: 'We also have a trailer', title: '  ', titleSource: 'user', parts, cannotModel: '' }, 'own-b').title).toBe('We also have a trailer');
    expect(MAX_CUSTOM).toBe(5);
  });

  it('pickable kinds: applicable, not in the table, not already picked alone', () => {
    const shown: SituationSpec[] = [{ kind: 'late_order', param: 10, source: 'rules' }];
    const picked = [customFromPick('night', 'own-c')];
    expect(pickableKinds(['late_order', 'night', 'pet_hides', 'no_car'], shown, picked)).toEqual(['pet_hides', 'no_car']);
  });

  it('row keys: the custom id, else the kind', () => {
    expect(rowKey({ spec: { kind: 'night' }, custom: { id: 'own-d' } } as never)).toBe('own-d');
    expect(rowKey({ spec: { kind: 'night' } } as never)).toBe('night');
  });
});
