// Screen 9: how this plan was made. Sources with real fetch times, fallbacks, method, assumptions and limits.
import { useApp } from '../app/state';
import { loadedInfo } from '../app/load';
import { Tag } from '../ui/Tag';
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
  const grid = prepared?.fireGrid;
  const none = area ? 'not used' : 'no address yet';

  return (
    <main className="narrow">
      <div className="stack">
        <h1>How this plan was made</h1>
        <p>Three kinds of information appear in Safe Passage:</p>
        <p>
          <Tag kind="calc" /> worked out by code from data.
        </p>
        <p>
          <Tag kind="est" /> a number you gave or accepted.
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
                <td>OpenStreetMap via Overpass (fallback: a second Overpass server)</td>
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
                <td>Our own shortest-time routing on the OpenStreetMap road graph, run in your browser. No traffic.</td>
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
                <td>Recent heat detections (reference)</td>
                <td>
                  NASA FIRMS; NIFC perimeters in the US. Reference only, never part of the drill.
                  {area && area.country !== 'us' ? ' Outside the US, official perimeters are hidden.' : ''}
                </td>
                <td className="muted">not used</td>
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
          {grid ? `, ${(grid.size * grid.cellM) / 1000} × ${(grid.size * grid.cellM) / 1000} km at ${grid.cellM} m cells around your home` : ''}. Each step, fire can move
          to nearby cells; wind and uphill slope make that more likely. The same seed gives the same fire.
          {area && area.elevation === null ? ' For this address the ground is treated as flat.' : ''}
        </p>
        <p>
          <b>Road closes:</b> when the fire reaches a cell within 100 m of the road. Roads outside the fire grid are not modeled.
        </p>
        <p>
          <b>Time needed:</b> your task minutes, one after another, plus drive time to the point on your route that is tightest in this fire: where the fire beats you by the most, or leaves you the least time.
        </p>
        <p>
          <b>Time to spare:</b> the minute that point closes, minus time needed.
        </p>
      </section>

      <section className="stack-s">
        <h2>Assumptions</h2>
        <ul>
          <li>The order to leave reaches you the moment the fire starts. Real orders can come later.</li>
          <li>Household tasks happen one after another.</li>
          <li>Wind speed and direction stay the same for the whole drill.</li>
          <li>Cars drive at the OpenStreetMap speed limit, or a default for the road type, with no traffic.</li>
          <li>A night drill adds a wake-up task. The fire spreads the same way.</li>
          <li>A drill runs for {state.before ? Math.round(state.before.fire.horizonMin / 60) : 3} hours of simulated time.</li>
        </ul>
      </section>

      <section className="stack-s">
        <h2>What this model leaves out</h2>
        <ul>
          <li>Vegetation, fuel moisture, humidity, embers jumping ahead, and firefighting.</li>
          <li>Traffic, crashes, smoke on the road, and downed power lines.</li>
          <li>Wind changes during a drill.</li>
          <li>Whether a destination is open or has room.</li>
          <li>Delays between a fire starting and an order reaching you.</li>
        </ul>
        <p>Real fires can move much faster than this model.</p>
      </section>
    </main>
  );
}
