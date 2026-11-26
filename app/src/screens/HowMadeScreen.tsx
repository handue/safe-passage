// Screen 9: how this plan was made. Sources with real fetch times, fallbacks, method, assumptions and limits.
import { useApp } from '../app/state';
import { loadedInfo } from '../app/load';
import { usedReference, type RefPart } from '../app/api';
import { Tag } from '../ui/Tag';
import { fmtDist, fmtSquare, unitsFor } from '../ui/units';
import '../styles/entry.css';

const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function When({ iso, none = 'not used' }: { iso: string | null | undefined; none?: string }) {
  if (!iso) return <span className="muted">{none}</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span className="muted">{none}</span>;
  return <time dateTime={iso}>{fmt.format(d)}</time>;
}

/** First fetchedAt entry whose service name starts with the prefix, e.g. "Wind:". */
function find(fetchedAt: Record<string, string> | undefined, prefix: string): { service: string; at: string } | null {
  if (!fetchedAt) return null;
  for (const [k, v] of Object.entries(fetchedAt)) if (k.startsWith(prefix)) return { service: k.slice(prefix.length).trim(), at: v };
  return null;
}

const REF_REASON: Record<'outside_us' | 'no_key' | 'bad_key' | 'failed', string> = {
  outside_us: 'not used (outside the US)',
  no_key: 'not used (no key)',
  bad_key: 'not used (key not accepted)',
  failed: 'not used (service did not answer)',
};

/** The Fetched cell for one part of the reference layer: its fetch time, or why there is none. */
export function refFetchedCell(part: RefPart<unknown> | null, hasArea: boolean): { iso: string } | { text: string } {
  if (!hasArea) return { text: 'no address yet' };
  if (!part) return { text: 'not used (layer off)' };
  return part.available ? { iso: part.fetchedAt } : { text: REF_REASON[part.reason] };
}

function RefFetched({ cell }: { cell: { iso: string } | { text: string } }) {
  return 'iso' in cell ? <When iso={cell.iso} /> : <span className="muted">{cell.text}</span>;
}

export function HowMadeScreen() {
  const { state } = useApp();
  const { area, prepared, plan } = state;
  const info = area ? loadedInfo() : null;
  const f = area?.fetchedAt;
  const roads = find(f, 'Roads:');
  const places = find(f, 'Places:');
  const elev = find(f, 'Elevation:');
  const wind = find(f, 'Wind:');
  const planSource = plan.data?.source ?? null;
  const sit = state.situations;
  const grid = prepared?.fireGrid;
  const none = area ? 'not used' : 'no address yet';
  const units = unitsFor(area?.country);
  const ref = area ? usedReference({ lat: area.home.lat, lon: area.home.lon, country: area.country ?? '' }) : null;

  return (
    <main className="narrow">
      <div className="stack">
        <h1>How this plan was made</h1>
        <p>Four kinds of information appear in Safe Passage:</p>
        <p>
          <Tag kind="calc" /> worked out by code from data.
        </p>
        <p>
          <Tag kind="est" /> a number you gave or accepted.
        </p>
        <p>
          <Tag kind="timed" /> task minutes you measured with the app's stopwatch ("Time it for real"), rounded to the nearest minute.
        </p>
        <p>
          <Tag kind="ai" /> wording by a language model. It does not set times or routes.
        </p>
      </div>

      <section className="stack-s">
        <h2>Data sources</h2>
        {area ? (
          <p className="muted">
            For {area.addressLabel}
            {state.isDemo ? ' (the demo address)' : ''}. Times are when each service answered; saved answers are reused.
          </p>
        ) : (
          <p className="muted">No address is loaded yet. Fetch times appear here after you build a drill.</p>
        )}
        <div className="entry-tablewrap">
          <table className="sources">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Source</th>
                <th scope="col">Fetched</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Address to location</td>
                <td>Nominatim (fallback: US Census geocoder){info?.demo ? '. The demo uses a fixed location, so no lookup is needed.' : ''}</td>
                <td>{info?.demo ? <span className="muted">not used</span> : <When iso={info?.geocodedAt} none={none} />}</td>
              </tr>
              <tr>
                <td>Roads</td>
                <td>
                  OpenStreetMap via Overpass. Roads and candidate destinations come in one request. If the server is busy, it waits briefly and tries once more,
                  then tries a second Overpass server, and gives up after about a minute.
                </td>
                <td>
                  <When iso={roads?.at} none={none} />
                </td>
              </tr>
              <tr>
                <td>Candidate destinations</td>
                <td>OpenStreetMap via Overpass: schools, community centres, town halls, libraries, assembly points. Not confirmed shelters.</td>
                <td>
                  <When iso={places?.at} none={none} />
                </td>
              </tr>
              <tr>
                <td>Routes around the practice fire</td>
                <td>Our own shortest-time routing on the OpenStreetMap road graph, run in your browser. Free-flow speeds; evacuation traffic is shown as a slowdown you set.</td>
                <td className="muted">{area ? 'calculated here' : none}</td>
              </tr>
              <tr>
                <td>Wind and weather</td>
                <td>
                  {wind ? wind.service : 'Open-Meteo (fallback: National Weather Service, US only)'}
                  {area && area.wind === null ? '. No service answered, so you set the wind by hand.' : ''}
                </td>
                <td>
                  <When iso={wind?.at} none={none} />
                </td>
              </tr>
              <tr>
                <td>Slope</td>
                <td>
                  {elev ? `${elev.service} elevation` :'Open-Meteo Elevation (fallback: USGS elevation service, US only)'}
                  {area && area.elevation === null ? '. No service answered, so the ground is treated as flat.' : ''}
                </td>
                <td>
                  <When iso={elev?.at} none={none} />
                </td>
              </tr>
              <tr>
                <td>Current fire perimeters (reference)</td>
                <td>
                  NIFC WFIGS Interagency Perimeters (Current), US only, within {fmtDist(50000, units)} of home. Reference only, never part of the drill.
                  {area && area.country !== 'us' ? ' Not requested for this address: it is outside the US.' : ''}
                  {ref && !ref.perimeters.available && ref.perimeters.reason === 'failed' ? ' The service did not answer.' : ''}
                </td>
                <td>
                  <RefFetched cell={refFetchedCell(ref?.perimeters ?? null, !!area)} />
                </td>
              </tr>
              <tr>
                <td>Satellite heat detections (reference)</td>
                <td>
                  NASA FIRMS, VIIRS on NOAA-20 and NOAA-21, last 48 hours. A detection is not a confirmed fire. Reference only, never part of the drill.
                  {ref && !ref.detections.available
                    ? ref.detections.reason === 'no_key'
                      ? ' Not shown: it needs a free NASA FIRMS key.'
                      : ref.detections.reason === 'bad_key'
                        ? ' Not shown: the key was not accepted.'
                        : ' The service did not answer.'
                    : ''}
                </td>
                <td>
                  <RefFetched cell={refFetchedCell(ref?.detections ?? null, !!area)} />
                </td>
              </tr>
              <tr>
                <td>Plan wording</td>
                <td>
                  Meta Model API, muse-spark-1.3 (fallback: a fixed checklist, not tagged AI-written). Receives road names, times and household counts. No house number,
                  names or phone numbers.
                  <br />
                  <b>
                    {planSource === 'ai'
                      ? `Your current plan was written by ${plan.data?.model ?? 'muse-spark-1.3'}.`
                      : planSource === 'fallback'
                        ? 'Your current plan uses the fixed checklist: the AI writer did not answer.'
                        : 'No plan has been written yet.'}
                  </b>{' '}
                  {planSource === 'ai' && <Tag kind="ai" />}
                </td>
                <td className="muted">{planSource ? 'this session' : 'not used'}</td>
              </tr>
              <tr>
                <td>Other situations to test</td>
                <td>
                  Meta Model API, muse-spark-1.3, picks which situations fit your household from a fixed list and writes one line on why (fallback: fixed rules pick them).
                  It gets household counts, task names and minutes, road names and the drill's times. No address or coordinates.
                  <br />
                  <b>
                    {sit.status === 'idle'
                      ? 'No situations yet.'
                      : sit.status === 'loading'
                        ? 'Fixed rules picked the current situations; the AI picks are on the way.'
                        : sit.source === 'ai'
                          ? 'The AI picked your current situations.'
                          : 'Fixed rules picked your current situations: the AI did not answer.'}
                  </b>{' '}
                  {sit.status === 'ready' && sit.source === 'ai' && <Tag kind="ai" />}
                </td>
                <td className="muted">{sit.status === 'idle' ? 'not used' : 'this session'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {area && area.fallbacksUsed.length > 0 && (
          <div className="stack-s">
            <h3>What changed for this address</h3>
            <ul>
              {area.fallbacksUsed.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        {area && area.fallbacksUsed.length === 0 && <p className="small muted">Every data service answered for this address.</p>}
      </section>

      <section className="stack-s">
        <h2>How the numbers are worked out</h2>
        <p>
          <b>Fire:</b> our own grid model
          {grid ? `, ${fmtSquare(grid.size * grid.cellM, units)} in cells of ${fmtDist(grid.cellM, units)} around your home` : ''}. Each step, fire can move
          to nearby cells; wind and uphill slope make that more likely. Sea cells (ground at sea level) never burn. The same seed gives the same fire.
          {area && area.elevation === null ? ' For this address the ground is treated as flat.' : ''}
        </p>
        <p>
          <b>Road closes:</b> when the fire reaches a cell within {fmtDist(100, units)} of the road. Roads outside the fire grid are not modeled.
        </p>
        <p>
          <b>Time needed:</b> your task minutes, one after another, plus drive time to the point on your route that is tightest in this fire: where the fire beats you by the most, or leaves you the least time.
        </p>
        <p>
          <b>Time to spare:</b> the minute that point closes, minus time needed.
        </p>
        <p>
          <b>How sure is this:</b> the fire model uses random draws, so the app runs the same fire (same start, wind and day or night) 15 times with other
          random draws and shows the range of time to spare. Run 1 is the run on screen. It also runs your plan on each of those fires with evacuation
          traffic: every road takes longer to drive, by a value you can change (starting guess 1.5 times). That is a simple slowdown, not a traffic model.
        </p>
        <p>
          <b>Other situations:</b> the same simulated fire, with the day going differently (a late order, a blocked road, a pet that hides and so on). No new fire is
          simulated. The times and each next action's effect are calculated. The AI (muse-spark-1.3) only picks which situations to show and writes the one-line
          reasons; without it, fixed rules pick them. The values in each situation, like how late the order comes, are starting guesses you can change.
          A situation you type is sent to the AI only to turn it into the drill's levers (a listed situation, an added task or changed task minutes). The times
          are calculated, and you check every value before it is added.
        </p>
      </section>

      <section className="stack-s">
        <h2>Assumptions</h2>
        <ul>
          <li>The order to leave reaches you the moment the fire starts. Real orders can come later.</li>
          <li>Household tasks happen one after another.</li>
          <li>Wind speed and direction stay the same for the whole drill.</li>
          <li>Cars drive at the OpenStreetMap speed limit, or a default for the road type. Evacuation traffic is only a slowdown you set; there are no queues.</li>
          <li>A night drill adds a wake-up task. The fire spreads the same way.</li>
          <li>A drill runs for {state.before ? Math.round(state.before.fire.horizonMin / 60) : 3} hours of simulated time.</li>
        </ul>
      </section>

      <section className="stack-s">
        <h2>What this model leaves out</h2>
        <ul>
          <li>Vegetation, fuel moisture, humidity, embers jumping ahead, and firefighting.</li>
          <li>Real traffic (queues at junctions, everyone on the same road), crashes, smoke on the road, and downed power lines.</li>
          <li>Wind changes during a drill.</li>
          <li>Whether a destination is open or has room.</li>
          <li>
            Whether a destination is safe. A destination inside the fire area can be in the fire's path; the results warn when the simulated fire reaches it. A destination
            outside the fire area is not modeled at all.
          </li>
          <li>Lakes, rivers and reservoirs. Only the sea is treated as ground that cannot burn, and very low land near sea level can be mistaken for sea.</li>
          <li>Delays between a fire starting and an order reaching you.</li>
        </ul>
        <p>Real fires can move much faster than this model.</p>
      </section>
    </main>
  );
}
