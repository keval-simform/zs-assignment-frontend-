# Setup

Everything runs client-side. No backend, no database, no API keys, no environment
variables. The 50,000-row dataset is generated in the browser from a fixed seed.

Architecture and design notes: **[README.md](./README.md)** ·
Data defects and resolved ambiguities: **[ASSUMPTIONS.md](./ASSUMPTIONS.md)**

---

## Prerequisites

- **Node.js ≥ 20** (enforced by `engines`; developed on 22.x)
- **npm ≥ 10** — any package manager works, `package-lock.json` is npm's
- Any modern evergreen browser

## Install and run

```bash
npm install
npm run dev
```

Open **http://localhost:5173**.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR on port 5173 |
| `npm run build` | `tsc -b` then a production bundle into `dist/` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module '../vendor/…'` or missing vendor types | The vendor project hasn't been built. Run `npm run typecheck` (always `tsc -b`, never plain `tsc`). |
| Typecheck picks up stale results | Delete `.tsbuild/` and `tsconfig.app.tsbuildinfo`, then `npm run typecheck`. |
| Port 5173 already in use | `npm run dev -- --port 5174` |
