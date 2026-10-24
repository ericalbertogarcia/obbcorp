#!/usr/bin/env node
// Builds sports/data/feed.json: news from ESPN, Google News and team RSS feeds,
// beat-reporter posts (X, Bluesky, author RSS), plus records, schedules, rosters
// and roster moves for the seven NY teams.
// X posts need an API bearer token in the X_BEARER_TOKEN env var; without it X is skipped.
// Runs every 5 minutes in GitHub Actions (see .github/workflows/sports-update.yml).
// No dependencies: Node 18+ (global fetch).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ESPN, espnRoster, espnNews, gameSummary } from '../sports/js/espn.mjs';
import {
  MOVE_WORDS, INJURY_WORDS, flattenReporters, buildXQueries, xSearchUrl, parseXSearch,
  bskyFeedUrl, parseBskyFeed, teamsForPost, mergePosts,
} from '../sports/js/insiders.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'sports', 'data');
const FEED_PATH = path.join(DATA_DIR, 'feed.json');

const MAX_NEWS = 400;
const MAX_MOVES = 300;
const NEWS_MAX_AGE_DAYS = 21;
const MAX_INSIDERS = 600;
const INSIDER_MAX_AGE_DAYS = 4;
const REPORTER_CHECK_HOURS = 24;
const STALE_REPORTER_DAYS = 30;

// ───────────────────────── helpers ─────────────────────────

async function fetchText(url, { timeout = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NYSportsWire/1.0)', accept: '*/*', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 400 ? `: ${(await res.text()).slice(0, 200)}` : ''}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const fetchJSON = async (url, opts) => JSON.parse(await fetchText(url, opts));

const errors = [];
async function attempt(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return fallback;
  }
}

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const stripTags = (s = '') => decodeEntities(decodeEntities(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function attr(xml, name, attribute) {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${attribute}="([^"]+)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const normTitle = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isoOrNull = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

// ───────────────────────── RSS / Atom ─────────────────────────

export function parseFeed(xml, fallbackSource = '') {
  const channelTitle = stripTags(tag(xml.split(/<(item|entry)[\s>]/i)[0], 'title')) || fallbackSource;
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    let title = stripTags(tag(b, 'title'));
    let source = stripTags(tag(b, 'source')) || channelTitle;
    // Google News appends " - Publisher" to titles.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const link = stripTags(tag(b, 'link')) || attr(b, 'link', 'href');
    const rawSummary = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content');
    const image =
      attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') ||
      attr(b, 'enclosure', 'url') || (decodeEntities(rawSummary).match(/<img[^>]+src="([^"]+)"/i) || [])[1] || '';
    let summary = stripTags(rawSummary);
    if (summary.startsWith(title)) summary = summary.slice(title.length).trim();
    return {
      title,
      url: link,
      summary: truncate(summary, 260),
      source: source || hostOf(link),
      published: isoOrNull(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
      image: /^https?:/.test(image) ? image : '',
    };
  }).filter((i) => i.title && i.url);
}

// ───────────────────────── ESPN ─────────────────────────

async function teamData(team) {
  const base = `${ESPN}/${team.sport}/${team.espnLeague}`;
  const info = await fetchJSON(`${base}/teams/${team.espn}`);
  const t = info.team;
  const out = {
    espnId: t.id,
    logo: t.logos?.[0]?.href || '',
    record: t.record?.items?.find((i) => i.type === 'total')?.summary || t.record?.items?.[0]?.summary || '',
    standing: t.standingSummary || '',
    nextGame: t.nextEvent?.[0] ? gameSummary(t.nextEvent[0], t.id) : null,
    lastGame: null,
    roster: [],
  };

  const sched = await attempt(`${team.key} schedule`, () => fetchJSON(`${base}/teams/${t.id}/schedule`));
  if (sched?.events) {
    const games = sched.events.map((e) => gameSummary(e, t.id)).filter(Boolean);
    const done = games.filter((g) => g.state === 'post');
    out.lastGame = done[done.length - 1] || null;
    if (!out.nextGame || out.nextGame.state === 'post') out.nextGame = games.find((g) => g.state !== 'post') || null;
  }

  const roster = await attempt(`${team.key} roster`, () => fetchJSON(`${base}/teams/${t.id}/roster`));
  if (roster) out.roster = espnRoster(roster);

  const news = await attempt(`${team.key} espn news`, () => fetchJSON(`${base}/news?team=${t.id}&limit=30`), { articles: [] });
  out.news = espnNews(news);

  return out;
}

// ───────────────────────── MLB transactions ─────────────────────────

async function mlbTransactions(team) {
  const end = new Date();
  const start = new Date(end - 45 * 864e5);
  const d = (x) => x.toISOString().slice(0, 10);
  const json = await fetchJSON(`https://statsapi.mlb.com/api/v1/transactions?teamId=${team.mlbId}&startDate=${d(start)}&endDate=${d(end)}`);
  return (json.transactions || []).filter((t) => t.description).map((t) => ({
    id: `mlb-${t.id}`,
    team: team.key,
    date: isoOrNull(t.effectiveDate || t.date) || isoOrNull(t.date),
    type: t.typeDesc || 'Transaction',
    player: t.person?.fullName || '',
    description: t.description,
    source: 'MLB.com',
    url: `https://www.mlb.com/${team.name.toLowerCase()}/roster/transactions`,
  }));
}

// ───────────────────────── beat reporters ─────────────────────────

async function xPosts(reporters, teams, prev, token) {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const sinceIds = { ...(prev.insiderState?.sinceIds || {}) };
  const posts = [];
  const startTime = new Date(Date.now() - 24 * 3600e3).toISOString();
  for (const query of buildXQueries(reporters)) {
    const key = createHash('sha1').update(query).digest('hex').slice(0, 12);
    let json = await attempt('x search', () => fetchJSON(xSearchUrl(query, { sinceId: sinceIds[key], startTime }), auth));
    // since_id older than X's 7-day search window is rejected; fall back to a time window.
    if (!json && sinceIds[key]) json = await attempt('x search retry', () => fetchJSON(xSearchUrl(query, { startTime }), auth));
    if (!json) continue;
    if (json.meta?.newest_id) sinceIds[key] = json.meta.newest_id;
    posts.push(...parseXSearch(json, reporters, teams));
  }

  // Once a day, look up every handle so renamed or deleted accounts get flagged.
  let missing = prev.reporterStatus?.missing || [];
  let checkedAt = prev.reporterStatus?.checkedAt || null;
  if (!checkedAt || Date.now() - Date.parse(checkedAt) > REPORTER_CHECK_HOURS * 3600e3) {
    const handles = reporters.filter((r) => r.x).map((r) => r.x);
    const found = new Set();
    let ok = true;
    for (let i = 0; i < handles.length; i += 100) {
      const json = await attempt('x user lookup', () => fetchJSON(`https://api.x.com/2/users/by?usernames=${handles.slice(i, i + 100).join(',')}`, auth));
      if (!json) { ok = false; break; }
      for (const u of json.data || []) found.add(u.username.toLowerCase());
    }
    if (ok) { missing = handles.filter((h) => !found.has(h.toLowerCase())); checkedAt = new Date().toISOString(); }
  }
  return { posts, sinceIds, missing, checkedAt };
}

async function insiders(teams, prev) {
  const dir = JSON.parse(await readFile(path.join(DATA_DIR, 'reporters.json'), 'utf8'));
  const reporters = flattenReporters(dir);
  const token = process.env.X_BEARER_TOKEN;

  const x = token ? await xPosts(reporters, teams, prev, token) : null;
  if (!token) errors.push('X_BEARER_TOKEN not set: X posts skipped');

  const bsky = (await Promise.all(reporters.filter((r) => r.bsky).map((r) =>
    attempt(`bsky ${r.bsky}`, async () => parseBskyFeed(await fetchJSON(bskyFeedUrl(r.bsky)), r, teams), [])))).flat();

  const rss = (await Promise.all(reporters.filter((r) => r.rss).map((r) =>
    attempt(`rss ${r.name}`, async () => parseFeed(await fetchText(r.rss), r.outlet).map((i) => ({
      id: `rss-${normTitle(i.title).replace(/ /g, '-').slice(0, 60)}`, platform: 'article', url: i.url, published: i.published,
      text: i.title, image: i.image, reporter: r.name, outlet: r.outlet, handle: r.x || '', avatar: '',
      teams: teamsForPost(i.title, r, teams), isMove: MOVE_WORDS.test(i.title), isInjury: INJURY_WORDS.test(i.title), national: !r.team,
    })).filter((p) => p.published && p.teams.length), [])))).flat();

  const cutoff = Date.now() - INSIDER_MAX_AGE_DAYS * 864e5;
  const posts = mergePosts(x?.posts || [], bsky, rss, prev.insiders || [])
    .filter((p) => Date.parse(p.published) >= cutoff)
    .slice(0, MAX_INSIDERS);

  // Last post per reporter, carried across runs, to spot handles that went quiet.
  const lastPost = { ...(prev.reporterStatus?.lastPost || {}) };
  for (const p of posts) if (!lastPost[p.reporter] || p.published > lastPost[p.reporter]) lastPost[p.reporter] = p.published;
  const staleCutoff = Date.now() - STALE_REPORTER_DAYS * 864e5;
  const stale = token ? reporters.filter((r) => lastPost[r.name] && Date.parse(lastPost[r.name]) < staleCutoff).map((r) => r.name) : [];

  return {
    insiders: posts,
    insiderState: { sinceIds: x?.sinceIds || prev.insiderState?.sinceIds || {} },
    reporterStatus: {
      checkedAt: x?.checkedAt || prev.reporterStatus?.checkedAt || null,
      missing: x?.missing || prev.reporterStatus?.missing || [],
      stale,
      lastPost,
    },
  };
}

// ───────────────────────── main ─────────────────────────

// Nicknames like "Giants" or "Rangers" are ambiguous league-wide, so cross-tagging only
// uses the unambiguous keywords in teams.json; the source team is always kept.
function tagTeams(item, teams) {
  const text = `${item.title} ${item.summary}`;
  const keys = new Set(item.teams || []);
  for (const t of teams) if (t.keywords.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(text))) keys.add(t.key);
  return [...keys];
}

async function main() {
  const teams = JSON.parse(await readFile(path.join(DATA_DIR, 'teams.json'), 'utf8'));
  const prev = await attempt('previous feed', async () => JSON.parse(await readFile(FEED_PATH, 'utf8')), {});
  const now = new Date().toISOString();

  const teamOut = {};
  const rawNews = [];
  let moves = [...(prev.moves || [])];

  await Promise.all(teams.map(async (team) => {
    const data = await attempt(`${team.key} espn`, () => teamData(team));
    const prevTeam = prev.teams?.[team.key] || {};
    if (data) {
      for (const n of data.news || []) rawNews.push({ ...n, teams: [team.key] });
      delete data.news;
      // A failed roster fetch keeps the last good roster rather than reporting everyone as released.
      if (!data.roster.length && prevTeam.roster?.length) data.roster = prevTeam.roster;
      teamOut[team.key] = { ...data, updatedAt: now };

      // Roster diff → moves. Skipped on the first run (nothing to compare against).
      if (prevTeam.roster?.length && data.roster.length) {
        const before = new Map(prevTeam.roster.map((p) => [p.id, p]));
        const after = new Map(data.roster.map((p) => [p.id, p]));
        for (const [id, p] of after) if (!before.has(id)) moves.push({
          id: `roster-${team.key}-${id}-in-${now.slice(0, 10)}`, team: team.key, date: now, type: 'Added to roster',
          player: p.name, description: `${p.name}${p.pos ? ` (${p.pos})` : ''} joined the ${team.full} active roster.`, source: 'Roster tracker',
        });
        for (const [id, p] of before) if (!after.has(id)) moves.push({
          id: `roster-${team.key}-${id}-out-${now.slice(0, 10)}`, team: team.key, date: now, type: 'Removed from roster',
          player: p.name, description: `${p.name}${p.pos ? ` (${p.pos})` : ''} is no longer on the ${team.full} active roster.`, source: 'Roster tracker',
        });
      }
    } else if (prev.teams?.[team.key]) {
      teamOut[team.key] = prevTeam;
    }

    if (team.mlbId) moves.push(...await attempt(`${team.key} mlb transactions`, () => mlbTransactions(team), []));

    const gn = `https://news.google.com/rss/search?q=${encodeURIComponent(`${team.query} when:7d`)}&hl=en-US&gl=US&ceid=US:en`;
    const gnMoves = `https://news.google.com/rss/search?q=${encodeURIComponent(`${team.query} (signs OR trade OR waived OR released OR acquire OR "injured reserve" OR "injured list" OR activated OR recalled OR claimed) when:14d`)}&hl=en-US&gl=US&ceid=US:en`;
    for (const url of [gn, gnMoves, ...team.feeds]) {
      const items = await attempt(`${team.key} ${hostOf(url)}`, async () => parseFeed(await fetchText(url), hostOf(url)), []);
      for (const i of items.slice(0, 40)) rawNews.push({ ...i, teams: [team.key], feed: url === gnMoves ? 'moves' : 'news' });
    }
  }));

  // Merge, tag, dedupe news. Previous items are kept so stories persist between runs.
  const cutoff = Date.now() - NEWS_MAX_AGE_DAYS * 864e5;
  const byKey = new Map();
  for (const item of [...rawNews, ...(prev.news || [])]) {
    if (!item.published || Date.parse(item.published) < cutoff) continue;
    const k = normTitle(item.title);
    const existing = byKey.get(k);
    const teamKeys = tagTeams(item, teams);
    if (existing) {
      existing.teams = [...new Set([...existing.teams, ...teamKeys])];
      existing.image ||= item.image;
      existing.summary ||= item.summary;
      existing.isMove ||= item.isMove || (item.feed === 'moves' && MOVE_WORDS.test(item.title));
      continue;
    }
    byKey.set(k, {
      id: k.replace(/ /g, '-').slice(0, 60),
      title: item.title,
      url: item.url,
      summary: item.summary || '',
      source: item.source || hostOf(item.url),
      published: item.published,
      image: item.image || '',
      teams: teamKeys,
      isMove: item.isMove || MOVE_WORDS.test(item.title),
      isInjury: INJURY_WORDS.test(item.title),
    });
  }
  const news = [...byKey.values()]
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .slice(0, MAX_NEWS);

  const insiderData = await insiders(teams, prev);

  const seen = new Set();
  moves = moves
    .filter((m) => m.date && !seen.has(m.id) && seen.add(m.id))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, MAX_MOVES);

  const content = { teams: teamOut, news, moves, ...insiderData };
  await writeFile(FEED_PATH, JSON.stringify({ generatedAt: now, ...content, errors }, null, 1) + '\n');
  console.log(`news=${news.length} moves=${moves.length} insiders=${insiderData.insiders.length} teams=${Object.keys(teamOut).length} errors=${errors.length}`);
  if (insiderData.reporterStatus.missing.length) console.warn(`  ! X handles not found: ${insiderData.reporterStatus.missing.join(', ')}`);
  if (insiderData.reporterStatus.stale.length) console.warn(`  ! No posts in ${STALE_REPORTER_DAYS}d: ${insiderData.reporterStatus.stale.join(', ')}`);
  for (const e of errors) console.warn('  ! ' + e);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
