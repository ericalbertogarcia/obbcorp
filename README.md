# obb-corp
obb corp apparel 

## NY Sports Wire (`/sports`)

News, scores and roster moves for the Giants, Jets, Yankees, Mets, Devils, Rangers and Islanders.

- `sports/` — static site (open `sports/index.html` via any static host, e.g. GitHub Pages).
- `scripts/update-sports.mjs` — aggregates ESPN news/schedules/rosters, MLB.com transactions,
  Google News and team beat-outlet RSS into `sports/data/feed.json`, and detects roster
  adds/removals by diffing against the previous run. No dependencies (Node 18+).
- `.github/workflows/sports-update.yml` — runs the updater every 15 minutes and commits the feed.
- The browser also pulls live ESPN headlines and scores directly, so the page stays current between runs.
- Teams, feeds and search keywords live in `sports/data/teams.json`.

Run locally: `node scripts/update-sports.mjs && python3 -m http.server` then open http://localhost:8000/sports/
