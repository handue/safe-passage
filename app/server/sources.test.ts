import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from './cache.ts';
import {
  buildArea, compassToDeg, fetchRoads, isRestricted, gridPoints, localToLatLon, mapPool, parseCensus, parseMaxspeedMph,
  parseNominatim, parseNwsWindSpeed, parseOneway, parsePlaces, parseRoads, roadsQuery, RoadsUnavailableError,
} from './sources.ts';

describe('parsers', () => {
  it('maxspeed', () => {
    expect(parseMaxspeedMph('25 mph')).toBe(25);
    expect(parseMaxspeedMph('40')).toBeCloseTo(24.9, 1);
    expect(parseMaxspeedMph('50 km/h')).toBeCloseTo(31.1, 1);
    expect(parseMaxspeedMph('30;40')).toBeCloseTo(18.6, 1);
    expect(parseMaxspeedMph('none')).toBeUndefined();
    expect(parseMaxspeedMph('US:urban')).toBeUndefined();
    expect(parseMaxspeedMph(undefined)).toBeUndefined();
  });

  it('oneway', () => {
    expect(parseOneway({ oneway: 'yes' })).toBe('forward');
    expect(parseOneway({ oneway: '1' })).toBe('forward');
    expect(parseOneway({ oneway: 'true' })).toBe('forward');
    expect(parseOneway({ oneway: '-1' })).toBe('reverse');
    expect(parseOneway({ oneway: 'no' })).toBe('both');
    expect(parseOneway({})).toBe('both');
    expect(parseOneway({ junction: 'roundabout' })).toBe('forward');
    expect(parseOneway({ junction: 'circular' })).toBe('forward');
    expect(parseOneway({ highway: 'motorway' })).toBe('forward');
    expect(parseOneway({ highway: 'motorway_link' })).toBe('forward');
    expect(parseOneway({ highway: 'motorway_link', oneway: 'no' })).toBe('both');
    expect(parseOneway({ highway: 'trunk' })).toBe('both');
  });

  it('access restrictions', () => {
    expect(isRestricted({ access: 'private' })).toBe(true);
    expect(isRestricted({ access: 'no' })).toBe(true);
    expect(isRestricted({ motor_vehicle: 'no' })).toBe(true);
    expect(isRestricted({ motorcar: 'no', access: 'yes' })).toBe(true);
    expect(isRestricted({ access: 'no', motor_vehicle: 'yes' })).toBe(false);
    expect(isRestricted({ service: 'emergency_access' })).toBe(true);
    expect(isRestricted({ access: 'destination' })).toBe(false);
    expect(isRestricted({})).toBe(false);
  });

  it('roads: drops restricted ways except the home driveway, and motorway links are oneway', () => {
    const home = { lat: 37, lon: -122 };
    const roads = parseRoads(
      [
        { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'service', service: 'driveway', access: 'private' } },
        { type: 'way', id: 2, nodes: [12, 13], tags: { highway: 'residential', access: 'private' } },
        { type: 'way', id: 3, nodes: [10, 11], tags: { highway: 'service', service: 'emergency_access' } },
        { type: 'way', id: 4, nodes: [12, 13], tags: { highway: 'motorway_link' } },
        { type: 'node', id: 10, lat: 37, lon: -122 },
        { type: 'node', id: 11, lat: 37.0005, lon: -122 },
        { type: 'node', id: 12, lat: 37.02, lon: -122 },
        { type: 'node', id: 13, lat: 37.03, lon: -122 },
      ],
      home,
    );
    expect(roads.map((r) => r.id)).toEqual([1, 4]);
    expect(roads[1].oneway).toBe(true);
    expect(parseRoads([{ type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'service', access: 'private' } },
      { type: 'node', id: 10, lat: 37, lon: -122 }, { type: 'node', id: 11, lat: 37.0005, lon: -122 }])).toEqual([]);
  });

  it('roads: orders coords, reverses -1, drops missing nodes', () => {
    const roads = parseRoads([
      { type: 'way', id: 1, nodes: [10, 11, 12], tags: { highway: 'residential', name: 'A St', maxspeed: '25 mph' } },
      { type: 'way', id: 2, nodes: [12, 13, 99], tags: { highway: 'primary', oneway: '-1', ref: 'CA 9' } },
      { type: 'way', id: 3, nodes: [99, 10], tags: { highway: 'service' } },
      { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
      { type: 'node', id: 10, lat: 1, lon: 1 },
      { type: 'node', id: 11, lat: 2, lon: 2 },
      { type: 'node', id: 12, lat: 3, lon: 3 },
      { type: 'node', id: 13, lat: 4, lon: 4 },
    ]);
    expect(roads).toHaveLength(2);
    expect(roads[0]).toEqual({
      id: 1, name: 'A St', highway: 'residential', maxspeedMph: 25,
      coords: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }, { lat: 3, lon: 3 }], nodeIds: [10, 11, 12],
    });
    expect(roads[1].nodeIds).toEqual([13, 12]);
    expect(roads[1].coords).toEqual([{ lat: 4, lon: 4 }, { lat: 3, lon: 3 }]);
    expect(roads[1].oneway).toBe(true);
    expect(roads[1].name).toBe('CA 9');
  });

  it('roads query has both radii', () => {
    const q = roadsQuery({ lat: 37.1, lon: -122.1 });
    expect(q).toContain('around:3000,37.1,-122.1');
    expect(q).toContain('around:8000,37.1,-122.1');
    expect(q).toContain('out skel qt;');
  });

  it('places: nodes and way centers with names', () => {
    const places = parsePlaces([
      { type: 'node', id: 1, lat: 1, lon: 2, tags: { amenity: 'library', name: 'Library' } },
      { type: 'way', id: 2, center: { lat: 3, lon: 4 }, tags: { amenity: 'school', name: 'School' } },
      { type: 'node', id: 3, lat: 1, lon: 2, tags: { emergency: 'assembly_point', name: 'Field' } },
      { type: 'node', id: 4, lat: 1, lon: 2, tags: { amenity: 'school' } },
    ]);
    expect(places.map((p) => [p.id, p.kind])).toEqual([
      ['node/1', 'library'], ['way/2', 'school'], ['node/3', 'assembly_point'],
    ]);
    expect(places[1].at).toEqual({ lat: 3, lon: 4 });
  });

  it('geocoders', () => {
    expect(parseNominatim(JSON.stringify([{ display_name: 'X', lat: '1.5', lon: '2', address: { country_code: 'US' } }])))
      .toEqual([{ label: 'X', lat: 1.5, lon: 2, country: 'us' }]);
    expect(parseCensus(JSON.stringify({ result: { addressMatches: [{ matchedAddress: 'Y', coordinates: { x: -122, y: 37 } }] } })))
      .toEqual([{ label: 'Y', lat: 37, lon: -122, country: 'us' }]);
  });

  it('nws wind', () => {
    expect(parseNwsWindSpeed('10 mph')).toBe(10);
    expect(parseNwsWindSpeed('5 to 15 mph')).toBe(15);
    expect(compassToDeg('N')).toBe(0);
    expect(compassToDeg('SW')).toBe(225);
    expect(compassToDeg('WNW')).toBe(292.5);
    expect(compassToDeg('X')).toBeUndefined();
  });
});

describe('geometry', () => {
  it('projection inverse is consistent', () => {
    const home = { lat: 37.13, lon: -122.12 };
    const p = localToLatLon(home, { x: 1000, y: 2000 });
    expect((p.lat - home.lat) * 111320).toBeCloseTo(2000, 6);
    expect((p.lon - home.lon) * 111320 * Math.cos((home.lat * Math.PI) / 180)).toBeCloseTo(1000, 6);
  });

  it('21x21 grid centered on home, row 0 south', () => {
    const home = { lat: 37, lon: -122 };
    const { originXY, points } = gridPoints(home, 21, 300);
    expect(originXY).toEqual({ x: -3000, y: -3000 });
    expect(points).toHaveLength(441);
    expect(points[220].lat).toBeCloseTo(37, 5);
    expect(points[220].lon).toBeCloseTo(-122, 5);
    expect(points[0].lat).toBeLessThan(points[440].lat);
    expect(points[0].lon).toBeLessThan(points[20].lon);
  });

  it('mapPool limits concurrency and keeps order', async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(max).toBe(3);
  });
});

describe('buildArea with stubbed services', () => {
  const tmp = () => mkdtemp(path.join(tmpdir(), 'sp-src-'));
  const overpassRoads = JSON.stringify({ elements: [
    { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
    { type: 'node', id: 10, lat: 37, lon: -122 }, { type: 'node', id: 11, lat: 37.001, lon: -122 },
  ] });

  it('uses fallbacks and records notes', async () => {
    const fetcher: Fetcher = async (url, init) => {
      if (url.includes('overpass-api.de')) return new Response('busy', { status: 429 });
      if (url.includes('kumi')) {
        const body = String(init?.body);
        return new Response(body.includes('amenity') ? '{"elements":[]}' : overpassRoads);
      }
      if (url.includes('epqs')) return new Response('{"value": 120.5}');
      if (url.includes('api.weather.gov/points')) return new Response('{"properties":{"forecastHourly":"https://api.weather.gov/h"}}');
      if (url === 'https://api.weather.gov/h') return new Response('{"properties":{"periods":[{"windSpeed":"10 mph","windDirection":"NE"}]}}');
      return new Response('err', { status: 500 }); // Open-Meteo down
    };
    const area = await buildArea({ home: { lat: 37, lon: -122 }, label: 'Home', country: 'US' }, { cacheDir: await tmp(), fetcher });
    expect(area.roads).toHaveLength(1);
    expect(area.places).toEqual([]);
    expect(area.elevation?.rows).toBe(11);
    expect(area.elevation?.spacing).toBe(600);
    expect(area.elevation?.values).toHaveLength(121);
    expect(area.wind).toMatchObject({ fromDeg: 45, speedMph: 10, source: 'forecast' });
    expect(area.fallbacksUsed).toHaveLength(2);
    expect(Object.keys(area.fetchedAt)).toHaveLength(4);
  });

  it('nulls elevation and wind outside the US when Open-Meteo fails', async () => {
    const fetcher: Fetcher = async (url, init) => {
      if (url.includes('overpass')) return new Response(String(init?.body).includes('amenity') ? '{"elements":[]}' : overpassRoads);
      return new Response('err', { status: 500 });
    };
    const area = await buildArea({ home: { lat: 37, lon: -122 }, label: 'Home', country: 'fr' }, { cacheDir: await tmp(), fetcher });
    expect(area.elevation).toBeNull();
    expect(area.wind).toBeNull();
    expect(area.fallbacksUsed).toContain('Elevation service: fire spreads as if the ground is flat');
  });

  it('uses Overpass data cached from the second endpoint without calling the first', async () => {
    const cacheDir = await tmp();
    const home = { lat: 37, lon: -122 };
    const day1: Fetcher = async (url) => url.includes('overpass-api.de') ? new Response('busy', { status: 429 }) : new Response(overpassRoads);
    await fetchRoads(home, { cacheDir, fetcher: day1 });
    let mainCalls = 0;
    const day2: Fetcher = (url) => {
      if (url.includes('overpass-api.de')) mainCalls++;
      return new Promise(() => {}); // every endpoint hangs
    };
    const r = await fetchRoads(home, { cacheDir, fetcher: day2 });
    expect(r.roads).toHaveLength(1);
    expect(mainCalls).toBe(0);
  });

  it('throws RoadsUnavailableError when every Overpass endpoint fails', async () => {
    const fetcher: Fetcher = async () => new Response('err', { status: 504 });
    await expect(buildArea({ home: { lat: 37, lon: -122 }, label: '', country: '' }, { cacheDir: await tmp(), fetcher }))
      .rejects.toBeInstanceOf(RoadsUnavailableError);
  });
});
