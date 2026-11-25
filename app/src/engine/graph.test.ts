import { describe, expect, it } from 'vitest';
import { buildGraph, nearestNode, speedMph, UNNAMED_ROAD } from './graph';
import type { LatLon, Projection, RawRoadWay } from './types';

// Identity projection for tests: lon = x meters, lat = y meters.
const flat: Projection = {
  origin: { lat: 0, lon: 0 },
  toXY: (p) => ({ x: p.lon, y: p.lat }),
  toLatLon: (p) => ({ lat: p.y, lon: p.x }),
};

const at = (x: number, y: number): LatLon => ({ lat: y, lon: x });

function way(id: number, pts: [number, number, number][], extra: Partial<RawRoadWay> = {}): RawRoadWay {
  return {
    id,
    highway: 'residential',
    nodeIds: pts.map((p) => p[0]),
    coords: pts.map((p) => at(p[1], p[2])),
    ...extra,
  };
}

const MPM = 26.8224; // m/min per mph

describe('speedMph', () => {
  it('uses maxspeed when given, else the default by road type', () => {
    expect(speedMph('residential', 40)).toBe(40);
    expect(speedMph('motorway')).toBe(65);
    expect(speedMph('trunk')).toBe(55);
    expect(speedMph('primary')).toBe(50);
    expect(speedMph('secondary')).toBe(45);
    expect(speedMph('tertiary')).toBe(35);
    expect(speedMph('unclassified')).toBe(30);
    expect(speedMph('residential')).toBe(25);
    expect(speedMph('living_street')).toBe(15);
    expect(speedMph('service')).toBe(15);
    expect(speedMph('track')).toBe(25);
  });
});

describe('buildGraph', () => {
  it('splits two ways that share a middle node into 4 edges', () => {
    // A: west-east through node 2, B: south-north through node 2.
    const a = way(1, [[1, -100, 0], [2, 0, 0], [3, 100, 0]], { name: 'A St' });
    const b = way(2, [[4, 0, -100], [2, 0, 0], [5, 0, 100]], { name: 'B St' });
    const g = buildGraph([a, b], flat);
    expect(g.nodes).toHaveLength(5);
    // 4 undirected segments, each in both directions.
    expect(g.edges).toHaveLength(8);
    const mid = g.nodes.find((n) => n.osmId === 2)!;
    expect(g.adjacency[mid.id]).toHaveLength(4);
    for (const e of g.edges) {
      expect(e.lengthM).toBeCloseTo(100, 6);
      expect(e.minutes).toBeCloseTo(100 / (25 * MPM), 9);
      expect(e.shape[0]).toEqual(g.nodes[e.from].xy);
      expect(e.shape[e.shape.length - 1]).toEqual(g.nodes[e.to].xy);
    }
  });

  it('keeps unshared intermediate nodes as shape points', () => {
    const w = way(1, [[1, 0, 0], [2, 30, 40], [3, 60, 0]]);
    const g = buildGraph([w], flat);
    expect(g.nodes.map((n) => n.osmId)).toEqual([1, 3]);
    expect(g.edges).toHaveLength(2);
    expect(g.edges[0].shape).toHaveLength(3);
    expect(g.edges[0].lengthM).toBeCloseTo(100, 6);
    expect(g.edges[0].name).toBe(UNNAMED_ROAD);
    expect(g.edges[1].shape).toEqual([...g.edges[0].shape].reverse());
  });

  it('makes oneway edges only along the way order', () => {
    const w = way(1, [[1, 0, 0], [2, 100, 0]], { oneway: true, name: 'One Way' });
    const g = buildGraph([w], flat);
    expect(g.edges).toHaveLength(1);
    const e = g.edges[0];
    expect(g.nodes[e.from].osmId).toBe(1);
    expect(g.nodes[e.to].osmId).toBe(2);
    expect(g.adjacency[e.to]).toEqual([]);
  });

  it('uses maxspeed for edge minutes', () => {
    const w = way(1, [[1, 0, 0], [2, 1000, 0]], { maxspeedMph: 50 });
    const g = buildGraph([w], flat);
    expect(g.edges[0].minutes).toBeCloseTo(1000 / (50 * MPM), 9);
  });

  it('splits a closed loop so no edge starts and ends at the same node', () => {
    const loop = way(1, [[1, 0, 0], [2, 100, 0], [3, 100, 100], [4, 0, 100], [1, 0, 0]]);
    const g = buildGraph([loop], flat);
    for (const e of g.edges) expect(e.from).not.toBe(e.to);
    const total = g.edges.reduce((s, e) => s + e.lengthM, 0);
    expect(total).toBeCloseTo(800, 6); // 400 m each way
  });

  it('skips ways with fewer than two distinct nodes', () => {
    const g = buildGraph([way(1, [[1, 0, 0]]), way(2, [[2, 0, 0], [2, 0, 0]])], flat);
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});

describe('nearestNode', () => {
  const street = way(1, [[1, 0, 0], [2, 200, 0]], { name: 'Main St' });
  const driveway = way(2, [[2, 200, 0], [3, 200, 60]], { highway: 'service' });
  const g = buildGraph([street, driveway], flat);
  const idOf = (osm: number) => g.nodes.find((n) => n.osmId === osm)!.id;

  it('returns the absolute nearest when it is on a non-service road', () => {
    expect(nearestNode(g, { x: 10, y: 5 })).toBe(idOf(1));
  });

  it('prefers a non-service node within 50 m of the absolute nearest', () => {
    // Nearest is the driveway end (node 3, 10 m); node 2 is 50 m away -> within 10 + 50.
    expect(nearestNode(g, { x: 200, y: 50 })).toBe(idOf(2));
  });

  it('keeps the service node when the street is too far beyond it', () => {
    const longDrive = way(3, [[2, 200, 0], [4, 200, 200]], { highway: 'service' });
    const g2 = buildGraph([street, longDrive], flat);
    const n4 = g2.nodes.find((n) => n.osmId === 4)!.id;
    expect(nearestNode(g2, { x: 200, y: 210 })).toBe(n4);
  });

  it('returns null when nothing is within maxM or the graph is empty', () => {
    expect(nearestNode(g, { x: 5000, y: 5000 }, 500)).toBeNull();
    expect(nearestNode({ nodes: [], edges: [], adjacency: [] }, { x: 0, y: 0 })).toBeNull();
  });
});
