// Display units and number wording shared by every screen.
// One rule: metric (km, m, km/h) outside the US, imperial (mi, ft, mph) in the US.
// Engine values stay in meters and mph; only the words on screen change.
import { displayMin } from '../engine/drill';

/** Same values as MapView's MapUnits, so a screen can pass it straight to the map. */
export type Units = 'mi' | 'km';

export const METERS_PER_MILE = 1609.344;
export const FEET_PER_METER = 3.28084;
export const KMH_PER_MPH = 1.609344;

/** Imperial for US addresses (ISO code "us"), metric everywhere else. Unknown country reads as US. */
export function unitsFor(country: string | null | undefined): Units {
  if (!country) return 'mi';
  return country.toLowerCase() === 'us' ? 'mi' : 'km';
}

/** One decimal under 10, whole numbers from 10 up. */
function oneDecimal(v: number): string {
  const tenths = Math.round(v * 10) / 10;
  return tenths >= 10 ? String(Math.round(v)) : tenths.toFixed(1);
}

/**
 * A distance in the household's units: "1.7 mi" or "2.7 km".
 * Short distances read "330 ft" (under 0.1 mi) or "200 m" (under 1 km).
 */
export function fmtDist(m: number, units: Units): string {
  if (units === 'km') {
    if (m < 1000) return `${m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10} m`;
    return `${oneDecimal(m / 1000)} km`;
  }
  const miles = m / METERS_PER_MILE;
  if (miles < 0.1) return `${Math.round((m * FEET_PER_METER) / 10) * 10} ft`;
  return `${oneDecimal(miles)} mi`;
}

/** Side of a square area: "6 × 6 km" or "3.7 × 3.7 mi". */
export function fmtSquare(sideM: number, units: Units): string {
  const v = units === 'km' ? sideM / 1000 : sideM / METERS_PER_MILE;
  const n = Number.isInteger(v) ? String(v) : oneDecimal(v);
  return `${n} × ${n} ${units}`;
}

/** A height difference: "119 ft" or "36 m". */
export function fmtHeight(m: number, units: Units): string {
  return units === 'km' ? `${Math.round(m)} m` : `${Math.round(m * FEET_PER_METER)} ft`;
}

/** Wind speed as a whole number in the household's units (the engine keeps mph). */
export function speedValue(mph: number, units: Units): number {
  return Math.round(units === 'km' ? mph * KMH_PER_MPH : mph);
}

/** Back from the shown number to mph, for the wind slider. */
export function speedToMph(value: number, units: Units): number {
  return units === 'km' ? value / KMH_PER_MPH : value;
}

export const speedUnit = (units: Units) => (units === 'km' ? 'km/h' : 'mph');
export const speedWords = (units: Units) => (units === 'km' ? 'kilometers per hour' : 'miles per hour');

/** "25 mph" or "40 km/h". */
export function fmtSpeed(mph: number, units: Units): string {
  return `${speedValue(mph, units)} ${speedUnit(units)}`;
}

/**
 * Engine copy is written in miles ("first 0.2 mi", "Fire within 0.5 mi of X").
 * For metric households, rewrite each "N mi" as a metric distance.
 */
export function localizeMiles(text: string, units: Units): string {
  if (units === 'mi') return text;
  return text.replace(/(\d+(?:\.\d+)?) mi\b/g, (_, n: string) => fmtDist(Number(n) * METERS_PER_MILE, units));
}

/** Ignition labels are written in km ("2.4 km southeast"). For US households, rewrite each "N km" in miles. */
export function localizeKm(text: string, units: Units): string {
  if (units === 'km') return text;
  return text.replace(/(\d+(?:\.\d+)?) km\b/g, (_, n: string) => fmtDist(Number(n) * 1000, units));
}

// ---------- Minutes in words ----------

/** "9 min", or "under 1 min" when it rounds to zero. */
export function minShort(m: number): string {
  const n = displayMin(m);
  return n < 1 ? 'under 1 min' : `${n} min`;
}

/** "1 minute", "9 minutes", or "under 1 minute". */
export function minLong(m: number): string {
  const n = displayMin(m);
  return n < 1 ? 'under 1 minute' : n === 1 ? '1 minute' : `${n} minutes`;
}

/** "a" or "an" before a number said aloud: an 8, an 11, an 18, an 80-something. */
export function articleFor(n: number): 'a' | 'an' {
  const s = String(Math.abs(Math.round(n)));
  return s.startsWith('8') || n === 11 || n === 18 ? 'an' : 'a';
}

/** "an 11 min drive", "a 9 min drive", or "a drive of under 1 min". */
export function aDrive(m: number): string {
  const n = displayMin(m);
  return n < 1 ? 'a drive of under 1 min' : `${articleFor(n)} ${n} min drive`;
}

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
