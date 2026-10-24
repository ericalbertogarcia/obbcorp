# Insiders proxy (optional, near-real-time X posts)

The GitHub Action pulls beat-reporter posts every ~5 minutes. For posts within about a minute,
deploy this Cloudflare Worker. It keeps your X API token secret and caches results, so every
visitor shares one upstream request per minute.

1. Get an X API bearer token (developer.x.com; reading posts requires a paid plan).
2. `cd workers/insiders && npx wrangler deploy`
3. `npx wrangler secret put X_BEARER_TOKEN`
4. Put the worker URL in `sports/data/config.json` as `"insidersProxy"`.

Reporter handles come from `sports/data/reporters.json` at deploy time — redeploy after editing it.
Cost scales with `CACHE_SECONDS` (how often X is queried) and `WINDOW_MINUTES` (how many posts each query re-reads).
