// Sanity check on the saved demo address data: the drill must be able to close a road.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { AreaData, Wind } from '../src/engine/types';
import { prepareArea } from '../src/engine/area';
import { defaultTasks, runDrill } from '../src/engine/drill';
import { suggestIgnitions } from '../src/engine/ignition';

const area = JSON.parse(readFileSync(new URL('../server/demo-area.json', import.meta.url), 'utf8')) as AreaData;

it('demo address produces a drill where a road closes', () => {
  const p = prepareArea(area);
  const w = p.waysOut;
  const dest = (id?: string) => w.destinations.find((d) => d.id === id);
  console.log('roads', p.graph.edges.length, 'destinations', w.destinations.map((d) => `${d.label} (${Math.round(Math.hypot(d.xy.x, d.xy.y))} m)`));
  console.log('main', w.main?.roadNames, Math.round(w.main?.driveMin ?? 0), 'min ->', dest(w.main?.destinationId)?.label);
  console.log('backup', w.backup?.roadNames, Math.round(w.backup?.driveMin ?? 0), 'min ->', dest(w.backup?.destinationId)?.label);
  console.log('shared from door m', Math.round(w.sharedFromDoorM), w.sharedRoadNames);
  const tasks = defaultTasks({ adults: 2, children: 1, needHelpMoving: 1, dogs: 1, catsAndSmallPets: 1, cars: 1 });
  console.log('tasks', tasks.map((t) => `${t.label} ${t.minutes}`).join(', '));
  const mainShape = w.main ? w.main.edgeIds.flatMap((id) => p.graph.edges[id].shape) : [];
  let closed = 0;
  for (const wind of [area.wind!, { fromDeg: area.wind!.fromDeg, speedMph: 20, source: 'manual' } as Wind, { fromDeg: 315, speedMph: 25, source: 'manual' } as Wind, { fromDeg: 45, speedMph: 25, source: 'manual' } as Wind]) {
    const backupShape = w.backup ? w.backup.edgeIds.flatMap((id) => p.graph.edges[id].shape) : [];
    const sugg = suggestIgnitions(p.fireGrid, p.elevationPerCell, wind, p.homeXY, mainShape, [backupShape]);
    for (const s of sugg) {
      const r = runDrill(p, tasks, { ignition: s.xy, wind, start: 'day', seed: 1 });
      const b = r.main?.binding;
      if (r.main?.outcome !== 'never_closed') closed++;
      console.log(`wind ${wind.fromDeg}/${wind.speedMph} | ${s.label} (${s.reason}) | tasks ${r.tasksMin} | main ${r.main?.outcome}${b ? ` ${b.name} closes T+${Math.round(b.closeMin)} pass T+${Math.round(b.passMin)} margin ${Math.round(b.marginMin)}` : ''} | backup ${r.backup?.outcome}${r.backup?.binding ? ` margin ${Math.round(r.backup.binding.marginMin)}` : ''}`);
    }
  }
  expect(closed).toBeGreaterThan(0);
});
