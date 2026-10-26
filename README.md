# obb-corp
obb corp apparel 

## NY Sports Bar — [nysportsbar.com](https://www.nysportsbar.com)

_The #1 site for New York sports._

News, live games, injuries, beat-reporter posts and roster moves for the Giants, Jets, Bills, Yankees, Mets, Knicks, Nets, Liberty, Devils, Rangers and Islanders.

- `sports/` — the static site, published as the root of nysportsbar.com. Team pages have Live (play-by-play, scoring, in-game injuries), Insiders, News, Injuries, Roster Moves and Roster tabs.
- `sports/data/reporters.json` — the beat reporters and national insiders we follow (X handles, optional Bluesky handles and author RSS feeds). Edit freely.
- `scripts/update-sports.mjs` — aggregates ESPN, MLB.com transactions, Google News, team RSS and reporter posts into `sports/data/feed.json`;
  detects roster adds/removals; flags X handles that no longer exist or have gone quiet. No dependencies (Node 18+).
- `.github/workflows/sports-update.yml` — runs the updater every 5 minutes and deploys `sports/` to GitHub Pages
  (Settings → Pages: Source "GitHub Actions", Custom domain `nysportsbar.com`). The feed is deployed, not committed, so git history stays clean.
- `scripts/build-pages.mjs` — prerenders a page for every team view into `dist/` (`/new-york-giants/`, `/new-york-giants/rumors/`,
  `/injuries/`, `/roster/`, `/transactions/`, …) with search titles, descriptions, canonical URLs, social tags and structured data,
  plus `sitemap.xml` and `robots.txt`. Page titles and URLs live in `sports/js/seo.mjs`.
- In the browser: live scores every 30s during games, play-by-play every 20s, Bluesky reporter posts every 60s,
  and optional desktop alerts (bell icon) for injuries and roster moves.

### Beat reporter posts on X

X only allows reading posts through its paid API. Add an `X_BEARER_TOKEN` repository secret
(Settings → Secrets and variables → Actions) to pull posts every ~5 minutes. For ~1-minute updates, also deploy the
proxy in `workers/insiders/` and put its URL in `sports/data/config.json`.

Run locally: `node scripts/update-sports.mjs && node scripts/build-pages.mjs && python3 -m http.server -d dist` then open http://localhost:8000/
