# Development

## Setup

```
npm install
cp .env.example .env   # optional; defaults are fine
npm start              # dev mode, with HMR
```

Electron 44, built with electron-vite (Vite 8), React 19 and TypeScript 7.
All npm scripts go through `scripts/run.js`, which clears
`ELECTRON_RUN_AS_NODE` first. Some shells (VS Code integrated terminals, some
tooling) set that variable, and when it's set Electron quietly runs as plain
Node and no window opens.

| Command | What |
|---|---|
| `npm start` (or `npm run dev`) | Development: **HMR** for the UI (React Fast Refresh, so edits apply while you keep your place, filters and typed text). Preload changes reload the window. Main-process changes restart the app, but batched (a burst of saves is one restart), and only once it's idle: a Sync, reveal or download batch in progress finishes first. The app quits normally, so your login is flushed to disk. Type `rs` + Enter in the terminal to restart by hand (`scripts/dev.mjs`). DevTools opens for the UI. |
| `npm run prod` | Build, then run the built app (no watching, no DevTools). |
| `npm run build` | Build to `out/` only. |
| `npm run typecheck` | Type-check everything (`tsc -b`, strict). |
| `npm run dist` (`dist:win`, `dist:linux`, `dist:mac`) | Build the installers and archives into `release/<version>/` (see [RELEASING.md](RELEASING.md)). |
| `npm run scrub-data` | Re-scrub existing scout dumps (see [Scrubbing](scouting.md#scrubbing)). |

The dev server binds to `127.0.0.1` and picks a free port at startup
(15173 first). Windows reserves shifting blocks of ports (Hyper-V, WSL), and
Vite's default 5173 is often inside one.

## Code layout

| Path | What |
|---|---|
| `src/main/index.ts` | Main process: window, Sync, keys, downloads, scouting/harvesting, IPC handlers |
| `src/main/lib/` | The pieces: Humble API clients, RSC decoder, scrubber, downloader, library/orders/Choice parsing, settings and data paths |
| `src/preload/index.ts` | Exposes the IPC API to the UI as `window.humbler` |
| `src/renderer/` | React UI: `tabs/` (Keys, Bundles, Choice, Downloads, Library, Scout & Log), `components/`, `store.tsx` (app state fed by IPC) |
| `src/shared/` | Types shared by both sides: the library data and **the whole IPC API** (`api.ts`). Main and UI can't drift apart. |

