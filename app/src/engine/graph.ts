// Road graph built from OpenStreetMap ways, plus nearest-node lookup.
import type { GraphEdge, GraphNode, LatLon, Projection, RawRoadWay, RoadGraph, XY } from './types';
import { dist, polylineLength } from './geo';

export const UNNAMED_ROAD = 'Unnamed road';

/** 1 mph in meters per minute. */
const METERS_PER_MIN_PER_MPH = 26.8224;

const DEFAULT_SPEED_MPH: Record<string, number> = {
  motorway: 65,
  trunk: 55,
  primary: 50,
  secondary: 45,
  tertiary: 35,
  unclassified: 30,
  residential: 25,
  living_street: 15,
  service: 15,
};

/** Assumed driving speed: the posted limit if known, else a default by road type. */
export function speedMph(highway: string, maxspeedMph?: number): number {
  if (maxspeedMph !== undefined && Number.isFinite(maxspeedMph) && maxspeedMph > 0) {
    return maxspeedMph;
  }
  return DEFAULT_SPEED_MPH[highway] ?? 25;
}

/**
 * Builds a directed road graph. Ways are split at their ends and at every OSM node
 * that appears more than once across all ways (junctions); other nodes become
 * shape points. Two-way roads get one edge per direction.
 */
export function buildGraph(roads: RawRoadWay[], proj: Projection): RoadGraph {
  // Clean each way: drop consecutive duplicate nodes, skip ways that are too short.
  const ways = roads
    .map((w) => cleanWay(w, proj))
    .filter((w): w is CleanWay => w !== null);

  // How many times each OSM node appears across all ways.
  const useCount = new Map<number, number>();
  for (const w of ways) {
    for (const osmId of w.nodeIds) useCount.set(osmId, (useCount.get(osmId) ?? 0) + 1);
  }

  const nodes: GraphNode[] = [];
  const nodeByOsm = new Map<number, number>();
  const edges: GraphEdge[] = [];

  const nodeFor = (w: CleanWay, i: number): number => {
    const osmId = w.nodeIds[i];
    let id = nodeByOsm.get(osmId);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ id, xy: w.xy[i], osmId });
      nodeByOsm.set(osmId, id);
    }
    return id;
  };

  const addEdges = (w: CleanWay, startIdx: number, endIdx: number) => {
    const from = nodeFor(w, startIdx);
    const to = nodeFor(w, endIdx);
    const shape = w.xy.slice(startIdx, endIdx + 1);
    const lengthM = polylineLength(shape);
    const minutes = lengthM / (w.speedMph * METERS_PER_MIN_PER_MPH);
    const base = { name: w.name, highway: w.highway, lengthM, minutes };
    edges.push({ id: edges.length, from, to, shape, ...base });
    if (!w.oneway) {
      edges.push({ id: edges.length, from: to, to: from, shape: shape.slice().reverse(), ...base });
    }
  };

  for (const w of ways) {
    const last = w.nodeIds.length - 1;
    const splits: number[] = [0];
    for (let i = 1; i < last; i++) {
      if ((useCount.get(w.nodeIds[i]) ?? 0) >= 2) splits.push(i);
    }
    splits.push(last);

    for (let k = 0; k + 1 < splits.length; k++) {
      const a = splits[k];
      const b = splits[k + 1];
      if (w.nodeIds[a] === w.nodeIds[b]) {
        // A closed loop between the same junction: split at its middle so no edge is a self-loop.
        if (b - a < 2) continue;
        const mid = Math.floor((a + b) / 2);
        addEdges(w, a, mid);
        addEdges(w, mid, b);
      } else {
        addEdges(w, a, b);
      }
    }
  }

  const adjacency: number[][] = nodes.map(() => []);
  for (const e of edges) adjacency[e.from].push(e.id);

  return { nodes, edges, adjacency };
}

interface CleanWay {
  name: string;
  highway: string;
  speedMph: number;
  oneway: boolean;
  nodeIds: number[];
  xy: XY[];
}

function cleanWay(way: RawRoadWay, proj: Projection): CleanWay | null {
  const nodeIds: number[] = [];
  const coords: LatLon[] = [];
  const n = Math.min(way.nodeIds.length, way.coords.length);
  for (let i = 0; i < n; i++) {
    if (nodeIds.length > 0 && nodeIds[nodeIds.length - 1] === way.nodeIds[i]) continue;
    nodeIds.push(way.nodeIds[i]);
    coords.push(way.coords[i]);
  }
  if (nodeIds.length < 2) return null;
  return {
    name: way.name && way.name.trim() !== '' ? way.name : UNNAMED_ROAD,
    highway: way.highway,
    speedMph: speedMph(way.highway, way.maxspeedMph),
    oneway: way.oneway === true,
    nodeIds,
    xy: coords.map((c) => proj.toXY(c)),
  };
}

/**
 * Nearest graph node to a point. Prefers a node on a non-service road when one is
 * within 50 m of the absolute nearest distance, so a home on a driveway snaps to
 * the street. Returns null if the graph is empty or nothing is within maxM.
 * accept, when given, skips nodes it rejects (for example nodes that cannot be reached).
 */
export function nearestNode(graph: RoadGraph, xy: XY, maxM = Infinity, accept?: (nodeId: number) => boolean): number | null {
  let bestId = -1;
  let bestD = Infinity;
  for (const node of graph.nodes) {
    if (accept && !accept(node.id)) continue;
    const d = dist(node.xy, xy);
    if (d < bestD) {
      bestD = d;
      bestId = node.id;
    }
  }
  if (bestId < 0 || bestD > maxM) return null;

  const onMainRoad = new Uint8Array(graph.nodes.length);
  for (const e of graph.edges) {
    if (e.highway !== 'service') {
      onMainRoad[e.from] = 1;
      onMainRoad[e.to] = 1;
    }
  }
  if (onMainRoad[bestId]) return bestId;

  const limit = Math.min(bestD + 50, maxM);
  let preferId = -1;
  let preferD = Infinity;
  for (const node of graph.nodes) {
    if (!onMainRoad[node.id] || (accept && !accept(node.id))) continue;
    const d = dist(node.xy, xy);
    if (d <= limit && d < preferD) {
      preferD = d;
      preferId = node.id;
    }
  }
  return preferId >= 0 ? preferId : bestId;
}
