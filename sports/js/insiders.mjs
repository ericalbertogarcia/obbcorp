// Beat-reporter and insider posts (X, Bluesky), shared by the browser app,
// scripts/update-sports.mjs and the optional workers/insiders proxy.

export const MOVE_WORDS = /\b(signs?|signed|signing|re-signs?|re-signed|re-signing|waived?|waives|waiving|releases?|released|releasing|trades?|traded|trading|acquires?|acquired|acquiring|claims?|claimed|claiming|activated?|placed|recalls?|recalled|optioned|reassigned|designated for assignment|DFA|injured reserve|injured list|extension|called up|promoted|cuts?)\b/i;
export const INJURY_WORDS = /\b(injur(y|ed|ies)|hurt|carted|concussion|evaluated|questionable to return|doubtful to return|ruled out|out for the (game|night|season)|left the game|limped|trainers?|blue tent|medical tent|day-to-day|MRI|X-rays?|sprain(ed)?|strain(ed)?|torn|fracture[d]?|IL\b|IR\b|surgery|sidelined|exited)\b/i;

// Speculation rather than a done deal: interest, talks, targets, "could/expected to" sign or trade.
export const RUMOR_WORDS = /\b(rumou?rs?|rumou?red|rumblings|chatter|buzz|whispers|speculation|hot stove|linked to|(has|have|had|showing|shown|showed|expressed) interest|interest in|interested in|in talks|talks with|trade talks|discussions? with|discussing|exploring|explore|eyeing|targeting|trade (candidate|target|market|block|bait|chip|idea)s?|on the (trade )?block|shopping|kick(ed|ing|s)? the tires|checked in on|checking in on|monitoring|in the mix|front-?runners?|suitors?|pursu(e|es|ed|ing|it)|considering|weighing|could (trade|sign|land|acquire|deal|move|pursue|target|re-sign)|might (trade|sign|deal)|would (trade|sign|move|deal)|expected to (sign|trade|pursue|meet|visit|re-sign)|plan(s|ning)? to (sign|trade|pursue)|mock trade|potential (trade|deal|target)|possible (trade|deal|target)|deadline (buzz|chatter|target|deal)s?)\b/i;

// One place decides what a headline or post is. A rumor is never also counted as a move,
// so "Yankees interested in trading for X" stays out of the moves wire.
export function classify(text, { rumorSource = false } = {}) {
  const move = MOVE_WORDS.test(text);
  const isRumor = RUMOR_WORDS.test(text) || (rumorSource && !move);
  return { isRumor, isMove: move && !isRumor, isInjury: INJURY_WORDS.test(text) };
}

const X_QUERY_LIMIT = 480; // X recent search caps query length at 512 on the lower tiers.

// One flat list; national insiders carry `league` and no team.
export function flattenReporters(dir) {
  const out = [];
  for (const [team, list] of Object.entries(dir.teams || {})) for (const r of list) out.push({ ...r, team });
  for (const r of dir.national || []) out.push({ ...r, team: null });
  return out;
}

// National insiders cover a whole league, where a nickname like "Giants" or "Rangers" is unambiguous.
export function teamsForPost(text, reporter, teams) {
  if (reporter.team) return [reporter.team];
  return teams
    .filter((t) => t.league === reporter.league)
    .filter((t) => [t.name, t.full, ...(t.keywords || [])].some((k) => new RegExp(`\\b${k}\\b`, 'i').test(text)))
    .map((t) => t.key);
}

function post({ id, platform, reporter, text, url, published, avatar, image, teams }) {
  return {
    id, platform, url, published, text,
    reporter: reporter.name, outlet: reporter.outlet, handle: platform === 'bsky' ? reporter.bsky : reporter.x,
    avatar: avatar || '', image: image || '',
    teams: teamsForPost(text, reporter, teams),
    ...classify(text),
    national: !reporter.team,
  };
}

// ── X (Twitter) API v2 recent search ──

export function buildXQueries(reporters) {
  const handles = reporters.filter((r) => r.x).map((r) => `from:${r.x}`);
  const queries = [];
  let cur = [];
  const wrap = (parts) => `(${parts.join(' OR ')}) -is:retweet -is:reply`;
  for (const h of handles) {
    if (cur.length && wrap([...cur, h]).length > X_QUERY_LIMIT) { queries.push(wrap(cur)); cur = []; }
    cur.push(h);
  }
  if (cur.length) queries.push(wrap(cur));
  return queries;
}

export function xSearchUrl(query, { sinceId, startTime, maxResults = 100 } = {}) {
  const p = new URLSearchParams({
    query,
    max_results: String(maxResults),
    'tweet.fields': 'created_at,author_id,attachments',
    expansions: 'author_id,attachments.media_keys',
    'user.fields': 'username,name,profile_image_url',
    'media.fields': 'url,preview_image_url,type',
  });
  if (sinceId) p.set('since_id', sinceId);
  else if (startTime) p.set('start_time', startTime);
  return `https://api.x.com/2/tweets/search/recent?${p}`;
}

export function parseXSearch(json, reporters, teams) {
  const users = new Map((json.includes?.users || []).map((u) => [u.id, u]));
  const media = new Map((json.includes?.media || []).map((m) => [m.media_key, m]));
  const byHandle = new Map(reporters.filter((r) => r.x).map((r) => [r.x.toLowerCase(), r]));
  return (json.data || []).flatMap((t) => {
    const user = users.get(t.author_id);
    const reporter = user && byHandle.get(user.username.toLowerCase());
    if (!reporter) return [];
    const m = (t.attachments?.media_keys || []).map((k) => media.get(k)).find(Boolean);
    const p = post({
      id: `x-${t.id}`, platform: 'x', reporter, text: t.text,
      url: `https://x.com/${user.username}/status/${t.id}`,
      published: t.created_at, avatar: user.profile_image_url,
      image: m?.url || m?.preview_image_url, teams,
    });
    return p.teams.length ? [p] : [];
  });
}

// ── Bluesky public AppView (no auth, CORS-enabled, so the browser can poll it directly) ──

export const bskyFeedUrl = (handle) =>
  `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=20&filter=posts_no_replies`;

export function parseBskyFeed(json, reporter, teams) {
  return (json.feed || []).filter((f) => !f.reason).flatMap(({ post: p }) => {
    const text = p.record?.text || '';
    const rkey = p.uri.split('/').pop();
    const out = post({
      id: `bsky-${rkey}`, platform: 'bsky', reporter, text,
      url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
      published: p.record?.createdAt || p.indexedAt, avatar: p.author.avatar,
      image: p.embed?.images?.[0]?.thumb || p.embed?.external?.thumb, teams,
    });
    return out.teams.length && text ? [out] : [];
  });
}

export function mergePosts(...lists) {
  const map = new Map();
  for (const p of lists.flat()) if (p?.id && !map.has(p.id)) map.set(p.id, p);
  return [...map.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}
