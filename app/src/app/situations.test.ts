import { describe, expect, it } from 'vitest';
import { buildSituationsRequest, situationsKey, specsFromResponse, withEditedParams } from './situations';
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
