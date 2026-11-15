# FeetOnFire (StepMania-compatible browser game)

TypeScript rewrite; StepMania 5.1 (`stepmania-5_1-new/`) is the behaviour reference only.
Decisions: `docs/OPTIONS.md`. Plan and v1 scope: `docs/PLAN.md`. Latency model and targets: `docs/LATENCY.md`.

## Latency Lab

```
npm install
npm run build
npm run serve        # http://localhost:5173/lab/  (binds 127.0.0.1 only)
```

Use desktop Chrome. Run the sections top to bottom, then download `latency-report.json`.

## Play

```
npm install
npm run build
npm run serve        # http://localhost:5173/  (binds 127.0.0.1 only)
```

Use desktop Chrome. **Social packs** is the primary source: it reads `haven.file.full`
Arkiv records whose payload carries a `stepmania-pack` manifest under `payload.x.dance`
(one ZIP per pack), shows the
advisory song list, and imports through the same ZIP pipeline as local files. A pack marked
`sample` with a clear `fcid` plays without a wallet; gated packs require a wallet whose
`balanceOf` meets the Arkiv gate threshold, and sealed packs still need the normal Haven-AOL
epoch unlock. Local folder/zip import remains available.

Copy `.env.example` to `.env` for WalletConnect/Arkiv/AOL endpoints; without a project id the
wallet button explains that social gating is not configured, while clear samples still work.
Songs and scores stay in the browser's own storage on this machine.

## Deploy (PinMe)

`.github/workflows/deploy.yml` builds on pushes to `main` and uploads a staged `out/`
directory containing `index.html`, `app.css`, and `dist/` so `/dist/app/main.js` resolves.

GitHub Actions secrets:

- `PINME_APPKEY` — PinMe deployment key
- `VITE_DANCE_WALLETCONNECT_PROJECT_ID` — WalletConnect/AppKit project id
- `VITE_DANCE_ARKIV_API_KEY` — optional Arkiv API key
- `VITE_DANCE_SYNAPSE_API_KEY` — optional Synapse API key

GitHub Actions variables:

- `PINME_DOMAIN=feetonfire` — PinMe subdomain (dotless; PinMe adds the public host)
- optional `VITE_DANCE_*` endpoint overrides matching `.env.example`

Note: cross-origin isolation is optional. With COOP/COEP the game uses `SharedArrayBuffer`;
on hosts like PinMe it falls back to message passing, which may add a little input/clock jitter.

## Checks

```
npm run typecheck
npm run build
```

## Layout

- `src/shared/` — pure modules (statistics, event ring, clock map, signal detection)
- `src/chart/` — SM/SSC loader, timing, note data
- `src/audio/` — decoding, mixer worklet, audio clock
- `src/game/` — judging, scoring, life, note field, game worker, play page
- `src/lab/` — Latency Lab (input, audio, video, microphone tests)
- `src/app/` — the game's page: import, song list, settings, results
- `app/` — the game's HTML and CSS
- `lab/` — Lab page; `lab/play/` — bare gameplay test page
- `scripts/dev-server.mjs` — loopback-only static server with the COOP/COEP headers
