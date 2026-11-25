import { describe, expect, it } from 'vitest';
import { dataSources } from './ResultsScreen';
import { DEMO_WIND } from '../app/state';
import type { AreaData } from '../engine/types';

const area = { fetchedAt: { 'Roads: OpenStreetMap (Overpass)': 't', 'Wind: Open-Meteo forecast': 't' } } as unknown as AreaData;

describe('dataSources', () => {
  it('names the forecast when the drill used it', () => {
    expect(dataSources(area, { fromDeg: 10, speedMph: 5, source: 'forecast' }, false)).toContain('Wind: Open-Meteo forecast');
  });
  it('names the demo preset instead of the forecast', () => {
    const s = dataSources(area, DEMO_WIND, true);
    expect(s).toContain('Wind: demo preset');
    expect(s).not.toContain('Open-Meteo forecast');
  });
  it('names a wind the user set', () => {
    expect(dataSources(area, { fromDeg: 90, speedMph: 12, source: 'manual' }, false)).toContain('Wind: set by you');
  });
});
