import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from './cache.ts';
import {
  buildArea, compassToDeg, fetchMap, geocode, GeocodeRejectedError, isDefunctPlace, isRestricted, gridPoints, localToLatLon,
  lacksLocality, localityFromReverse, makeLock, mapPool, mapQuery, newProgress, parseCensus, parseMaxspeedMph, parseNominatim, parseNwsWindSpeed, parseOneway,
  parsePlaces, parseRoads, RoadsUnavailableError, type OsmElement, type SourceContext,
} from './sources.ts';
import { cachedFetch } from './cache.ts';

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

  it('one map query: places with centers, roads at both radii, minor roads near places, road nodes', () => {
    const q = mapQuery({ lat: 37.1, lon: -122.1 });
    expect(q).toContain('around:3000,37.1,-122.1');
    expect(q).toContain('around:8000,37.1,-122.1');
    expect(q).toContain('.places out center tags;');
    expect(q).toContain('way(around.places:600)["highway"~"^(unclassified|residential|living_street|service)$"]');
    expect(q).toContain('node(w.roads);');
    expect(q).toContain('out skel qt;');
    expect(q).toMatch(/\[timeout:40\]/);
  });

  it('roads and places parse from the same response', () => {
    const els: OsmElement[] = [
      { type: 'node' as const, id: 1, lat: 37, lon: -122, tags: { amenity: 'school', name: 'Hill School' } },
      { type: 'way' as const, id: 5, center: { lat: 37.01, lon: -122 }, tags: { amenity: 'library', name: 'Library' } },
      { type: 'way' as const, id: 6, nodes: [10, 11], tags: { highway: 'residential', name: 'A St' } },
      { type: 'node' as const, id: 10, lat: 37, lon: -122 }, { type: 'node' as const, id: 11, lat: 37.001, lon: -122 },
    ];
    expect(parseRoads(els).map((r) => r.id)).toEqual([6]);
    expect(parsePlaces(els).map((p) => p.id)).toEqual(['node/1', 'way/5']);
  });

  it('places: nodes and way centers with names', () => {
    const places = parsePlaces([
      { type: 'node', id: 1, lat: 1, lon: 2, tags: { amenity: 'library', name: 'Library' } },
      { type: 'way', id: 2, center: { lat: 3, lon: 4 }, tags: { amenity: 'school', name: 'School' } },
      { type: 'node', id: 3, lat: 1, lon: 2, tags: { emergency: 'assembly_point', name: 'Field' } },
      { type: 'node', id: 4, lat: 1, lon: 2, tags: { amenity: 'school' } },
      { type: 'node', id: 5, lat: 1, lon: 2, tags: { amenity: 'school', name: 'Sur School (Abandoned)' } },
      { type: 'node', id: 6, lat: 1, lon: 2, tags: { amenity: 'school', name: 'Old Mill School', disused: 'yes' } },
      { type: 'node', id: 7, lat: 1, lon: 2, tags: { amenity: 'library', name: 'Town Library (former)' } },
    ]);
    expect(places.map((p) => [p.id, p.kind])).toEqual([
      ['node/1', 'library'], ['way/2', 'school'], ['node/3', 'assembly_point'],
    ]);
    expect(places[1].at).toEqual({ lat: 3, lon: 4 });
  });

  it('defunct places', () => {
    expect(isDefunctPlace({ name: 'Disused Hall' })).toBe(true);
    expect(isDefunctPlace({ name: 'Hall', abandoned: 'yes' })).toBe(true);
    expect(isDefunctPlace({ name: 'Hall', 'disused:amenity': 'school' })).toBe(true);
    expect(isDefunctPlace({ name: 'Hall', disused: 'no' })).toBe(false);
    expect(isDefunctPlace({ name: 'Forest Park School' })).toBe(false);
  });

  it('geocoders', () => {
    expect(parseNominatim(JSON.stringify([{ display_name: 'X', lat: '1.5', lon: '2', address: { country_code: 'US' } }])))
      .toEqual([{ label: 'X', lat: 1.5, lon: 2, country: 'us', precision: 'place' }]);
    expect(parseCensus(JSON.stringify({ result: { addressMatches: [{ matchedAddress: 'Y', coordinates: { x: -122, y: 37 } }] } })))
      .toEqual([{ label: 'Y', lat: 37, lon: -122, country: 'us', precision: 'house' }]);
  });

  it('geocode labels come from address parts, with precision', () => {
    const us = { state: 'California', country: 'United States', country_code: 'us' };
    const [house, street, library] = parseNominatim(JSON.stringify([
      { display_name: '5555, Skyway, Paradise, Butte County, California, 95969, United States', lat: '39.7', lon: '-121.6',
        address: { house_number: '5555', road: 'Skyway', town: 'Paradise', county: 'Butte County', postcode: '95969', ...us } },
      { display_name: 'Cabrillo Highway, Big Sur Village, ...', lat: '36.2', lon: '-121.7',
        address: { road: 'Cabrillo Highway', village: 'Big Sur Village', county: 'Monterey County', postcode: '93920', ...us } },
      { display_name: 'long', name: 'Boulder Creek Library', lat: '37.1', lon: '-122.1',
        address: { house_number: '13390', road: 'West Park Avenue', hamlet: 'Forest Park', town: 'Boulder Creek', postcode: '95006', ...us } },
    ]));
    expect(house.label).toBe('5555 Skyway, Paradise, California 95969, United States');
    expect(house.precision).toBe('house');
    expect(street.label).toBe('Cabrillo Highway, Big Sur Village, California 93920, United States');
    expect(street.precision).toBe('street');
    expect(library.label).toBe('Boulder Creek Library, 13390 West Park Avenue, Boulder Creek, California 95006, United States');
    // Suburb before city, and both kept.
    const [m] = parseNominatim(JSON.stringify([{ display_name: 'x', lat: '48.1', lon: '11.5',
      address: { house_number: '8', road: 'Marienplatz', suburb: 'Altstadt-Lehel', city: 'München', state: 'Bayern', postcode: '80331', country: 'Deutschland', country_code: 'de' } }]));
    expect(m.label).toBe('8 Marienplatz, Altstadt-Lehel, München, Bayern 80331, Deutschland');
  });

  it('geocode drops repeated labels', () => {
    const hit = { display_name: 'Main Street, Main Bus Terminal, Toronto', name: 'Main Street', lat: '43.6', lon: '-79.3',
      address: { road: 'Main Bus Terminal', suburb: 'East End-Danforth', city: 'Toronto', state: 'Ontario', country: 'Canada', country_code: 'ca' } };
    const results = parseNominatim(JSON.stringify([hit, { ...hit, lat: '43.61' }, { ...hit, name: 'Other' }]));
    expect(results).toHaveLength(2);
    expect(results[0].label).toBe('Main Street, Main Bus Terminal, East End-Danforth, Toronto, Ontario, Canada');
  });

  it('geocode merges one place listed twice under the same postcode, and lists US matches first', () => {
    const ca = { suburb: 'East End-Danforth', city: 'Toronto', state: 'Ontario', postcode: 'M4C 1L3', country: 'Canada', country_code: 'ca' };
    const results = parseNominatim(JSON.stringify([
      { display_name: 'a', lat: '43.68', lon: '-79.3', address: { house_number: '315', road: 'Main Street', ...ca } },
      { display_name: 'b', name: 'Main Street', lat: '43.68', lon: '-79.3', address: { road: 'Main Bus Terminal', ...ca } },
      { display_name: 'c', lat: '33.9', lon: '-117.3', address: { road: 'Main Street', city: 'Riverside', state: 'California', postcode: '92552', country: 'United States', country_code: 'us' } },
    ]));
    expect(results.map((r) => r.country)).toEqual(['us', 'ca']);
    expect(results[1].label).toBe('315 Main Street, East End-Danforth, Toronto, Ontario M4C 1L3, Canada');
  });

  it('takes the town or suburb from a reverse lookup when a hit names only the city', () => {
    const hit = { display_name: 'x', name: 'Council', lat: '-33.7', lon: '150.3', address: { road: 'Civic Place', city: 'Sydney', postcode: '2780', country_code: 'au' } };
    expect(lacksLocality(hit)).toBe(true);
    expect(lacksLocality({ ...hit, address: { ...hit.address, suburb: 'Katoomba' } })).toBe(false);
    expect(localityFromReverse(JSON.stringify({ address: { suburb: 'Katoomba', city: 'Sydney' } }), 'Sydney')).toBe('Katoomba');
    expect(localityFromReverse(JSON.stringify({ address: { city: 'Sydney' } }), 'Sydney')).toBeNull();
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

describe('geocode errors', () => {
  const tmp = () => mkdtemp(path.join(tmpdir(), 'sp-geo-'));
  it('a 400 from the service is a rejection, a 5xx is an outage', async () => {
    const rejected: Fetcher = async () => new Response('bad', { status: 400 });
    await expect(geocode('x', { cacheDir: await tmp(), fetcher: rejected })).rejects.toBeInstanceOf(GeocodeRejectedError);
    const down: Fetcher = async () => new Response('err', { status: 503 });
    const err = await geocode('y', { cacheDir: await tmp(), fetcher: down }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GeocodeRejectedError);
  });
});

describe('overpass lock', () => {
  it('runs one task at a time and survives failures', async () => {
    const lock = makeLock();
    let inFlight = 0;
    let max = 0;
    const task = (fail: boolean) => lock(async () => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (fail) throw new Error('x');
      return 1;
    });
    const out = await Promise.allSettled([task(false), task(true), task(false)]);
    expect(out.map((o) => o.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(max).toBe(1);
  });
});

describe('buildArea with stubbed services', () => {
  const tmp = () => mkdtemp(path.join(tmpdir(), 'sp-src-'));
  const overpassRoads = JSON.stringify({ elements: [
    { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
    { type: 'node', id: 10, lat: 37, lon: -122 }, { type: 'node', id: 11, lat: 37.001, lon: -122 },
  ] });
  const fast = { retryDefaultMs: 10, retryCapMs: 50, budgetMs: 3000, primaryMs: 1000, mirrorMs: 500 };
  // Short attempts are allowed in tests: MIN_ATTEMPT_MS is 5 s, so give the budget room.
  const ctx = async (fetcher: Fetcher, extra: Partial<SourceContext> = {}): Promise<SourceContext> =>
    ({ cacheDir: await tmp(), fetcher, overpassTiming: { ...fast, budgetMs: 20000 }, ...extra });

  it('uses fallbacks and records notes', async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes('overpass-api.de')) return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } });
      if (url.includes('kumi')) return new Response(overpassRoads);
      if (url.includes('epqs')) return new Response('{"value": 120.5}');
      if (url.includes('api.weather.gov/points')) return new Response('{"properties":{"forecastHourly":"https://api.weather.gov/h"}}');
      if (url === 'https://api.weather.gov/h') return new Response('{"properties":{"periods":[{"windSpeed":"10 mph","windDirection":"NE"}]}}');
      return new Response('err', { status: 500 }); // Open-Meteo down
    };
    const progress = newProgress();
    const area = await buildArea({ home: { lat: 37, lon: -122 }, label: 'Home', country: 'US' }, await ctx(fetcher), progress);
    expect(area.roads).toHaveLength(1);
    expect(area.places).toEqual([]);
    expect(area.elevation?.rows).toBe(11);
    expect(area.elevation?.spacing).toBe(600);
    expect(area.elevation?.values).toHaveLength(121);
    expect(area.wind).toMatchObject({ fromDeg: 45, speedMph: 10, source: 'forecast' });
    expect(area.fallbacksUsed).toHaveLength(2);
    expect(Object.keys(area.fetchedAt)).toHaveLength(4);
    // Main server twice (busy, then retry), then the backup.
    expect(progress).toMatchObject({ roads: 'done', places: 'done', terrain: 'done', wind: 'done', mapAttempt: 3, mapServer: 'backup', mapBusy: true });
  });

  it('retries the main server after a busy answer before using the mirror', async () => {
    let main = 0;
    let mirror = 0;
    const fetcher: Fetcher = async (url) => {
      if (url.includes('overpass-api.de')) {
        main++;
        return main === 1 ? new Response('busy', { status: 504 }) : new Response(overpassRoads);
      }
      if (url.includes('kumi')) mirror++;
      return new Response('err', { status: 500 });
    };
    const map = await fetchMap({ lat: 37, lon: -122 }, await ctx(fetcher));
    expect(map.roads).toHaveLength(1);
    expect([main, mirror]).toEqual([2, 0]);
  });

  it('caps the wait from Retry-After', async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      if (!url.includes('overpass-api.de')) return new Response('err', { status: 500 });
      calls++;
      return calls === 1 ? new Response('busy', { status: 429, headers: { 'Retry-After': '600' } }) : new Response(overpassRoads);
    };
    const t0 = Date.now();
    await fetchMap({ lat: 37, lon: -122 }, await ctx(fetcher));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('fails within the budget with reason timeout when every endpoint hangs', async () => {
    const hang: Fetcher = () => new Promise(() => {});
    const t0 = Date.now();
    const err = await fetchMap({ lat: 37, lon: -122 }, await ctx(hang, { overpassTiming: { ...fast, budgetMs: 7000, primaryMs: 1000, mirrorMs: 1000 } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoadsUnavailableError);
    expect((err as RoadsUnavailableError).reason).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(7500);
  });

  it('nulls elevation and wind outside the US when Open-Meteo fails', async () => {
    const fetcher: Fetcher = async (url) => (url.includes('overpass') ? new Response(overpassRoads) : new Response('err', { status: 500 }));
    const area = await buildArea({ home: { lat: 37, lon: -122 }, label: 'Home', country: 'fr' }, await ctx(fetcher));
    expect(area.elevation).toBeNull();
    expect(area.wind).toBeNull();
    expect(area.fallbacksUsed).toContain('Elevation service: fire spreads as if the ground is flat');
  });

  it('uses Overpass data cached from the second endpoint without calling the first', async () => {
    const first = await ctx(async (url) => url.includes('overpass-api.de') ? new Response('busy', { status: 429 }) : new Response(overpassRoads));
    const home = { lat: 37, lon: -122 };
    await fetchMap(home, first);
    let mainCalls = 0;
    const day2: Fetcher = (url) => {
      if (url.includes('overpass-api.de')) mainCalls++;
      return new Promise(() => {}); // every endpoint hangs
    };
    const progress = newProgress();
    const r = await fetchMap(home, { ...first, fetcher: day2 }, progress);
    expect(r.roads).toHaveLength(1);
    expect(mainCalls).toBe(0);
    expect(progress.mapServer).toBe('cache');
  });

  it('reads an area cached by the older two-query form without any call', async () => {
    const home = { lat: 37.1275032, lon: -122.1238109 };
    const at = '37.127503,-122.123811';
    const near = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)(_link)?$';
    const far = '^((motorway|trunk|primary|secondary|tertiary)(_link)?|unclassified)$';
    const amenity = '["amenity"~"^(school|community_centre|townhall|library)$"]["name"]';
    const assembly = '["emergency"="assembly_point"]["name"]';
    const oldRoads = ['[out:json][timeout:90];', '(', `  way(around:3000,${at})["highway"~"${near}"];`, `  way(around:8000,${at})["highway"~"${far}"];`,
      ');', 'out body;', '>;', 'out skel qt;'].join('\n');
    const oldPlaces = ['[out:json][timeout:60];', '(', `  node(around:8000,${at})${amenity};`, `  way(around:8000,${at})${amenity};`,
      `  node(around:8000,${at})${assembly};`, `  way(around:8000,${at})${assembly};`, ');', 'out center tags;'].join('\n');
    const cacheDir = await tmp();
    const placesBody = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 37.13, lon: -122.12, tags: { amenity: 'library', name: 'Library' } }] });
    for (const [q, body] of [[oldRoads, overpassRoads], [oldPlaces, placesBody]]) {
      await cachedFetch({ method: 'POST', url: 'x', cacheKey: `overpass:${q}` }, { dir: cacheDir, fetcher: async () => new Response(body) });
    }
    let calls = 0;
    const map = await fetchMap(home, { cacheDir, fetcher: async () => { calls++; return new Response('err', { status: 500 }); } });
    expect(calls).toBe(0);
    expect(map.roads).toHaveLength(1);
    expect(map.places.map((p) => p.name)).toEqual(['Library']);
  });

  it('throws RoadsUnavailableError with reason busy when every Overpass endpoint is busy', async () => {
    const fetcher: Fetcher = async () => new Response('err', { status: 504 });
    const err = await buildArea({ home: { lat: 37, lon: -122 }, label: '', country: '' }, await ctx(fetcher)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoadsUnavailableError);
    expect((err as RoadsUnavailableError).reason).toBe('busy');
  });
});
