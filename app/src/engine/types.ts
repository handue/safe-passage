// Shared contract for the Safe Passage drill engine.
// Units: distances in meters, times in minutes, speeds in m/min unless named otherwise.
// Local coordinates: x = meters east of home, y = meters north of home.

export interface LatLon { lat: number; lon: number }
export interface XY { x: number; y: number }

/** Converts between lat/lon and local meters around an origin (home). */
export interface Projection {
  origin: LatLon;
  toXY(p: LatLon): XY;
  toLatLon(p: XY): LatLon;
}

// ---------- Raw area data (what the server returns for an address) ----------

export interface RawRoadWay {
  id: number;
  name?: string;
  highway: string; // OSM highway tag
  maxspeedMph?: number; // parsed OSM maxspeed if present
  oneway?: boolean;
  coords: LatLon[]; // node positions in order
  nodeIds: number[]; // OSM node ids, same length as coords
}

export interface RawPlace {
  id: string;
  name: string;
  kind: 'school' | 'community_centre' | 'townhall' | 'library' | 'assembly_point' | 'other';
  at: LatLon;
}

/** Elevation samples on a regular lat/lon-aligned grid covering the fire area. */
export interface ElevationGrid {
  rows: number;
  cols: number;
  /** Local XY of the south-west corner sample and spacing in meters. */
  originXY: XY;
  spacing: number;
  /** Row-major, row 0 = south. Meters above sea level. */
  values: number[];
}

export interface Wind {
  /** Direction the wind blows FROM, degrees clockwise from north (meteorological). */
  fromDeg: number;
  speedMph: number;
  source: 'forecast' | 'manual';
  fetchedAt?: string;
}

export interface AreaData {
  home: LatLon;
  addressLabel: string;
  country: string; // ISO code, e.g. "us"
  roads: RawRoadWay[];
  places: RawPlace[];
  elevation: ElevationGrid | null; // null = elevation service failed (treat as flat)
  wind: Wind | null; // null = wind service failed (user sets by hand)
  fetchedAt: Record<string, string>; // service name -> ISO time
  fallbacksUsed: string[]; // human-readable notes, e.g. "Elevation service: fire spreads as if flat"
}

// ---------- Road graph ----------

export interface GraphNode { id: number; xy: XY; osmId: number }
export interface GraphEdge {
  id: number;
  from: number; // node id
  to: number; // node id
  name: string; // road name or "Unnamed road"
  highway: string;
  lengthM: number;
  minutes: number; // drive time at assumed speed
  /** Polyline in local XY, from -> to, including both endpoints. */
  shape: XY[];
}
export interface RoadGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Outgoing edge ids per node id (respects oneway). */
  adjacency: number[][];
}

// ---------- Fire model ----------

export interface FireGrid {
  /** Square grid centered on home. */
  cellM: number; // e.g. 100
  size: number; // cells per side, e.g. 60
  originXY: XY; // local XY of the south-west corner of cell (0,0)
}

export interface FireParams {
  ignition: XY; // local XY
  wind: Wind;
  seed: number;
  horizonMin: number; // e.g. 180
  stepMin: number; // e.g. 1
  /** Elevation per cell center, row-major, row 0 = south; null = flat. */
  elevationPerCell: Float32Array | null;
}

/** Result of one simulated fire. -1 = never ignited within the horizon. */
export interface FireResult {
  grid: FireGrid;
  /** Minute each cell ignited, row-major, row 0 = south. */
  ignitionMin: Float32Array;
  /** Minutes a cell keeps burning before it counts as burned out. */
  burnMinutes: number;
  horizonMin: number;
}

// ---------- Household and drill ----------

export interface Task {
  id: string;
  label: string;
  minutes: number;
  source: 'estimate';
}

export interface Household {
  adults: number;
  children: number;
  needHelpMoving: number;
  dogs: number;
  catsAndSmallPets: number;
  cars: number;
  tasks: Task[];
}

export type StartTime = 'day' | 'night';

export interface Destination {
  id: string;
  label: string; // "D1 School"
  name: string;
  kind: RawPlace['kind'] | 'exit_point';
  xy: XY;
  nodeId: number; // nearest graph node
}

export interface Route {
  destinationId: string;
  edgeIds: number[];
  lengthM: number;
  driveMin: number;
  /** Ordered distinct road names along the route, e.g. ["Willow Dr", "Creek Rd", "Highway 9"]. */
  roadNames: string[];
}

export interface WaysOut {
  homeNodeId: number;
  destinations: Destination[];
  main: Route | null;
  backup: Route | null;
  /** Length of the stretch both routes share from the door; 0 if none. */
  sharedFromDoorM: number;
  sharedRoadNames: string[];
}

/** When each road edge closes in a given fire. Infinity = stays open within the horizon. */
export type EdgeClosures = Map<number, number>;

export interface RouteRun {
  route: Route;
  departMin: number; // when the car leaves home
  /** Per edge on the route: minute you leave that edge, and minute it closes. */
  legs: { edgeId: number; name: string; exitMin: number; closeMin: number; marginMin: number }[];
  /** The leg with the smallest margin among legs that close within the horizon; null if none close. */
  binding: { edgeId: number; name: string; closeMin: number; passMin: number; marginMin: number; xy: XY } | null;
  /** passMin - closeMin > 0 means short. */
  outcome: 'never_closed' | 'in_time' | 'short';
  arriveMin: number; // at destination, ignoring closures
}

export interface Bottleneck {
  kind: 'road_closed' | 'one_way_out' | 'longest_task';
  title: string;
  detail: string;
  minutes?: number;
}

export interface DrillSetup {
  ignition: XY;
  wind: Wind;
  start: StartTime;
  seed: number;
}

export interface DrillResult {
  setup: DrillSetup;
  fire: FireResult;
  closures: EdgeClosures;
  tasksMin: number; // sum of task minutes incl. night wake-up
  main: RouteRun | null;
  backup: RouteRun | null;
  bottlenecks: Bottleneck[];
  keyMoments: { label: string; min: number }[];
}
