# Safe Passage app

Wildfire leaving drill for one home address. Practice only; not a live alert app.

## Run

```bash
npm install
npm run dev:all
```

Opens the API server on http://localhost:8787 and the app on http://localhost:5173.

- AI plan wording: put `MODEL_API_KEY=...` (Meta Model API) in `app/.env`. Without it, the plan uses a fixed checklist.
- The demo address works offline from `server/demo-area.json` and the `.cache/` folder.
- Dev shortcut: `http://localhost:5173/?demo=1#/fix` loads the demo drill with two fixes applied, for screenshots.

## Test

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.app.json
```

## Layout

- `src/engine/`: fire model, road graph, routing, drill evaluation, ignition suggestions (pure TypeScript, tested).
- `server/`: geocoding, roads, places, elevation, wind (cached), and `/api/plan` (Muse Spark).
- `src/screens/`, `src/ui/`: the screens from `../design/mockups/`.
