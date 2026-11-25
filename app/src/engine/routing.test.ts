import { describe, expect, it } from 'vitest';
import { buildGraph, UNNAMED_ROAD } from './graph';
import { pathEdges, routeFromEdges, shortestTimes } from './routing';
import type { Projection, RawRoadWay, RoadGraph } from './types';

const flat: Projection = {
  origin: { lat: 0, lon: 0 },
  toXY: (p) => ({ x: p.lon, y: p.lat }),
  toLatLon: (p) => ({ lat: p.y, lon: p.x }),
};

const MPM = 26.8224;
const R = 100 / (25 * MPM); // 100 m residential
const P = 100 / (50 * MPM); // 100 m primary
const S = 100 / (15 * MPM); // 100 m at 15 mph

// 3x3 grid, 100 m spacing. OSM node id = row * 3 + col + 1, at (100*col, 100*row).
//   7 - 8 - 9    row 2: unnamed residential
//   |   ^   |
//   4 - 5 - 6    row 1: Middle St
//   |   ^   |
//   1 - 2 - 3    row 0: Low Rd (primary)
// col 0: West Ave, col 1: Center St (oneway north), col 2: East Ave (15 mph)
function line(id: number, osm: number[], extra: Partial<RawRoadWay>): RawRoadWay {
  return {
    id,
    highway: 'residential',
    nodeIds: osm,
    coords: osm.map((o) => ({ lat: 100 * Math.floor((o - 1) / 3), lon: 100 * ((o - 1) % 3) })),
    ...extra,
  };
}

const grid = buildGraph(
  [
    line(1, [1, 2, 3], { name: 'Low Rd', highway: 'primary' }),
    line(2, [4, 5, 6], { name: 'Middle St' }),
    line(3, [7, 8, 9], {}),
    line(4, [1, 4, 7], { name: 'West Ave' }),
    line(5, [2, 5, 8], { name: 'Center St', oneway: true }),
    line(6, [3, 6, 9], { name: 'East Ave', maxspeedMph: 15 }),
  ],
  flat,
);

const node = (g: RoadGraph, osm: number) => g.nodes.find((n) => n.osmId === osm)!.id;

describe('shortestTimes', () => {
  it('matches hand-computed times on the grid', () => {
    const { time } = shortestTimes(grid, node(grid, 1));
    expect(time[node(grid, 1)]).toBe(0);
    expect(time[node(grid, 3)]).toBeCloseTo(2 * P, 9); // along Low Rd
    expect(time[node(grid, 5)]).toBeCloseTo(P + R, 9); // 1-2 then north on Center St
    expect(time[node(grid, 9)]).toBeCloseTo(P + 3 * R, 9); // 1-2-5-8-9
  });

  it('respects the oneway', () => {
    const north = shortestTimes(grid, node(grid, 2));
    expect(north.time[node(grid, 8)]).toBeCloseTo(2 * R, 9);
    // Southbound on Center St is not allowed: go 8-7, down West Ave, then Low Rd.
    const south = shortestTimes(grid, node(grid, 8));
    expect(south.time[node(grid, 2)]).toBeCloseTo(3 * R + P, 9);
  });

  it('uses a custom edge cost and treats Infinity as blocked', () => {
    const lowRd = (name: string) => name === 'Low Rd';
    const { time } = shortestTimes(grid, node(grid, 1), {
      edgeCost: (e) => (lowRd(e.name) ? Infinity : e.minutes),
    });
    // 1-4-5-6 (3R) then down East Ave 6-3 (S).
    expect(time[node(grid, 3)]).toBeCloseTo(3 * R + S, 9);
    // Node 2 is only reachable by Low Rd or southbound Center St: cut off.
    expect(time[node(grid, 2)]).toBe(Infinity);
  });

  it('returns all Infinity for an invalid source', () => {
    const { time } = shortestTimes(grid, -1);
    expect(Array.from(time).every((t) => t === Infinity)).toBe(true);
  });
});

describe('pathEdges and routeFromEdges', () => {
  it('reconstructs the path and summarizes it', () => {
    const from = node(grid, 8);
    const to = node(grid, 2);
    const { time, prevEdge } = shortestTimes(grid, from);
    const ids = pathEdges(grid, prevEdge, to)!;
    expect(ids).toHaveLength(4);
    expect(grid.edges[ids[0]].from).toBe(from);
    expect(grid.edges[ids[ids.length - 1]].to).toBe(to);
    for (let i = 1; i < ids.length; i++) expect(grid.edges[ids[i]].from).toBe(grid.edges[ids[i - 1]].to);

    const route = routeFromEdges(grid, ids, 'D1');
    expect(route.destinationId).toBe('D1');
    expect(route.edgeIds).toEqual(ids);
    expect(route.lengthM).toBeCloseTo(400, 6);
    expect(route.driveMin).toBeCloseTo(time[to], 9);
    // Unnamed row 2 is dropped; West Ave appears once though it spans two edges.
    expect(route.roadNames).toEqual(['West Ave', 'Low Rd']);
  });

  it('returns null for an unreachable target and [] for the source itself', () => {
    const { prevEdge } = shortestTimes(grid, node(grid, 1), {
      edgeCost: (e) => (e.name === 'Low Rd' ? Infinity : e.minutes),
    });
    expect(pathEdges(grid, prevEdge, node(grid, 2))).toBeNull();
    expect(pathEdges(grid, prevEdge, node(grid, 1), node(grid, 1))).toEqual([]);
  });

  it('keeps "Unnamed road" only when it is the only name', () => {
    const row2 = grid.edges.filter((e) => e.name === UNNAMED_ROAD).map((e) => e.id);
    expect(routeFromEdges(grid, row2.slice(0, 1), 'X').roadNames).toEqual([UNNAMED_ROAD]);
    expect(routeFromEdges(grid, [], 'X')).toMatchObject({ lengthM: 0, driveMin: 0, roadNames: [] });
  });
});
