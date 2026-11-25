import { describe, expect, it } from 'vitest';
import { aDrive, articleFor, fmtDist, fmtHeight, fmtSpeed, fmtSquare, localizeKm, localizeMiles, minLong, minShort, speedToMph, speedValue, unitsFor } from './units';
import { keyText } from './TimeBars';

describe('units by country', () => {
  it('uses imperial in the US and metric elsewhere', () => {
    expect(unitsFor('us')).toBe('mi');
    expect(unitsFor('US')).toBe('mi');
    expect(unitsFor('au')).toBe('km');
    expect(unitsFor('de')).toBe('km');
    expect(unitsFor(undefined)).toBe('mi');
  });

  it('formats distances in one system', () => {
    expect(fmtDist(2736, 'mi')).toBe('1.7 mi');
    expect(fmtDist(2736, 'km')).toBe('2.7 km');
    expect(fmtDist(200, 'km')).toBe('200 m');
    expect(fmtDist(805, 'km')).toBe('800 m');
    expect(fmtDist(200, 'mi')).toBe('0.1 mi');
    expect(fmtDist(100, 'mi')).toBe('330 ft');
    expect(fmtDist(16093, 'mi')).toBe('10 mi');
    expect(fmtSquare(6000, 'km')).toBe('6 × 6 km');
    expect(fmtSquare(6000, 'mi')).toBe('3.7 × 3.7 mi');
  });

  it('formats heights and wind speed', () => {
    expect(fmtHeight(36.3, 'mi')).toBe('119 ft');
    expect(fmtHeight(36.3, 'km')).toBe('36 m');
    expect(fmtSpeed(25, 'mi')).toBe('25 mph');
    expect(fmtSpeed(25, 'km')).toBe('40 km/h');
  });

  it('round-trips the wind slider in km/h', () => {
    for (const kmh of [0, 7, 40, 100]) expect(speedValue(speedToMph(kmh, 'km'), 'km')).toBe(kmh);
  });

  it('rewrites engine miles for metric households only', () => {
    expect(localizeMiles('Fire within 0.5 mi of Great Western Highway', 'km')).toBe('Fire within 800 m of Great Western Highway');
    expect(localizeMiles('Main St, first 1.2 mi', 'km')).toBe('Main St, first 1.9 km');
    expect(localizeMiles('Fire within 0.5 mi of X', 'mi')).toBe('Fire within 0.5 mi of X');
    expect(localizeMiles('Mill Rd at T+12', 'km')).toBe('Mill Rd at T+12');
  });

  it('rewrites ignition km labels for US households only', () => {
    expect(localizeKm('2.4 km southeast', 'mi')).toBe('1.5 mi southeast');
    expect(localizeKm('2.4 km southeast', 'km')).toBe('2.4 km southeast');
  });
});

describe('minutes in words', () => {
  it('says 1 minute, not 1 minutes, and under 1 minute for zero', () => {
    expect(minLong(1)).toBe('1 minute');
    expect(minLong(1.4)).toBe('1 minute');
    expect(minLong(0.3)).toBe('under 1 minute');
    expect(minLong(12)).toBe('12 minutes');
    expect(minShort(0.4)).toBe('under 1 min');
    expect(minShort(9.4)).toBe('9 min');
  });

  it('uses an before eight and eleven', () => {
    expect(articleFor(11)).toBe('an');
    expect(articleFor(8)).toBe('an');
    expect(articleFor(18)).toBe('an');
    expect(articleFor(83)).toBe('an');
    expect(articleFor(9)).toBe('a');
    expect(articleFor(1)).toBe('a');
    expect(aDrive(11.2)).toBe('an 11 min drive');
    expect(aDrive(9)).toBe('a 9 min drive');
    expect(aDrive(0.2)).toBe('a drive of under 1 min');
  });

  it('gives each time-bar key part its own unit', () => {
    const key = keyText([
      { kind: 'slow', word: 'pets', min: 12 },
      { kind: 'drive', word: 'drive', min: 1 },
    ]);
    expect(key).toBe('pets 12 min (slowest), drive 1 min');
    expect(key).not.toMatch(/1 minutes/);
  });
});
