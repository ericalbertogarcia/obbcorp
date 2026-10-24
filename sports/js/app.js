import { leagueBase, espnNews, espnRoster, gameSummary } from './espn.mjs';

const FEED_REFRESH_MS = 5 * 60 * 1000;
const SCORES_REFRESH_MS = 60 * 1000;
const PAGE_SIZE = 30;
const MOVE_WORDS = /\b(signs?|signed|re-signs?|waived?|waives|releases?|released|trades?|traded|acquires?|acquired|claims?|claimed|activated?|placed|recalls?|recalled|optioned|reassigned|designated for assignment|DFA|injured reserve|injured list|extension|called up|promoted|cuts?)\b/i;

const state = {
  teams: [],
  byKey: {},
  feed: { teams: {}, news: [], moves: [] },
  live: { news: [], teams: {}, games: {}, rosters: {} },
  query: '',
  kind: 'all',
  shown: PAGE_SIZE,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const teamVars = (t) => (t ? `--c1:${t.colors[0]};--c2:${t.colors[1]}` : '');

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

// Official transactions + roster diffs from the feed, plus reported moves from headlines.
function allMoves(teamKey) {
  const official = (state.feed.moves || []).map((m) => ({ ...m, kind: 'official' }));
  const reported = allNews().filter((n) => n.isMove).flatMap((n) => n.teams.map((team) => ({
    id: `news-${team}-${n.id || normTitle(n.title)}`, team, date: n.published, type: 'Reported',
    description: n.title, url: n.url, source: n.source, kind: 'reported',
  })));
  return [...official, ...reported]
    .filter((m) => !teamKey || m.team === teamKey)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
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
    state.feed = await getJSON(`data/feed.json?t=${Date.now()}`);
  } catch {
    // No feed yet (first deploy) — the live browser fetches below fill in.
  }
}

async function loadLiveNews() {
  const results = await Promise.allSettled(state.teams.map(async (team) => {
    const info = teamInfo(team.key);
    const id = info.espnId || team.espn;
    const json = await getJSON(`${leagueBase(team)}/news?team=${id}&limit=25`);
    return espnNews(json).map((n) => ({ ...n, teams: [team.key], isMove: MOVE_WORDS.test(n.title) }));
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
      nextGame: t.nextEvent?.[0] ? gameSummary(t.nextEvent[0], t.id) : null,
    };
  }));
}

async function loadScoreboards() {
  const leagues = [...new Set(state.teams.map((t) => leagueBase(t)))];
  const boards = await Promise.allSettled(leagues.map((base) => getJSON(`${base}/scoreboard`).then((j) => [base, j])));
  const games = {};
  for (const b of boards) {
    if (b.status !== 'fulfilled') continue;
    const [base, json] = b.value;
    for (const team of state.teams.filter((t) => leagueBase(t) === base)) {
      const id = teamInfo(team.key).espnId;
      const ev = (json.events || []).find((e) => e.competitions?.[0]?.competitors?.some((c) =>
        String(c.id) === String(id) || c.team?.abbreviation?.toLowerCase() === team.espn));
      if (!ev) continue;
      const comp = ev.competitions[0].competitors.find((c) => String(c.id) === String(id) || c.team?.abbreviation?.toLowerCase() === team.espn);
      games[team.key] = gameSummary(ev, comp.id);
    }
  }
  state.live.games = games;
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

async function refreshAll() {
  const btn = $('#refresh');
  btn.classList.add('spinning');
  await loadFeed();
  await Promise.allSettled([loadLiveNews(), loadLiveTeams(), loadScoreboards()]);
  btn.classList.remove('spinning');
  render();
}

// ───────────────────────── rendering ─────────────────────────

function route() {
  const [, key = '', tab = 'news'] = location.hash.split('/');
  return { key: state.byKey[key] ? key : '', tab };
}

function renderNav() {
  const { key } = route();
  $('#team-nav').innerHTML = [
    `<a class="chip ${key ? '' : 'active'}" data-key="all" href="#/"><span class="sw"></span>All NY</a>`,
    ...state.teams.map((t) => `<a class="chip ${key === t.key ? 'active' : ''}" style="${teamVars(t)}" href="#/${t.key}"><span class="sw"></span>${esc(t.name)}</a>`),
  ].join('');
}

function renderTicker() {
  $('#ticker').innerHTML = state.teams.map((t) => {
    const g = currentGame(t.key);
    const rec = teamInfo(t.key).record;
    if (!g) return `<a class="tick" style="${teamVars(t)}" href="#/${t.key}"><b>${esc(t.name)}</b><span class="state">${esc(rec || 'No game scheduled')}</span></a>`;
    const at = g.home ? 'vs' : '@';
    if (g.state === 'pre' || !g.state) {
      return `<a class="tick" style="${teamVars(t)}" href="#/${t.key}"><b>${esc(t.name)}</b><span>${at} ${esc(g.opponentAbbr || g.opponent)}</span><span class="state">${esc(fmtGameTime(g.date))}</span></a>`;
    }
    const cls = g.state === 'in' ? 'live' : '';
    const res = g.state === 'post' && g.winner !== null ? `<span class="${g.winner ? 'win' : 'loss'}">${g.winner ? 'W' : 'L'}</span>` : '';
    return `<a class="tick ${cls}" style="${teamVars(t)}" href="#/${t.key}"><b>${esc(t.name)}</b>${res}<span class="score">${esc(g.us)}–${esc(g.them)}</span><span>${at} ${esc(g.opponentAbbr || g.opponent)}</span><span class="state">${esc(g.detail)}</span></a>`;
  }).join('');
}

function badges(keys) {
  return keys.map((k) => state.byKey[k]).filter(Boolean)
    .map((t) => `<span class="badge" style="${teamVars(t)}">${esc(t.name)}</span>`).join('');
}

function storyHTML(n) {
  const img = n.image ? `<img class="thumb" src="${safeUrl(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('.story').classList.add('noimg');this.remove()">` : '';
  return `<a class="story ${img ? '' : 'noimg'}" href="${safeUrl(n.url)}" target="_blank" rel="noopener">
    ${img}
    <div>
      <div class="meta">${badges(n.teams)}${n.isMove ? '<span class="badge tx">Move</span>' : ''}</div>
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

function newsSection(teamKey) {
  const q = state.query.toLowerCase();
  let items = allNews().filter((n) => !teamKey || n.teams.includes(teamKey));
  if (state.kind === 'moves') items = items.filter((n) => n.isMove);
  if (q) items = items.filter((n) => `${n.title} ${n.summary} ${n.source}`.toLowerCase().includes(q));

  const toolbar = `<div class="toolbar">
    <input class="search" id="search" type="search" placeholder="Search headlines, players, outlets…" value="${esc(state.query)}" aria-label="Search news">
    <div class="seg" role="group" aria-label="Filter">
      <button data-kind="all" class="${state.kind === 'all' ? 'on' : ''}">All news</button>
      <button data-kind="moves" class="${state.kind === 'moves' ? 'on' : ''}">Transactions</button>
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
    return `<a class="team-card" style="${teamVars(t)}" href="#/${t.key}">
      ${logoHTML(t, info)}
      <div><h4>${esc(t.full)}</h4><div class="sub">${esc(sub)}</div></div>
      <div class="rec">${esc(info.record || '—')}</div>
    </a>`;
  }).join('')}</div>`;
}

function renderHome() {
  return `<div class="layout">
    <section>${newsSection('')}</section>
    <aside class="stack">
      <div class="panel"><div class="section-title"><span>Roster Moves Wire</span></div>${movesHTML(allMoves().slice(0, 15), { compact: true })}</div>
      <div><div class="section-title"><span>The Teams</span></div>${teamCardsHTML()}</div>
    </aside>
  </div>`;
}

function gameCard(label, g) {
  if (!g) return '';
  const at = g.home ? 'vs' : '@';
  const score = g.state && g.state !== 'pre' ? `<span class="${g.winner === true ? 'win' : g.winner === false ? 'loss' : ''}">${g.winner === true ? 'W ' : g.winner === false ? 'L ' : ''}${esc(g.us)}–${esc(g.them)}</span> ` : '';
  return `<div class="game"><div class="lbl">${label}</div>
    <div class="vs">${score}${at} ${esc(g.opponent)}</div>
    <div class="when">${g.state === 'pre' || !g.state ? esc(fmtGameTime(g.date)) : esc(g.detail)}${g.broadcast ? ` · ${esc(g.broadcast)}` : ''}${g.venue ? ` · ${esc(g.venue)}` : ''}</div></div>`;
}

function rosterHTML(key) {
  const info = teamInfo(key);
  const roster = info.roster?.length ? info.roster : state.live.rosters[key];
  if (!roster || roster === 'loading') { loadRoster(key); return '<div class="skeleton"></div>'; }
  if (!roster.length) return '<div class="empty">Roster unavailable right now.</div>';
  const groups = {};
  for (const p of roster) (groups[p.group || 'Roster'] ||= []).push(p);
  const label = (g) => g.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  return `<div class="section-title"><span>Active Roster</span><span class="count">${roster.length} players</span></div>` +
    Object.entries(groups).map(([g, players]) => `<div class="roster-group"><h5>${esc(label(g))}</h5><div class="roster">${players
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
  const body = tab === 'roster' ? rosterHTML(key)
    : tab === 'moves' ? `<div class="panel">${movesHTML(moves)}</div>`
    : newsSection(key);
  return `<div style="${teamVars(t)}">
    <section class="team-hero">
      <div class="team-hero-top">${logoHTML(t, info)}
        <div><div class="league">${esc(t.league)}</div><h1>${esc(t.full)}</h1>
        <div class="standing">${esc([info.record, info.standing].filter(Boolean).join(' · '))}</div></div>
      </div>
      <div class="games">${gameCard(next?.state === 'in' ? 'Live now' : 'Next game', next)}${gameCard('Last game', last)}</div>
    </section>
    <div class="tabs" role="tablist">
      ${['news', 'moves', 'roster'].map((x) => `<button data-tab="${x}" class="${tab === x ? 'on' : ''}" style="--c1-bright:${t.colors[0] === '#000000' ? t.colors[1] : t.colors[0]}">${{ news: 'News', moves: `Roster Moves (${moves.length})`, roster: 'Roster' }[x]}</button>`).join('')}
    </div>
    ${body}
  </div>`;
}

function render() {
  const { key, tab } = route();
  renderNav();
  renderTicker();
  const focused = document.activeElement?.id === 'search';
  const caret = focused ? document.activeElement.selectionStart : 0;
  $('#app').innerHTML = key ? renderTeam(key, tab) : renderHome();
  if (focused) { const s = $('#search'); s.focus(); s.setSelectionRange(caret, caret); }
  const gen = state.feed.generatedAt;
  $('#updated').textContent = state.live.news.length ? `Live · feed ${gen ? timeAgo(gen) : 'pending'}` : gen ? `Updated ${timeAgo(gen)}` : 'Connecting…';
  document.title = key ? `${state.byKey[key].full} News & Roster Moves — NY Sports Wire` : 'NY Sports Wire — Giants · Jets · Yankees · Mets · Devils · Rangers · Islanders';
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
  if (tab) { location.hash = `#/${route().key}/${tab.dataset.tab}`; return; }
  if (e.target.id === 'more') { state.shown += PAGE_SIZE; render(); return; }
  if (e.target.closest('#refresh')) refreshAll();
});

window.addEventListener('hashchange', () => { state.shown = PAGE_SIZE; render(); window.scrollTo({ top: 0 }); });

async function init() {
  state.teams = await getJSON('data/teams.json');
  state.byKey = Object.fromEntries(state.teams.map((t) => [t.key, t]));
  render();
  await loadFeed();
  render();
  await refreshAll();
  setInterval(refreshAll, FEED_REFRESH_MS);
  setInterval(async () => {
    if (!Object.values(state.live.games).some((g) => g?.state === 'in')) return;
    await loadScoreboards();
    render();
  }, SCORES_REFRESH_MS);
}

init();
