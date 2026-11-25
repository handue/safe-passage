import { describe, expect, it } from 'vitest';
import { backupUsable, closureFacts, destFireLine, driveText, fullDest, ifClosedHeading, shortDest, withPlaceNames } from './PlanScreen';
import { exitPointName } from '../engine/drill';
import type { DrillRun } from '../engine/drill';
import type { Destination, RoadGraph, Route, RouteRun } from '../engine/types';

// A small road graph: home (0) on Main St, east to 1 and on to 2 (D1); west to 3 and on to 4 (D2).
function graph(): RoadGraph {
  const nodes = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 1500, y: 0 }, { x: -500, y: 0 }, { x: -1500, y: 0 }].map((xy, id) => ({ id, xy, osmId: id }));
  const edge = (id: number, from: number, to: number, name: string) => ({
    id, from, to, name, highway: 'primary', lengthM: 500, minutes: 1, shape: [nodes[from].xy, nodes[to].xy],
  });
  return { nodes, edges: [edge(0, 0, 1, 'Main St'), edge(1, 1, 2, 'Creek Rd'), edge(2, 0, 3, 'Main St'), edge(3, 3, 4, 'Ridge Rd')] } as unknown as RoadGraph;
}
const main: Route = { destinationId: 'a', edgeIds: [0, 1], lengthM: 1000, driveMin: 2, roadNames: ['Main St', 'Creek Rd'] };
const backup: Route = { destinationId: 'b', edgeIds: [2, 3], lengthM: 1000, driveMin: 2, roadNames: ['Main St', 'Ridge Rd'] };

function run(bindingEdge: number, bindingName: string, backupOutcome: 'never_closed' | 'in_time' | 'short', at = { x: 400, y: 0 }): DrillRun {
  const binding = { edgeId: bindingEdge, name: bindingName, closeMin: 10, passMin: 12, marginMin: -2, xy: at };
  return {
    main: { route: main, departMin: 10, legs: [], binding, outcome: 'short', arriveMin: 12 },
    backup: { route: backup, departMin: 10, legs: [], binding: backupOutcome === 'never_closed' ? null : binding, outcome: backupOutcome, arriveMin: 12 },
  } as unknown as DrillRun;
}

describe('plan closure facts', () => {
  it('finds the way to turn when both routes use the closing road on different segments', () => {
    const f = closureFacts(graph(), run(0, 'Main St', 'in_time'), main, backup);
    expect(f).toEqual({ onSharedStretch: false, backupCut: false, backupTurn: 'west', mainTurn: 'east' });
    expect(backupUsable(f, 'Main St', backup)).toBe(true);
    expect(ifClosedHeading(f, 'Main St')).toBe('If the way east on Main St is closed');
  });

  it('treats a closure at the junction as shared when the backup goes the other way on the same road', () => {
    // The fire closes Main St 50 m from home, where both routes turn onto it (demo: Central Avenue).
    const f = closureFacts(graph(), run(0, 'Main St', 'in_time', { x: 50, y: 0 }), main, backup);
    expect(f.onSharedStretch).toBe(true);
    expect(f.backupTurn).toBe('');
    expect(backupUsable(f, 'Main St', backup)).toBe(false);
    expect(ifClosedHeading(f, 'Main St')).toBe('If Main St is closed');
  });

  it('marks the backup cut when the drill closed it too', () => {
    const f = closureFacts(graph(), run(1, 'Creek Rd', 'short'), main, backup);
    expect(f.backupCut).toBe(true);
    expect(backupUsable(f, 'Creek Rd', backup)).toBe(false);
  });

  it('marks a shared stretch when the backup drives the closing segment', () => {
    const shared: Route = { ...backup, edgeIds: [0, 3] };
    const f = closureFacts(graph(), run(0, 'Main St', 'in_time'), main, shared);
    expect(f.onSharedStretch).toBe(true);
    expect(f.backupTurn).toBe('');
    expect(backupUsable(f, 'Main St', shared)).toBe(false);
  });

  it('treats a backup on other roads as usable', () => {
    const f = closureFacts(graph(), run(1, 'Creek Rd', 'never_closed'), main, backup);
    expect(f).toEqual({ onSharedStretch: false, backupCut: false, backupTurn: '', mainTurn: '' });
    expect(backupUsable(f, 'Creek Rd', backup)).toBe(true);
  });
});

describe('plan destination labels', () => {
  const exit: Destination = { id: 'exit-9', label: 'D1 Exit point', name: 'Exit point, Pacific Coast Highway', kind: 'exit_point', xy: { x: 0, y: 0 }, nodeId: 9 };
  const school: Destination = { id: 's', label: 'D2 School', name: 'Ridgeview High School', kind: 'school', xy: { x: 0, y: 0 }, nodeId: 3 };

  it('says an exit point once, as where the road leaves the area', () => {
    expect(shortDest(exit)).toBe('D1 Exit point');
    expect(fullDest(exit)).toBe('D1, where Pacific Coast Highway leaves the area');
    expect(fullDest(school)).toBe('D2 School (Ridgeview High School)');
  });

  it('drops "front entrance" after an exit point and restores place names', () => {
    const data = {
      source: 'ai' as const, goBag: [], thisWeek: [],
      whenToLeave: 'Take Main St toward D1 Exit point.',
      meetingSpot: { primary: 'D1 Exit point front entrance', ifClosed: 'D2 School, front entrance', reason: '' },
    };
    const out = withPlaceNames(data, [exit, school]);
    expect(out.whenToLeave).toBe('Take Main St toward D1, where Pacific Coast Highway leaves the area.');
    expect(out.meetingSpot.primary).toBe('D1, where Pacific Coast Highway leaves the area');
    expect(out.meetingSpot.ifClosed).toBe('D2 School (Ridgeview High School), front entrance');
  });

  it('says an engine-named exit point once (no "where where")', () => {
    const named: Destination = { ...exit, name: exitPointName('Pacific Coast Highway') };
    expect(fullDest(named)).toBe('D1, where Pacific Coast Highway leaves the area');
    const out = withPlaceNames({ source: 'ai', goBag: [], thisWeek: [], whenToLeave: 'Take PCH toward D1 Exit point.', meetingSpot: { primary: '', ifClosed: '', reason: '' } }, [named]);
    expect(out.whenToLeave).toBe('Take PCH toward D1, where Pacific Coast Highway leaves the area.');
  });

  it('words the fire at a destination from the run', () => {
    const rr = { arriveMin: 31.2, destinationFire: { fireMin: 58, beforeArrival: false, inGrid: true } } as unknown as RouteRun;
    expect(destFireLine(rr, 'D1 School (Ridgeview High School)')).toBe('The simulated fire reaches D1 School (Ridgeview High School) at T+58, after you would arrive at T+31.');
    expect(destFireLine({ ...rr, destinationFire: { fireMin: Infinity, beforeArrival: false, inGrid: true } } as RouteRun, 'D1')).toBeNull();
  });

  it('words a drive under a minute', () => {
    expect(driveText(0.4)).toBe('under 1 min');
    expect(driveText(9.2)).toBe('9 min');
  });
});
