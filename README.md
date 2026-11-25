# Second Brain

A glowing neuron-style graph of your Notion uni notes (Vite + React + react-force-graph-2d). No paid APIs, no database.

## Setup
1. Create a Notion internal integration and share your **Second Year** page with it (••• → Connections).
2. Copy `.env.example` to `.env` and set `NOTION_TOKEN=...`. Never commit `.env` (it is git-ignored).
3. `npm install`

## Commands
- `npm run sync` – pulls pages from Notion into `data/pages.json` (cached by last-edited time in `data/cache.json`; ~3 requests/s, retries on 429).
- `npm run graph` – builds `public/graph.json` from `data/pages.json`.
- `npm run build-data` – both of the above.
- `npm run dev` – local site. `npm run build` – production build in `dist/`.

## config.json
- `rootTitle` – only pages under this page are used ("Second Year").
- `excludeTitles` – pages (and everything under them) to skip. Templates are hidden automatically.
- `aliases` – `"Reading title (substring)": ["other names"]`. A note whose text names an alias (whole word, min 5 chars) gets a `reference` link to that reading. Reading titles are also used automatically.
- `concepts` – `{ name, terms }` hub nodes; `*` is a prefix wildcard (`transparen*`). A note needs `minConceptHits` matches, and a concept needs ≥ 2 notes.

Link kinds: `parent`, `mention` (Notion @mentions/links), `reference`, `week` (same date within a module), `concept`.

## Privacy
`data/`, `public/graph.json` and `.env` contain your notes/secrets and are git-ignored. Note that `npm run build` copies `graph.json` into `dist/`.
If you deploy to Vercel, the site **must be private / password-protected** (Vercel Authentication or similar), otherwise your notes are public.
