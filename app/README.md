# Safe Passage app

Wildfire leaving drill for one home address. Practice only; not a live alert app.

## Run

```bash
npm install
npm run dev:all
```

Opens the API server on http://localhost:8787 and the app on http://localhost:5173.

- AI plan wording: put `MODEL_API_KEY=...` (Meta Model API) in `app/.env`. Without it, the plan uses a fixed checklist.
- Reference fire layer (optional, US only, not part of the drill): current fire perimeters come from NIFC WFIGS and need no key. Satellite heat detections need a free NASA FIRMS key: put `FIRMS_MAP_KEY=...` in `app/.env` and restart the server. Without it, only the perimeters are shown.
- The demo address works offline from `server/demo-area.json` and the `.cache/` folder.
- Dev shortcut: `http://localhost:5173/?demo=1#/fix` loads the demo drill with two fixes applied, for screenshots.

## Test

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.app.json
```

## Deploy

One Node 24 process serves the built app and the API.

```bash
npm ci
npm run build
npm start            # node server/prod.ts, on PORT (default 8080)
```

- Health check: `GET /api/health` returns `{"ok":true}`.
- Environment (all optional; read from the process environment, or from `app/.env` like the dev server):
  - `PORT`: listen port, default `8080`.
  - `MODEL_API_KEY`: AI plan wording. Without it, the plan uses the fixed checklist.
  - `FIRMS_MAP_KEY`: NASA FIRMS key for the satellite heat detections in the reference layer. Without it, the reference layer shows only NIFC perimeters (no key needed) and says the detections need a key.
  - `LIVE_DEMO=1`: demo requests try live data first, like the dev server. By default the saved demo (`server/demo-area.json`) is served directly, so the demo makes no outside calls.
- Keys stay on the server. The browser only calls `/api/...`; no key is ever sent to it or built into `dist/`.
- Caching: files in `dist/assets/` (hashed names) are cached for a year; `index.html` is `no-cache`, so a new build shows up on the next load. Paths without a file extension get `index.html`; paths with a segment that starts with a dot (such as `/.env`) get 404.

Docker:

```bash
docker build -t safe-passage .
docker run -p 8080:8080 -e MODEL_API_KEY=... -e FIRMS_MAP_KEY=... safe-passage
```

The image skips `node_modules`, `.env`, `.env.*` and `.cache` at any depth (see `.dockerignore`); pass keys with `-e` or your host's secret settings. The saved demo ships inside the image.

## Layout

- `src/engine/`: fire model, road graph, routing, drill evaluation, ignition suggestions (pure TypeScript, tested).
- `server/`: geocoding, roads, places, elevation, wind (cached), and `/api/plan` (Muse Spark).
- `src/screens/`, `src/ui/`: the screens from `../design/mockups/`.
