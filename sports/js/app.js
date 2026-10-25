import { leagueBase, espnNews, espnRoster, gameSummary, betResults, resultsRecord } from './espn.mjs';
import { INJURY_WORDS, classify, flattenReporters, bskyFeedUrl, parseBskyFeed, mergePosts } from './insiders.mjs';
import { parseSummary } from './gamecenter.mjs';
import { teamPath, parsePath, teamMeta, homeMeta } from './seo.mjs';

const FEED_REFRESH_MS = 5 * 60 * 1000;
const SCORES_REFRESH_MS = 30 * 1000;
const INSIDERS_REFRESH_MS = 60 * 1000;
const GAME_REFRESH_MS = 20 * 1000;
const BREAKING_MS = 20 * 60 * 1000;
const PAGE_SIZE = 30;

const state = {
  teams: [],
  byKey: {},
  config: {},
  reporters: [],
  feed: { teams: {}, news: [], moves: [], insiders: [] },
  live: { news: [], teams: {}, games: {}, rosters: {}, insiders: [], summaries: {}, summaryTried: new Set(), recaps: {}, recapTried: new Set() },
  seenPosts: null,
  freshPosts: new Set(),
  query: '',
  kind: 'all',
  shown: PAGE_SIZE,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
// Dark text on light team colors (e.g. Liberty seafoam), white otherwise.
const onColor = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? '#0b0d12' : '#fff';
};
const teamVars = (t) => (t ? `--c1:${t.colors[0]};--c2:${t.colors[1]};--on-c1:${onColor(t.colors[0])}` : '');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

async function getJSON(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function timeAgo(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const fmtGameTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
const isLive = (key) => state.live.games[key]?.state === 'in';

// ───────────────────────── betting lines ─────────────────────────

const RG_NOTE = 'Odds are for information only. 21+. Gambling problem? Call 1-877-8-HOPENY or text HOPENY (467369).';
const signed = (n) => (n == null ? '' : n === 0 ? 'PK' : n > 0 ? `+${n}` : `${n}`);
// Football and basketball bet the spread; baseball and hockey are moneyline sports.
const spreadSport = (t) => t.sport === 'football' || t.sport === 'basketball';

// The team's next or current game with its line: today's scoreboard first, then the feed's next game.
function lineGame(key) {
  const live = state.live.games[key];
  const next = teamInfo(key).nextGame;
  const g = live && live.state !== 'post' ? live : next && next.state !== 'post' ? next : null;
  if (!g) return null;
  const odds = g.odds || (next && next.id === g.id ? next.odds : null);
  return odds ? { ...g, odds } : g;
}

// "-3.5" for spread sports, "-150" for moneyline sports.
function headlineLine(t, odds) {
  if (!odds) return '';
  if (spreadSport(t) && odds.spread != null) return signed(odds.spread);
  return odds.ml != null ? signed(odds.ml) : odds.spread != null ? signed(odds.spread) : '';
}

function oddsCells(t, odds) {
  const abbr = t.espn.toUpperCase();
  return [
    odds.spread != null ? [spreadSport(t) ? 'Spread' : t.sport === 'baseball' ? 'Run line' : 'Puck line', `${abbr} ${signed(odds.spread)}`] : null,
    odds.ml != null ? ['Moneyline', `${abbr} ${signed(odds.ml)}${odds.oppMl != null ? ` / ${signed(odds.oppMl)}` : ''}`] : null,
    odds.total != null ? ['Total', `O/U ${odds.total}`] : null,
  ].filter(Boolean);
}

function oddsStripHTML(t, odds, { label = '' } = {}) {
  if (!odds) return '';
  return `<div class="odds">${oddsCells(t, odds).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('')}
    <div class="odds-src">${label ? `${esc(label)} · ` : ''}${esc(odds.provider)}</div></div>`;
}

function linesPanelHTML() {
  const rows = state.teams.map((t) => ({ t, g: lineGame(t.key) }))
    .filter(({ g }) => g && g.state !== 'post' && Date.parse(g.date) - Date.now() < 8 * 864e5)
    .sort((a, b) => Date.parse(a.g.date) - Date.parse(b.g.date));
  if (!rows.length) return '<div class="empty">No upcoming games this week.</div>';
  return `<ul class="lines">${rows.map(({ t, g }) => `<li style="${teamVars(t)}"><a href="${teamPath(t, g.state === 'in' ? 'game' : 'news')}">
      <div class="ln-top">${badges([t.key])}<span>${g.home ? 'vs' : '@'} ${esc(g.opponentAbbr || g.opponent)}</span>
        <span class="ln-when">${g.state === 'in' ? '<b class="live-txt">LIVE</b>' : esc(fmtGameTime(g.date))}</span></div>
      ${g.odds ? `<div class="ln-odds">${oddsCells(t, g.odds).map(([k, v]) => `<span><em>${k}</em> ${esc(v)}</span>`).join('')}</div>` : '<div class="ln-odds muted">Line not posted yet</div>'}
    </a></li>`).join('')}</ul><p class="rg">${esc(RG_NOTE)}</p>`;
}

// ───────────────────────── data merging ─────────────────────────

function teamInfo(key) {
  return { ...(state.feed.teams?.[key] || {}), ...(state.live.teams[key] || {}) };
}

function allNews() {
  const map = new Map();
  for (const item of [...state.live.news, ...(state.feed.news || [])]) {
    const k = normTitle(item.title);
    const prev = map.get(k);
    if (prev) prev.teams = [...new Set([...prev.teams, ...item.teams])];
    else map.set(k, { ...item, teams: [...item.teams] });
  }
  return [...map.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
}

function allInsiders(teamKey) {
  return mergePosts(state.live.insiders, state.feed.insiders || []).filter((p) => !teamKey || p.teams.includes(teamKey));
}

// Official transactions + roster diffs from the feed, plus moves reported by headlines and beat reporters.
function allMoves(teamKey) {
  const official = (state.feed.moves || []).map((m) => ({ ...m, kind: 'official' }));
  const reported = allNews().filter((n) => n.isMove).flatMap((n) => n.teams.map((team) => ({
    id: `news-${team}-${n.id || normTitle(n.title)}`, team, date: n.published, type: 'Reported',
    description: n.title, url: n.url, source: n.source, kind: 'reported',
  })));
  const insider = allInsiders().filter((p) => p.isMove).flatMap((p) => p.teams.map((team) => ({
    id: `ins-${team}-${p.id}`, team, date: p.published, type: 'Insider report',
    description: p.text, url: p.url, source: `${p.reporter} · ${p.outlet}`, kind: 'reported',
  })));
  return [...official, ...reported, ...insider]
    .filter((m) => !teamKey || m.team === teamKey)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

// Everything injury-related for a team (or all teams): in-game plays, reporter posts, headlines, roster statuses.
// Unconfirmed reports: rumor-flagged headlines (incl. trade-rumor sites) and reporter posts, newest first.
function rumorItems(teamKey) {
  const since = Date.now() - 14 * 864e5;
  const news = allNews().filter((n) => n.isRumor && (!teamKey || n.teams.includes(teamKey)) && Date.parse(n.published) > since)
    .map((n) => ({ kind: 'news', teams: n.teams, text: n.title, summary: n.summary, url: n.url, source: n.source, date: n.published }));
  const posts = allInsiders(teamKey).filter((p) => p.isRumor && Date.parse(p.published) > since)
    .map((p) => ({ kind: 'post', teams: p.teams, text: p.text, url: p.url, source: `${p.reporter} · ${p.outlet}`, date: p.published }));
  return [...news, ...posts].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

const RUMOR_NOTE = 'Rumors are unconfirmed reports from the outlets and reporters linked.';

function rumorListHTML(items, { compact = false, limit = 50 } = {}) {
  if (!items.length) return '<div class="empty">No trade or signing rumors in the last two weeks.</div>';
  return `<ul class="moves rumors">${items.slice(0, limit).map((r) => {
    const t = state.byKey[r.teams[0]];
    return `<li class="move" style="${teamVars(t)}"><span class="bar"></span><div>
      <div class="meta">${compact ? badges(r.teams) : ''}<span class="badge rumor">Rumor</span><span>${esc(timeAgo(r.date))}</span></div>
      <a class="desc" href="${safeUrl(r.url)}" target="_blank" rel="noopener">${esc(r.text)}</a>
      ${!compact && r.summary ? `<p class="rsum">${esc(r.summary)}</p>` : ''}
      <div class="meta"><span>${esc(r.source)}</span>${r.kind === 'post' ? '<span class="plat">Reporter post</span>' : ''}</div>
    </div></li>`;
  }).join('')}</ul><p class="rg">${esc(RUMOR_NOTE)}</p>`;
}

function injuryItems(teamKey) {
  const since = Date.now() - 3 * 864e5;
  const keys = teamKey ? [teamKey] : state.teams.map((t) => t.key);
  const plays = keys.flatMap((k) => (state.live.summaries[k]?.inGameInjuries || []).map((p) => ({
    team: k, kind: 'In-game', text: `${p.period} ${p.clock} — ${p.text}`, date: new Date().toISOString(), live: true,
  })));
  const posts = allInsiders(teamKey).filter((p) => p.isInjury && Date.parse(p.published) > since).flatMap((p) => p.teams
    .filter((k) => keys.includes(k)).map((team) => ({ team, kind: p.reporter, sub: p.outlet, text: p.text, url: p.url, date: p.published })));
  const news = allNews().filter((n) => n.isInjury || INJURY_WORDS.test(n.title)).filter((n) => Date.parse(n.published) > since)
    .flatMap((n) => n.teams.filter((k) => keys.includes(k)).map((team) => ({ team, kind: n.source, text: n.title, url: n.url, date: n.published })));
  return [...plays, ...posts, ...news].sort((a, b) => (b.live - a.live) || Date.parse(b.date) - Date.parse(a.date));
}

function currentGame(key) {
  const live = state.live.games[key];
  if (live) return live;
  const info = teamInfo(key);
  const next = info.nextGame;
  // Show the last result for a day after it ends, otherwise the next game.
  if (info.lastGame && (!next || Date.now() - Date.parse(info.lastGame.date) < 30 * 3600 * 1000)) return info.lastGame;
  return next || null;
}

// ───────────────────────── loading ─────────────────────────

async function loadFeed() {
  try {
    state.feed = await getJSON(`/data/feed.json?t=${Date.now()}`);
  } catch {
    // No feed yet (first deploy) — the live browser fetches below fill in.
  }
}

async function loadLiveNews() {
  const results = await Promise.allSettled(state.teams.map(async (team) => {
    const info = teamInfo(team.key);
    const id = info.espnId || team.espn;
    const json = await getJSON(`${leagueBase(team)}/news?team=${id}&limit=25`);
    return espnNews(json).map((n) => ({ ...n, teams: [team.key], ...classify(n.title) }));
  }));
  const fresh = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (fresh.length) state.live.news = fresh;
}

// Fills team records/schedule in the browser when the generated feed doesn't have them yet.
async function loadLiveTeams() {
  await Promise.allSettled(state.teams.filter((t) => !state.feed.teams?.[t.key]?.record).map(async (team) => {
    const { team: t } = await getJSON(`${leagueBase(team)}/teams/${team.espn}`);
    state.live.teams[team.key] = {
      espnId: t.id,
      logo: t.logos?.[0]?.href || '',
      record: t.record?.items?.find((i) => i.type === 'total')?.summary || t.record?.items?.[0]?.summary || '',
      standing: t.standingSummary || '',
      nextGame: t.nextEvent?.[0] ? gameSummary(t.nextEvent[0], t.id, team.sport) : null,
    };
  }));
}

async function loadScoreboards() {
  const leagues = [...new Set(state.teams.map((t) => leagueBase(t)))];
  const boards = await Promise.allSettled(leagues.map((base) => getJSON(`${base}/scoreboard`).then((j) => [base, j])));
  const games = { ...state.live.games };
  for (const b of boards) {
    if (b.status !== 'fulfilled') continue;
    const [base, json] = b.value;
    for (const team of state.teams.filter((t) => leagueBase(t) === base)) {
      const id = teamInfo(team.key).espnId;
      const isUs = (c) => String(c.id) === String(id) || c.team?.abbreviation?.toLowerCase() === team.espn;
      const ev = (json.events || []).find((e) => e.competitions?.[0]?.competitors?.some(isUs));
      if (!ev) { delete games[team.key]; continue; }
      games[team.key] = { ...gameSummary(ev, ev.competitions[0].competitors.find(isUs).id, team.sport), espnTeamId: ev.competitions[0].competitors.find(isUs).id };
    }
  }
  state.live.games = games;
}

// Play-by-play, scoring and injuries for one team's game of the day.
async function loadSummary(key) {
  const g = state.live.games[key];
  if (!g?.id || g.state === 'pre') return;
  state.live.summaryTried.add(key);
  const team = state.byKey[key];
  try {
    const json = await getJSON(`${leagueBase(team)}/summary?event=${g.id}`);
    const prev = state.live.summaries[key];
    const next = parseSummary(json, g.espnTeamId || teamInfo(key).espnId, team.sport);
    // Alert on injury plays that weren't there on the previous poll.
    if (prev) {
      const seen = new Set(prev.inGameInjuries.map((p) => p.id));
      for (const p of next.inGameInjuries) if (!seen.has(p.id)) notify(`${team.name} injury alert`, p.text, teamPath(team, 'game'));
    }
    state.live.summaries[key] = next;
  } catch {
    // Keep the last good summary.
  }
}

// Box score for the team's most recent finished game (not today's), loaded when its game tab opens.
async function loadRecap(key, id = teamInfo(key).lastGame?.id) {
  if (!id || state.live.recapTried.has(id)) return;
  state.live.recapTried.add(id);
  const team = state.byKey[key];
  try {
    const json = await getJSON(`${leagueBase(team)}/summary?event=${id}`);
    state.live.recaps[id] = parseSummary(json, teamInfo(key).espnId, team.sport);
  } catch {
    // The recap section says it's unavailable.
  }
  render();
}

async function loadRoster(key) {
  if (teamInfo(key).roster?.length || state.live.rosters[key]) return;
  const team = state.byKey[key];
  state.live.rosters[key] = 'loading';
  try {
    const json = await getJSON(`${leagueBase(team)}/teams/${teamInfo(key).espnId || team.espn}/roster`);
    state.live.rosters[key] = espnRoster(json);
  } catch {
    state.live.rosters[key] = [];
  }
  render();
}

// Bluesky is polled straight from the browser; X comes through the optional proxy (see workers/insiders).
async function loadLiveInsiders() {
  const jobs = state.reporters.filter((r) => r.bsky).map((r) =>
    getJSON(bskyFeedUrl(r.bsky)).then((j) => parseBskyFeed(j, r, state.teams)));
  if (state.config.insidersProxy) jobs.push(getJSON(state.config.insidersProxy).then((j) => j.posts || []));
  const results = await Promise.allSettled(jobs);
  const posts = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (posts.length) state.live.insiders = mergePosts(posts, state.live.insiders).slice(0, 400);
  trackNewPosts();
}

// Marks posts that arrived since the last poll and alerts on breaking moves/injuries.
function trackNewPosts() {
  const posts = allInsiders();
  if (!state.seenPosts) { state.seenPosts = new Set(posts.map((p) => p.id)); return; }
  for (const p of posts) {
    if (state.seenPosts.has(p.id)) continue;
    state.seenPosts.add(p.id);
    state.freshPosts.add(p.id);
    if (p.isInjury || p.isMove) notify(`${p.isInjury ? 'Injury' : 'Roster move'} · ${p.reporter}`, p.text, p.url);
  }
}

async function refreshAll() {
  const btn = $('#refresh');
  btn.classList.add('spinning');
  await loadFeed();
  await Promise.allSettled([loadLiveNews(), loadLiveTeams(), loadScoreboards(), loadLiveInsiders()]);
  await Promise.allSettled(state.teams.filter((t) => state.live.games[t.key]?.state && state.live.games[t.key].state !== 'pre').map((t) => loadSummary(t.key)));
  btn.classList.remove('spinning');
  render();
}

// ───────────────────────── alerts ─────────────────────────

const alertsOn = () => 'Notification' in window && Notification.permission === 'granted' && store.get('alerts') === 'on';

function notify(title, body, url) {
  if (!alertsOn() || !document.hidden) return;
  try {
    const n = new Notification(title, { body: body.slice(0, 180), tag: body.slice(0, 40) });
    n.onclick = () => { window.focus(); if (url?.startsWith('/')) navigate(url); else if (url) window.open(url, '_blank', 'noopener'); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

async function toggleAlerts() {
  if (!('Notification' in window)) return;
  if (alertsOn()) store.set('alerts', 'off');
  else if ((await Notification.requestPermission()) === 'granted') store.set('alerts', 'on');
  renderAlertsButton();
}

function renderAlertsButton() {
  const btn = $('#alerts');
  if (!('Notification' in window)) { btn.hidden = true; return; }
  btn.classList.toggle('on', alertsOn());
  btn.title = alertsOn() ? 'Breaking alerts on (injuries, roster moves)' : 'Get alerts for injuries and roster moves';
}

// ───────────────────────── rendering ─────────────────────────

function route() {
  const { key, tab } = parsePath(location.pathname, state.teams);
  return { key, tab: tab || (key && isLive(key) ? 'game' : 'news') };
}

function renderNav() {
  const { key } = route();
  $('#team-nav').innerHTML = [
    `<a class="chip ${key ? '' : 'active'}" data-key="all" href="/"><span class="sw"></span>All NY</a>`,
    ...state.teams.map((t) => `<a class="chip ${key === t.key ? 'active' : ''}" style="${teamVars(t)}" href="${teamPath(t)}"><span class="sw"></span>${esc(t.name)}${isLive(t.key) ? '<span class="live-pip" title="Live"></span>' : ''}</a>`),
  ].join('');
}

function renderTicker() {
  $('#ticker').innerHTML = state.teams.map((t) => {
    const g = currentGame(t.key);
    const rec = teamInfo(t.key).record;
    if (!g) return `<a class="tick" style="${teamVars(t)}" href="${teamPath(t)}"><b>${esc(t.name)}</b><span class="state">${esc(rec || 'No game scheduled')}</span></a>`;
    const at = g.home ? 'vs' : '@';
    if (g.state === 'pre' || !g.state) {
      const line = headlineLine(t, lineGame(t.key)?.odds);
      return `<a class="tick" style="${teamVars(t)}" href="${teamPath(t)}"><b>${esc(t.name)}</b><span>${at} ${esc(g.opponentAbbr || g.opponent)}</span>${line ? `<span class="tline" title="Betting line">${esc(line)}</span>` : ''}<span class="state">${esc(fmtGameTime(g.date))}</span></a>`;
    }
    const cls = g.state === 'in' ? 'live' : '';
    const res = g.state === 'post' && g.winner !== null ? `<span class="${g.winner ? 'win' : 'loss'}">${g.winner ? 'W' : 'L'}</span>` : '';
    return `<a class="tick ${cls}" style="${teamVars(t)}" href="${teamPath(t, g.state === 'in' ? 'game' : 'news')}"><b>${esc(t.name)}</b>${res}<span class="score">${esc(g.us)}–${esc(g.them)}</span><span>${at} ${esc(g.opponentAbbr || g.opponent)}</span><span class="state">${esc(g.detail)}</span></a>`;
  }).join('');
}

function badges(keys) {
  return keys.map((k) => state.byKey[k]).filter(Boolean)
    .map((t) => `<span class="badge" style="${teamVars(t)}">${esc(t.name)}</span>`).join('');
}

const flags = (x) => `${x.isInjury ? '<span class="badge inj">Injury</span>' : ''}${x.isMove ? '<span class="badge tx">Move</span>' : ''}${x.isRumor ? '<span class="badge rumor">Rumor</span>' : ''}`;

function storyHTML(n) {
  const img = n.image ? `<img class="thumb" src="${safeUrl(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.story').classList.add('noimg');this.remove()">` : '';
  return `<a class="story ${img ? '' : 'noimg'}" href="${safeUrl(n.url)}" target="_blank" rel="noopener">
    ${img}
    <div>
      <div class="meta">${badges(n.teams)}${flags(n)}</div>
      <h3>${esc(n.title)}</h3>
      ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
      <div class="meta"><span class="src">${esc(n.source)}</span><span>${esc(timeAgo(n.published))}</span></div>
    </div>
  </a>`;
}

function heroHTML(n) {
  const t = state.byKey[n.teams[0]];
  return `<a class="hero" style="${teamVars(t)}" href="${safeUrl(n.url)}" target="_blank" rel="noopener">
    ${n.image ? `<img src="${safeUrl(n.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="hero-body">
      <div class="meta">${badges(n.teams)}<span class="src">${esc(n.source)}</span><span>${esc(timeAgo(n.published))}</span></div>
      <h2>${esc(n.title)}</h2>
      ${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
    </div>
  </a>`;
}

const PLATFORM = { x: 'X', bsky: 'Bluesky', article: 'Article' };

function insiderPostHTML(p, { showTeam = true } = {}) {
  const breaking = Date.now() - Date.parse(p.published) < BREAKING_MS;
  const initials = p.reporter.split(' ').map((w) => w[0]).join('').slice(0, 2);
  const avatar = p.avatar
    ? `<img class="avatar" src="${safeUrl(p.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;avatar&quot;>${esc(initials)}</span>'">`
    : `<span class="avatar">${esc(initials)}</span>`;
  return `<a class="post ${state.freshPosts.has(p.id) ? 'fresh' : ''}" href="${safeUrl(p.url)}" target="_blank" rel="noopener">
    ${avatar}
    <div class="post-body">
      <div class="meta"><span class="src">${esc(p.reporter)}</span><span>${esc(p.outlet)}</span>${p.handle && p.platform !== 'article' ? `<span>@${esc(p.handle)}</span>` : ''}<span>· ${esc(timeAgo(p.published))}</span></div>
      <div class="post-text">${esc(p.text)}</div>
      <div class="meta">${breaking ? '<span class="badge breaking">Breaking</span>' : ''}${showTeam ? badges(p.teams) : ''}${flags(p)}<span class="plat">${PLATFORM[p.platform] || ''}</span></div>
    </div>
  </a>`;
}

function insidersEmpty() {
  return `<div class="empty">No reporter posts yet. Posts from X appear once an <code>X_BEARER_TOKEN</code> secret is added to the repo
    (and instantly with the insiders proxy); reporters with a Bluesky handle in <code>reporters.json</code> stream live in your browser.</div>`;
}

function insidersPanel(teamKey, limit) {
  const posts = allInsiders(teamKey).slice(0, limit);
  return posts.length ? `<div class="posts">${posts.map((p) => insiderPostHTML(p, { showTeam: !teamKey })).join('')}</div>` : insidersEmpty();
}

function reporterDirectory(teamKey) {
  const status = state.feed.reporterStatus || {};
  const missing = new Set((status.missing || []).map((h) => h.toLowerCase()));
  const stale = new Set(status.stale || []);
  const list = state.reporters.filter((r) => r.team === teamKey || (!r.team && r.league === state.byKey[teamKey].league));
  return `<div class="reporters">${list.map((r) => {
    const last = status.lastPost?.[r.name];
    const warn = r.x && missing.has(r.x.toLowerCase()) ? 'Handle not found' : stale.has(r.name) ? 'Quiet 30+ days' : '';
    return `<div class="reporter">
      <div><div class="nm">${esc(r.name)}${r.team ? '' : ' <span class="tag">National</span>'}</div>
      <div class="ps">${esc(r.outlet)}${last ? ` · last post ${esc(timeAgo(last))}` : ''}${warn ? ` · <span class="inj">${warn}</span>` : ''}</div></div>
      <div class="links">${r.x ? `<a href="https://x.com/${esc(r.x)}" target="_blank" rel="noopener">X</a>` : ''}${r.bsky ? `<a href="https://bsky.app/profile/${esc(r.bsky)}" target="_blank" rel="noopener">Bluesky</a>` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function newsSection(teamKey) {
  const q = state.query.toLowerCase();
  let items = allNews().filter((n) => !teamKey || n.teams.includes(teamKey));
  if (state.kind === 'moves') items = items.filter((n) => n.isMove);
  if (state.kind === 'injuries') items = items.filter((n) => n.isInjury);
  if (state.kind === 'rumors') items = items.filter((n) => n.isRumor);
  if (q) items = items.filter((n) => `${n.title} ${n.summary} ${n.source}`.toLowerCase().includes(q));

  const toolbar = `<div class="toolbar">
    <input class="search" id="search" type="search" placeholder="Search headlines, players, outlets…" value="${esc(state.query)}" aria-label="Search news">
    <div class="seg" role="group" aria-label="Filter">
      ${[['all', 'All news'], ['moves', 'Transactions'], ['rumors', 'Rumors'], ['injuries', 'Injuries']].map(([k, l]) => `<button data-kind="${k}" class="${state.kind === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
  </div>`;

  if (!items.length) return toolbar + (allNews().length ? '<div class="empty">No stories match.</div>' : '<div class="skeleton"></div><div class="skeleton" style="margin-top:12px"></div>');

  const heroIdx = !q && state.kind === 'all' ? items.findIndex((n) => n.image) : -1;
  const hero = heroIdx >= 0 && heroIdx < 5 ? items[heroIdx] : null;
  const rest = hero ? items.filter((n) => n !== hero) : items;
  const visible = rest.slice(0, state.shown);
  return `${hero ? heroHTML(hero) : ''}${toolbar}
    <div class="section-title"><span>Latest</span><span class="count">${items.length} stories</span></div>
    <div class="news-list">${visible.map(storyHTML).join('')}</div>
    ${rest.length > visible.length ? '<button class="more" id="more">Load more</button>' : ''}`;
}

function movesHTML(moves, { compact = false } = {}) {
  if (!moves.length) return '<div class="empty">No roster moves tracked yet.</div>';
  return `<ul class="moves">${moves.map((m) => {
    const t = state.byKey[m.team];
    const dir = /added|sign|claim|activat|recall|select|acquir|promot/i.test(m.type) ? 'in' : /remov|release|waiv|trade|option|placed|design|assign|cut/i.test(m.type) ? 'out' : '';
    const desc = m.url ? `<a class="desc" href="${safeUrl(m.url)}" target="_blank" rel="noopener">${esc(m.description)}</a>` : `<div class="desc">${esc(m.description)}</div>`;
    return `<li class="move" style="${teamVars(t)}"><span class="bar"></span><div>
      <div class="meta">${compact ? badges([m.team]) : ''}<span class="type ${dir}">${esc(m.type)}</span><span>${esc(timeAgo(m.date))}</span></div>
      ${desc}
      <div class="meta"><span>${esc(m.source || '')}</span></div>
    </div></li>`;
  }).join('')}</ul>`;
}

function injuryListHTML(items, { compact = false } = {}) {
  if (!items.length) return '<div class="empty">No injury news in the last 3 days.</div>';
  return `<ul class="moves">${items.map((i) => {
    const t = state.byKey[i.team];
    const text = i.url ? `<a class="desc" href="${safeUrl(i.url)}" target="_blank" rel="noopener">${esc(i.text)}</a>` : `<div class="desc">${esc(i.text)}</div>`;
    return `<li class="move" style="${teamVars(t)}"><span class="bar"></span><div>
      <div class="meta">${compact ? badges([i.team]) : ''}<span class="type out">${esc(i.kind)}</span>${i.sub ? `<span>${esc(i.sub)}</span>` : ''}<span>${i.live ? '<b class="live-txt">LIVE</b>' : esc(timeAgo(i.date))}</span></div>
      ${text}
    </div></li>`;
  }).join('')}</ul>`;
}

function logoHTML(t, info) {
  return info.logo
    ? `<img src="${safeUrl(info.logo)}" alt="${esc(t.full)} logo" loading="lazy" onerror="this.outerHTML='<span class=&quot;logo-fallback&quot;>${esc(t.key.toUpperCase())}</span>'">`
    : `<span class="logo-fallback">${esc(t.key.toUpperCase())}</span>`;
}

function teamCardsHTML() {
  return `<div class="team-cards">${state.teams.map((t) => {
    const info = teamInfo(t.key);
    const g = info.nextGame;
    const sub = g && g.state !== 'post' ? `Next: ${g.home ? 'vs' : '@'} ${g.opponentAbbr || g.opponent} · ${fmtGameTime(g.date)}` : (info.standing || t.league);
    return `<a class="team-card" style="${teamVars(t)}" href="${teamPath(t)}">
      ${logoHTML(t, info)}
      <div><h4>${esc(t.full)}</h4><div class="sub">${esc(sub)}</div></div>
      <div class="rec">${esc(info.record || '—')}</div>
    </a>`;
  }).join('')}</div>`;
}

function liveNowHTML() {
  const live = state.teams.filter((t) => isLive(t.key));
  if (!live.length) return '';
  return `<section class="live-now"><div class="section-title"><span><span class="live-pip"></span> Live now</span></div><div class="live-cards">${live.map((t) => {
    const g = state.live.games[t.key];
    const s = state.live.summaries[t.key];
    const last = g.lastPlay || s?.plays?.[0]?.text || '';
    const hurt = s?.inGameInjuries?.length;
    return `<a class="live-card" style="${teamVars(t)}" href="${teamPath(t, 'game')}">
      <div class="lc-top"><b>${esc(t.name)}</b><span class="score">${esc(g.us)}–${esc(g.them)}</span><span>${g.home ? 'vs' : '@'} ${esc(g.opponentAbbr || g.opponent)}</span><span class="state">${esc(g.detail)}</span></div>
      ${g.situation ? `<div class="lc-sit">${esc(g.situation)}</div>` : ''}
      ${last ? `<div class="lc-play">${esc(last)}</div>` : ''}
      ${hurt ? `<div class="lc-inj">⚠ ${hurt} injury ${hurt === 1 ? 'note' : 'notes'} this game</div>` : ''}
    </a>`;
  }).join('')}</div></section>`;
}

function renderHome() {
  const injuries = injuryItems('').slice(0, 8);
  return `${liveNowHTML()}<div class="layout">
    <section>${newsSection('')}</section>
    <aside class="stack">
      <div class="panel"><div class="section-title"><span>Insider Feed</span><span class="count">Beat reporters</span></div>${insidersPanel('', 12)}</div>
      <div class="panel"><div class="section-title"><span>The Lines</span><span class="count">Vegas odds</span></div>${linesPanelHTML()}</div>
      <div class="panel"><div class="section-title"><span>Rumor Mill</span><span class="count">Trades · signings</span></div>${rumorListHTML(rumorItems(''), { compact: true, limit: 8 })}</div>
      <div class="panel"><div class="section-title"><span>Injury Watch</span></div>${injuryListHTML(injuries, { compact: true })}</div>
      <div class="panel"><div class="section-title"><span>Roster Moves Wire</span></div>${movesHTML(allMoves().slice(0, 12), { compact: true })}</div>
      <div><div class="section-title"><span>The Teams</span></div>${teamCardsHTML()}</div>
    </aside>
  </div>`;
}

function gameCard(label, g, t, link = '') {
  if (!g) return '';
  const odds = t && g.state !== 'post' ? lineGame(t.key)?.odds : null;
  const at = g.home ? 'vs' : '@';
  const score = g.state && g.state !== 'pre' ? `<span class="${g.winner === true ? 'win' : g.winner === false ? 'loss' : ''}">${g.winner === true ? 'W ' : g.winner === false ? 'L ' : ''}${esc(g.us)}–${esc(g.them)}</span> ` : '';
  return `<div class="game"><div class="lbl">${label}</div>
    <div class="vs">${score}${at} ${esc(g.opponent)}</div>
    <div class="when">${g.state === 'pre' || !g.state ? esc(fmtGameTime(g.date)) : esc(g.detail)}${g.broadcast ? ` · ${esc(g.broadcast)}` : ''}${g.venue ? ` · ${esc(g.venue)}` : ''}</div>
    ${odds ? `<div class="when gl">${g.state === 'in' ? 'Pregame · ' : ''}${oddsCells(t, odds).map(([k, v]) => `${k} <b>${esc(v)}</b>`).join(' · ')}</div>` : ''}
    ${link ? `<a class="box-link" href="${link}">Box score ›</a>` : ''}</div>`;
}

function playListHTML(plays) {
  return `<ul class="plays">${plays.map((p) => `<li class="${p.scoring ? 'scoring' : ''} ${p.injury ? 'injury' : ''}">
    <span class="pc">${esc(p.period)}${p.clock ? ` ${esc(p.clock)}` : ''}</span>
    <span class="pt">${p.team ? `<b>${esc(p.team)}</b> ` : ''}${esc(p.text)}${p.score ? ` <span class="psc">(${esc(p.score)})</span>` : ''}</span>
  </li>`).join('')}</ul>`;
}

const BET_CLASS = { Over: 'hit', Under: 'hit', Covered: 'win', Won: 'win', 'Did not cover': 'loss', Lost: 'loss', Push: 'push' };

function betResultsHTML(t, s) {
  const r = betResults(s.odds, s.us.score, s.them.score);
  if (!r) return '';
  const abbr = esc(s.us.abbr || t.espn.toUpperCase());
  const cell = (label, line, res, extra = '') => `<div class="bet ${BET_CLASS[res] || ''}"><span>${label}</span><b>${res}</b><em>${line}${extra}</em></div>`;
  return `<div class="panel"><div class="section-title"><span>Betting results</span><span class="count">Closing line · ${esc(r.provider)}</span></div>
    <div class="bets">
      ${r.total ? cell('Over/Under', `O/U ${r.total.line}`, r.total.result, ` · ${r.total.actual} scored`) : ''}
      ${r.spread ? cell('Spread', `${abbr} ${signed(r.spread.line)}`, r.spread.result) : ''}
      ${r.ml ? cell('Moneyline', `${abbr} ${signed(r.ml.line)}`, r.ml.result) : ''}
    </div><p class="rg">${esc(RG_NOTE)}</p></div>`;
}

function lineScoreHTML(ls) {
  if (!ls) return '';
  return `<div class="table-wrap"><table class="linescore"><thead><tr><th></th>${ls.headers.map((h) => `<th>${h}</th>`).join('')}<th class="tot">${ls.rhe ? 'R' : 'T'}</th>${ls.rhe ? '<th>H</th><th>E</th>' : ''}</tr></thead>
    <tbody>${ls.rows.map((r) => `<tr class="${r.ours ? 'ours' : ''}"><th>${esc(r.abbr)}</th>${ls.headers.map((_, i) => `<td>${esc(r.periods[i] ?? '')}</td>`).join('')}<td class="tot">${esc(r.total)}</td>${ls.rhe ? `<td>${esc(r.hits)}</td><td>${esc(r.errors)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function statTable(g) {
  return `<div class="table-wrap"><table class="boxtable"><thead><tr><th>${esc(g.title)}</th>${g.labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr></thead>
    <tbody>${g.rows.map((r) => `<tr><th>${esc(r.name)}${r.pos ? ` <span>${esc(r.pos)}</span>` : ''}</th>${r.stats.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}
    ${g.totals.length ? `<tr class="totals"><th>Team</th>${g.totals.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>` : ''}</tbody></table></div>`;
}

// Final or live box score: line score, betting results (finals only), team totals and player stats.
function boxScoreHTML(t, s, { final }) {
  const stats = s.teamStats.length ? `<div class="table-wrap"><table class="teamstats"><thead><tr><th></th><th>${esc(s.us.abbr || '')}</th><th>${esc(s.them.abbr || '')}</th></tr></thead>
    <tbody>${s.teamStats.map((r) => `<tr><th>${esc(r.label)}</th><td>${esc(r.us)}</td><td>${esc(r.them)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const players = s.boxPlayers.map((p, i) => {
    const tables = p.groups.map(statTable).join('');
    return i === 0 ? `<h4 class="box-team">${esc(p.name)}</h4>${tables}`
      : `<details class="box-opp"><summary>${esc(p.name)} box score</summary>${tables}</details>`;
  }).join('');
  return `<div class="panel"><div class="section-title"><span>Box score</span><span class="count">${final ? 'Final' : 'Live'}</span></div>${lineScoreHTML(s.linescore)}</div>
    ${final ? betResultsHTML(t, s) : ''}
    ${players || stats ? `<div class="panel"><div class="section-title"><span>Player stats</span></div>${players}${stats ? `<h4 class="box-team">Team stats</h4>${stats}` : ''}</div>` : ''}`;
}

function resultsTabHTML(key) {
  const t = state.byKey[key];
  const results = teamInfo(key).results || [];
  if (!results.length) return '<div class="empty">No finished games yet this season.</div>';
  const rec = resultsRecord(results);
  const fmt = (a) => `${a[0]}-${a[1]}${a[2] ? `-${a[2]}` : ''}`;
  const abbr = t.espn.toUpperCase();
  const chips = `<div class="bets rec">
    <div class="bet"><span>Last ${results.length}</span><b>${fmt(rec.su)}</b><em>Straight up</em></div>
    ${rec.withLine ? `<div class="bet"><span>Against the spread</span><b>${fmt(rec.ats)}</b><em>${rec.withLine} games with a line</em></div>
    <div class="bet hit"><span>Over / Under</span><b>${rec.ou[0]}–${rec.ou[1]}${rec.ou[2] ? `–${rec.ou[2]}` : ''}</b><em>Overs–unders${rec.ou[2] ? '–pushes' : ''}</em></div>` : ''}
  </div>`;
  const rows = results.map((g) => {
    const bet = betResults(g.odds, g.us, g.them);
    const res = g.winner === true ? 'W' : g.winner === false ? 'L' : 'T';
    const open = state.openResult === g.id;
    const spread = bet?.spread ? `<span class="res ${BET_CLASS[bet.spread.result]}"><span class="ab">${abbr} </span>${signed(bet.spread.line)} · ${bet.spread.result === 'Did not cover' ? 'Missed' : bet.spread.result}</span>` : '<span class="muted">—</span>';
    const total = bet?.total ? `<span class="res ${BET_CLASS[bet.total.result]}">${bet.total.result} ${bet.total.line}</span>` : '<span class="muted">—</span>';
    return `<tr class="${open ? 'open' : ''}">
      <td class="d">${esc(new Date(g.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</td>
      <td>${g.home ? 'vs' : '@'} ${esc(g.opponentAbbr || g.opponent)}</td>
      <td><b class="${res === 'W' ? 'win' : res === 'L' ? 'loss' : ''}">${res} ${esc(g.us)}–${esc(g.them)}</b></td>
      <td>${spread}</td><td>${total}</td>
      <td><button class="box-btn" data-result="${esc(g.id)}" aria-expanded="${open}">${open ? 'Hide' : 'Box<span class="ab"> score</span>'}</button></td>
    </tr>${open ? `<tr class="box-row"><td colspan="6">${resultBoxHTML(key, g.id)}</td></tr>` : ''}`;
  }).join('');
  return `<div class="stack">${chips}
    <div class="panel"><div class="section-title"><span>Recent results</span><span class="count">Closing lines</span></div>
      <div class="table-wrap"><table class="results"><thead><tr><th>Date</th><th>Opp</th><th>Result</th><th>Spread</th><th>Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="rg">${esc(RG_NOTE)}</p></div></div>`;
}

function resultBoxHTML(key, id) {
  const s = state.live.recaps[id];
  if (!s) {
    if (state.live.recapTried.has(id)) return '<div class="empty">Box score unavailable right now.</div>';
    loadRecap(key, id);
    return '<div class="skeleton"></div>';
  }
  return `<div class="stack">${boxScoreHTML(state.byKey[key], s, { final: true })}</div>`;
}

function lastGameRecapHTML(key) {
  const t = state.byKey[key];
  const g = teamInfo(key).lastGame;
  if (!g || g.state !== 'post') return '';
  const s = state.live.recaps[g.id];
  if (!s) {
    if (state.live.recapTried.has(g.id)) return '<div class="empty">Box score unavailable right now.</div>';
    loadRecap(key);
    return '<div class="skeleton"></div>';
  }
  const res = g.winner === true ? 'W' : g.winner === false ? 'L' : '';
  return `<div class="panel"><div class="section-title"><span>Last game</span><span class="count">${esc(fmtGameTime(g.date))}</span></div>
      <div class="recap-line"><b class="${res === 'W' ? 'win' : res === 'L' ? 'loss' : ''}">${res} ${esc(s.us.score)}–${esc(s.them.score)}</b> ${g.home ? 'vs' : '@'} ${esc(g.opponent)}</div></div>
    ${boxScoreHTML(t, s, { final: true })}`;
}

function gameTabHTML(key) {
  const g = state.live.games[key];
  const s = state.live.summaries[key];
  if (!g || g.state === 'pre') {
    const next = lineGame(key);
    const t = state.byKey[key];
    return `${next ? `<div class="panel"><div class="section-title"><span>Next up</span></div>
      <div class="next-up">${next.home ? 'vs' : '@'} ${esc(next.opponent)}<span>${esc(fmtGameTime(next.date))}${next.broadcast ? ` · ${esc(next.broadcast)}` : ''}${next.venue ? ` · ${esc(next.venue)}` : ''}</span></div>
      ${next.odds ? oddsStripHTML(t, next.odds) : '<p class="rg">Betting line not posted yet.</p>'}
      ${next.odds ? `<p class="rg">${esc(RG_NOTE)}</p>` : ''}</div>` : ''}
      <p class="rg" style="margin:12px 0 16px">Live play-by-play, scoring and injury updates appear here at first pitch, puck drop, tip-off or kickoff.</p>
      <div class="stack">${lastGameRecapHTML(key)}</div>`;
  }
  if (!s) {
    if (state.live.summaryTried.has(key)) return '<div class="empty">Live game data is unavailable right now — retrying shortly.</div>';
    loadSummary(key).then(render);
    return '<div class="skeleton"></div>';
  }
  const gameStart = Date.parse(g.date);
  const duringGame = allInsiders(key).filter((p) => Date.parse(p.published) >= gameStart - 3600e3).slice(0, 15);
  const ours = s.injuries.filter((i) => i.ours);
  return `<div class="layout">
    <section class="stack">
      <div class="scorebug ${g.state === 'in' ? 'is-live' : ''}">
        <div class="sb-team">${s.us.logo ? `<img src="${safeUrl(s.us.logo)}" alt="">` : ''}<span>${esc(s.us.abbr || '')}</span><b>${esc(s.us.score)}</b></div>
        <div class="sb-mid"><div class="sb-state">${g.state === 'in' ? '<span class="live-pip"></span>' : ''}${esc(s.detail || g.detail)}</div>${g.situation ? `<div class="sb-sit">${esc(g.situation)}</div>` : ''}</div>
        <div class="sb-team">${s.them.logo ? `<img src="${safeUrl(s.them.logo)}" alt="">` : ''}<span>${esc(s.them.abbr || '')}</span><b>${esc(s.them.score)}</b></div>
      </div>
      ${g.state === 'post' ? '' : oddsStripHTML(state.byKey[key], s.odds || lineGame(key)?.odds, { label: g.state === 'pre' ? '' : 'Pregame line' })}
      ${boxScoreHTML(state.byKey[key], s, { final: g.state === 'post' })}
      ${s.inGameInjuries.length ? `<div class="panel alert"><div class="section-title"><span>⚠ In-game injury notes</span></div>${playListHTML(s.inGameInjuries)}</div>` : ''}
      <div class="panel"><div class="section-title"><span>Play-by-play</span><span class="count">${g.state === 'in' ? 'Updates every 20s' : 'Final'}</span></div>
        ${s.plays.length ? playListHTML(s.plays) : '<div class="empty">Plays will appear once the game is underway.</div>'}</div>
      ${s.scoring.length ? `<div class="panel"><div class="section-title"><span>Scoring</span></div>${playListHTML(s.scoring)}</div>` : ''}
    </section>
    <aside class="stack">
      <div class="panel"><div class="section-title"><span>From the press box</span></div>${duringGame.length ? `<div class="posts">${duringGame.map((p) => insiderPostHTML(p, { showTeam: false })).join('')}</div>` : insidersEmpty()}</div>
      ${s.leaders.length ? `<div class="panel"><div class="section-title"><span>Team leaders</span></div><ul class="leaders">${s.leaders.map((l) => `<li><span>${esc(l.category)}</span><b>${esc(l.player)}</b><span>${esc(l.value)}</span></li>`).join('')}</ul></div>` : ''}
      ${ours.length ? `<div class="panel"><div class="section-title"><span>Injury report</span></div><ul class="leaders">${ours.map((i) => `<li><span>${esc(i.pos)}</span><b>${esc(i.player)}</b><span class="inj">${esc(i.status)}</span></li>`).join('')}</ul></div>` : ''}
    </aside>
  </div>`;
}

function injuriesTabHTML(key) {
  const info = teamInfo(key);
  const roster = info.roster?.length ? info.roster : Array.isArray(state.live.rosters[key]) ? state.live.rosters[key] : [];
  const hurt = roster.filter((p) => p.status && !/^active$/i.test(p.status));
  const report = state.live.summaries[key]?.injuries?.filter((i) => i.ours) || [];
  const rows = report.length ? report.map((i) => ({ name: i.player, pos: i.pos, status: i.status, detail: i.detail }))
    : hurt.map((p) => ({ name: p.name, pos: p.pos, status: p.status, detail: '' }));
  return `<div class="layout">
    <section class="stack">
      <div class="panel"><div class="section-title"><span>Latest injury news</span></div>${injuryListHTML(injuryItems(key))}</div>
    </section>
    <aside class="stack">
      <div class="panel"><div class="section-title"><span>Injury report</span><span class="count">${rows.length}</span></div>
      ${rows.length ? `<ul class="leaders">${rows.map((r) => `<li><span>${esc(r.pos)}</span><b>${esc(r.name)}</b><span class="inj">${esc(r.status)}</span></li>`).join('')}</ul>` : '<div class="empty">No players listed.</div>'}</div>
    </aside>
  </div>`;
}

function rosterHTML(key) {
  const info = teamInfo(key);
  const roster = info.roster?.length ? info.roster : state.live.rosters[key];
  if (!roster || roster === 'loading') { loadRoster(key); return '<div class="skeleton"></div>'; }
  if (!roster.length) return '<div class="empty">Roster unavailable right now.</div>';
  const groups = {};
  for (const p of roster) (groups[p.group || 'Roster'] ||= []).push(p);
  const label = (g) => g.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  // Practice squad and injured list sit below the active roster and aren't counted in it.
  const reserve = (g) => g === 'Practice Squad' || g === 'Injured List';
  const entries = Object.entries(groups).sort(([a], [b]) => reserve(a) - reserve(b));
  const active = entries.filter(([g]) => !reserve(g)).reduce((n, [, ps]) => n + ps.length, 0);
  const extra = entries.filter(([g]) => reserve(g)).map(([g, ps]) => `${ps.length} ${g === 'Practice Squad' ? 'practice squad' : 'injured list'}`);
  return `<div class="section-title"><span>Roster</span><span class="count">${active} active${extra.length ? ` · ${extra.join(' · ')}` : ''}</span></div>` +
    entries.map(([g, players]) => `<div class="roster-group"><h5>${esc(label(g))}</h5><div class="roster">${players
      .sort((a, b) => (+a.jersey || 999) - (+b.jersey || 999))
      .map((p) => `<div class="player"><span class="num">${esc(p.jersey)}</span>${p.headshot ? `<img src="${safeUrl(p.headshot)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">` : '<span class="ph"></span>'}
        <div><div class="nm">${esc(p.name)}</div><div class="ps">${esc(p.pos)}${p.age ? ` · ${esc(p.age)}` : ''}${p.status ? ` · <span class="inj">${esc(p.status)}</span>` : ''}</div></div></div>`).join('')}</div></div>`).join('');
}

function renderTeam(key, tab) {
  const t = state.byKey[key];
  const info = teamInfo(key);
  const live = state.live.games[key];
  const next = live && live.state !== 'post' ? live : info.nextGame;
  const last = live?.state === 'post' ? live : info.lastGame;
  const moves = allMoves(key);
  const body = {
    game: () => gameTabHTML(key),
    insiders: () => `<div class="layout"><section>${insidersPanel(key, 60)}</section><aside class="stack"><div class="panel"><div class="section-title"><span>Who we follow</span></div>${reporterDirectory(key)}</div></aside></div>`,
    injuries: () => injuriesTabHTML(key),
    rumors: () => `<div class="panel">${rumorListHTML(rumorItems(key))}</div>`,
    results: () => resultsTabHTML(key),
    moves: () => `<div class="panel">${movesHTML(moves)}</div>`,
    roster: () => rosterHTML(key),
  }[tab]?.() ?? newsSection(key);
  const gameLabel = live?.state === 'in' ? '<span class="live-pip"></span>Live' : live?.state === 'post' ? 'Game recap' : 'Game';
  const tabs = { game: gameLabel, results: 'Results', insiders: 'Insiders', news: 'News', rumors: 'Rumors', injuries: 'Injuries', moves: `Roster Moves (${moves.length})`, roster: 'Roster' };
  return `<div style="${teamVars(t)}">
    <section class="team-hero">
      <div class="team-hero-top">${logoHTML(t, info)}
        <div><div class="league">${esc(t.league)}</div><h1>${esc(t.full)}</h1>
        <div class="standing">${esc([info.record, info.standing].filter(Boolean).join(' · '))}</div></div>
      </div>
      <div class="games">${gameCard(next?.state === 'in' ? 'Live now' : 'Next game', next, t)}${gameCard('Last game', last, null, last?.state === 'post' ? teamPath(t, 'game') : '')}</div>
    </section>
    <div class="tabs" role="tablist" style="--c1-bright:${t.colors[0] === '#000000' ? t.colors[1] : t.colors[0]}">
      ${Object.entries(tabs).map(([x, label]) => `<button data-tab="${x}" class="${tab === x ? 'on' : ''}">${label}</button>`).join('')}
    </div>
    ${body}
  </div>`;
}

// The title strip comes prerendered with each page; only rewrite it after in-site navigation.
function renderSeoHead(key, tab) {
  if (state.seoPath === undefined) { state.seoPath = location.pathname; return; }
  if (state.seoPath === location.pathname) return;
  state.seoPath = location.pathname;
  const t = state.byKey[key];
  const meta = t ? teamMeta(t, tab) : homeMeta(state.teams);
  const crumbs = t ? `<nav class="seo-crumbs" aria-label="Breadcrumb"><a href="/">New York Sports</a> › <a href="${teamPath(t)}">${esc(t.full)}</a>${tab !== 'news' ? ` › ${esc(meta.h1.replace(`${t.full} `, ''))}` : ''}</nav>` : '';
  $('#seo-head').innerHTML = `${crumbs}<h1>${esc(meta.h1)}</h1><p>${esc(meta.description)}</p>`;
}

function render() {
  const { key, tab } = route();
  renderSeoHead(key, tab);
  renderNav();
  renderTicker();
  const focused = document.activeElement?.id === 'search';
  const caret = focused ? document.activeElement.selectionStart : 0;
  $('#app').innerHTML = key ? renderTeam(key, tab) : renderHome();
  if (focused) { const s = $('#search'); s.focus(); s.setSelectionRange(caret, caret); }
  const gen = state.feed.generatedAt;
  $('#updated').textContent = state.live.news.length ? `Live · feed ${gen ? timeAgo(gen) : 'pending'}` : gen ? `Updated ${timeAgo(gen)}` : 'Connecting…';
  const anyLive = state.teams.some((t) => isLive(t.key));
  document.title = `${anyLive ? '● ' : ''}${(key ? teamMeta(state.byKey[key], tab) : homeMeta(state.teams)).title}`;
}

// ───────────────────────── events ─────────────────────────

document.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  state.query = e.target.value;
  state.shown = PAGE_SIZE;
  render();
});

document.addEventListener('click', (e) => {
  const kind = e.target.closest('[data-kind]');
  if (kind) { state.kind = kind.dataset.kind; state.shown = PAGE_SIZE; render(); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { navigate(teamPath(state.byKey[route().key], tab.dataset.tab)); return; }
  if (e.target.id === 'more') { state.shown += PAGE_SIZE; render(); return; }
  const box = e.target.closest('[data-result]');
  if (box) { state.openResult = state.openResult === box.dataset.result ? null : box.dataset.result; render(); return; }
  if (e.target.closest('#refresh')) refreshAll();
  if (e.target.closest('#alerts')) toggleAlerts();
});

// Every team view is a real, prerendered page (see scripts/build-pages.mjs); in-site clicks swap views
// without a reload, and the address bar always shows a URL that loads the same view directly.
function navigate(url) {
  if (url !== location.pathname) history.pushState(null, '', url);
  state.shown = PAGE_SIZE;
  render();
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

window.addEventListener('popstate', () => { state.shown = PAGE_SIZE; render(); });

// Links from before real URLs (#/nyg/rumors) → /new-york-giants/rumors/
function redirectOldLink() {
  const [, oldKey, oldTab] = location.hash.split('/');
  if (!state.byKey[oldKey]) return false;
  history.replaceState(null, '', teamPath(state.byKey[oldKey], oldTab || 'news'));
  return true;
}
window.addEventListener('hashchange', () => { if (redirectOldLink()) { state.shown = PAGE_SIZE; render(); } });

// Polls on a timer, skipping work while the tab is hidden unless alerts need it.
function every(ms, fn) {
  setInterval(async () => {
    if (document.hidden && !alertsOn()) return;
    await fn();
    render();
  }, ms);
}

async function init() {
  const [teams, reporters, config] = await Promise.all([
    getJSON('/data/teams.json'),
    getJSON('/data/reporters.json').catch(() => ({})),
    getJSON('/data/config.json').catch(() => ({})),
  ]);
  state.teams = teams;
  state.byKey = Object.fromEntries(teams.map((t) => [t.key, t]));
  redirectOldLink();
  state.reporters = flattenReporters(reporters);
  state.config = config;
  renderAlertsButton();
  render();
  await loadFeed();
  render();
  await refreshAll();
  every(FEED_REFRESH_MS, async () => { await loadFeed(); trackNewPosts(); await loadLiveNews(); });
  every(INSIDERS_REFRESH_MS, loadLiveInsiders);
  every(SCORES_REFRESH_MS, async () => {
    // Full scoreboard check every 30s only while something is live; otherwise the 5-minute refresh covers game starts.
    if (state.teams.some((t) => isLive(t.key))) await loadScoreboards();
  });
  every(GAME_REFRESH_MS, () => Promise.allSettled(state.teams.filter((t) => isLive(t.key)).map((t) => loadSummary(t.key))));
  every(FEED_REFRESH_MS, loadScoreboards);
}

init();
