// Turns raw area data into everything the drill needs, once per address.
import type { AreaData, FireGrid, Projection, RoadGraph, WaysOut, XY } from './types';
import { makeProjection } from './geo';
import { buildGraph } from './graph';
import { elevationForCells, makeFireGrid } from './fire';
import { planWaysOut } from './drill';

export interface PreparedArea {
  proj: Projection;
  homeXY: XY;
  graph: RoadGraph;
  fireGrid: FireGrid;
  elevationPerCell: Float32Array | null;
  waysOut: WaysOut;
}

export function prepareArea(area: AreaData): PreparedArea {
  const proj = makeProjection(area.home);
  const homeXY = proj.toXY(area.home);
  const graph = buildGraph(area.roads, proj);
  const fireGrid = makeFireGrid(100, 60);
  const elevationPerCell = elevationForCells(fireGrid, area.elevation);
  const waysOut = planWaysOut(graph, homeXY, area.places, proj, fireGrid);
  return { proj, homeXY, graph, fireGrid, elevationPerCell, waysOut };
}
