// Near-real-time beat-reporter feed for NY Sports Bar.
// Holds the X API token server-side; the site polls this every minute.
// Deploy: see workers/insiders/README.md.

import teams from '../../sports/data/teams.json';
import directory from '../../sports/data/reporters.json';
import { flattenReporters, buildXQueries, xSearchUrl, parseXSearch, mergePosts } from '../../sports/js/insiders.mjs';

const reporters = flattenReporters(directory);
const queries = buildXQueries(reporters);

export default {
  async fetch(request, env, ctx) {
    const headers = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'content-type': 'application/json',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (!env.X_BEARER_TOKEN) return new Response('{"error":"X_BEARER_TOKEN secret not set"}', { status: 500, headers });

    // One upstream fetch per cache window per edge location, however many visitors poll.
    const cacheSeconds = Number(env.CACHE_SECONDS || 60);
    const cache = caches.default;
    const cacheKey = new Request(new URL('/insiders', request.url));
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { ...headers, 'x-cache': 'hit' } });

    // Only the last few minutes are requested, so each call reads just the newest posts.
    const startTime = new Date(Date.now() - Number(env.WINDOW_MINUTES || 15) * 60e3).toISOString();
    const results = await Promise.allSettled(queries.map(async (q) => {
      const res = await fetch(xSearchUrl(q, { startTime, maxResults: 100 }), { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } });
      if (!res.ok) throw new Error(`X API ${res.status}`);
      return parseXSearch(await res.json(), reporters, teams);
    }));
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      posts: mergePosts(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value)),
      errors: results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message || String(r.reason)),
    });
    const res = new Response(body, { headers: { ...headers, 'cache-control': `public, max-age=${cacheSeconds}` } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
