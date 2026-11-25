// Shortest-time routing on the road graph (Dijkstra with a binary heap).
import type { GraphEdge, RoadGraph, Route } from './types';
import { UNNAMED_ROAD } from './graph';

export interface ShortestTimesOptions {
  /** Cost of traversing an edge in minutes. Return Infinity to block the edge. Default: edge.minutes. */
  edgeCost?: (edge: GraphEdge) => number;
}

/**
 * Minimum travel time from one node to every node.
 * time[n] = Infinity when unreachable; prevEdge[n] = last edge on the best path, -1 if none.
 */
export function shortestTimes(
  graph: RoadGraph,
  fromNodeId: number,
  opts: ShortestTimesOptions = {},
): { time: Float64Array; prevEdge: Int32Array } {
  const n = graph.nodes.length;
  const time = new Float64Array(n).fill(Infinity);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  if (fromNodeId < 0 || fromNodeId >= n) return { time, prevEdge };

  const cost = opts.edgeCost ?? ((e: GraphEdge) => e.minutes);
  const heap = new MinHeap();
  time[fromNodeId] = 0;
  heap.push(0, fromNodeId);

  while (heap.size > 0) {
    const [t, u] = heap.pop();
    if (done[u]) continue; // stale heap entry
    done[u] = 1;
    for (const eid of graph.adjacency[u]) {
      const e = graph.edges[eid];
      const c = cost(e);
      if (!(c >= 0) || c === Infinity) continue; // blocked or invalid cost
      const nt = t + c;
      if (nt < time[e.to]) {
        time[e.to] = nt;
        prevEdge[e.to] = eid;
        heap.push(nt, e.to);
      }
    }
  }
  return { time, prevEdge };
}

/**
 * Edge ids from the source to toNodeId, following prevEdge back.
 * Returns null when the target was not reached. Pass fromNodeId to get [] when the
 * target is the source itself (otherwise that case also returns null).
 */
export function pathEdges(
  graph: RoadGraph,
  prevEdge: Int32Array,
  toNodeId: number,
  fromNodeId?: number,
): number[] | null {
  if (toNodeId === fromNodeId) return [];
  if (toNodeId < 0 || toNodeId >= prevEdge.length || prevEdge[toNodeId] < 0) return null;
  const path: number[] = [];
  let node = toNodeId;
  while (prevEdge[node] >= 0) {
    const eid = prevEdge[node];
    path.push(eid);
    node = graph.edges[eid].from;
    if (path.length > graph.edges.length) return null; // guard against a malformed prevEdge
  }
  return path.reverse();
}

/** Summarizes a path as a Route. */
export function routeFromEdges(graph: RoadGraph, edgeIds: number[], destinationId: string): Route {
  let lengthM = 0;
  let driveMin = 0;
  const names: string[] = [];
  for (const eid of edgeIds) {
    const e = graph.edges[eid];
    lengthM += e.lengthM;
    driveMin += e.minutes;
    if (names[names.length - 1] !== e.name) names.push(e.name);
  }
  // Keep the first appearance of each name; drop "Unnamed road" unless nothing else is named.
  const distinct = names.filter((name, i) => names.indexOf(name) === i);
  const named = distinct.filter((name) => name !== UNNAMED_ROAD);
  const roadNames = named.length > 0 ? named : distinct;
  return { destinationId, edgeIds: edgeIds.slice(), lengthM, driveMin, roadNames };
}

/** Binary min-heap of (key, value) pairs. Ties break on value for determinism. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.vals[0]];
    const lastKey = this.keys.pop()!;
    const lastVal = this.vals.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.vals[a] < this.vals[b]);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}
