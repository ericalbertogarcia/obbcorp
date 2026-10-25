#!/usr/bin/env node
// Data-source diagnostics: compares ESPN rosters with official/authoritative sources and checks each
// team's last-game box score data. Writes diagnostics/report.json. Run in GitHub Actions, which
// can reach these APIs (e.g. a temporary workflow that runs it and commits the report).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESPN, espnRoster, gameSummary } from '../sports/js/espn.mjs';
import { parseSummary } from '../sports/js/gamecenter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; NYSportsBar/1.0)' };
const get = async (url) => {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};
const norm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();

const NHL_TRI = { njd: 'NJD', nyr: 'NYR', nyi: 'NYI' };
const SLEEPER = { nyg: ['nfl', 'NYG'], nyj: ['nfl', 'NYJ'], buf: ['nfl', 'BUF'], nyk: ['nba', 'NYK'], bkn: ['nba', 'BKN'] };

async function official(team, sleeperCache) {
  if (team.mlbId) {
    const active = await get(`https://statsapi.mlb.com/api/v1/teams/${team.mlbId}/roster?rosterType=active`);
    const forty = await get(`https://statsapi.mlb.com/api/v1/teams/${team.mlbId}/roster?rosterType=40Man`);
    return { source: 'MLB Stats API (active + 40-man)',
      players: forty.roster.map((r) => ({ name: r.person.fullName, pos: r.position?.abbreviation, status: r.status?.description,
        active: active.roster.some((a) => a.person.id === r.person.id) })) };
  }
  if (NHL_TRI[team.key]) {
    const j = await get(`https://api-web.nhle.com/v1/roster/${NHL_TRI[team.key]}/current`);
    return { source: 'NHL API', players: [...(j.forwards || []), ...(j.defensemen || []), ...(j.goalies || [])]
      .map((p) => ({ name: `${p.firstName?.default} ${p.lastName?.default}`, pos: p.positionCode, number: p.sweaterNumber })) };
  }
  if (SLEEPER[team.key]) {
    const [sport, abbr] = SLEEPER[team.key];
    sleeperCache[sport] ||= await get(`https://api.sleeper.app/v1/players/${sport}`);
    const players = Object.values(sleeperCache[sport]).filter((p) => p.team === abbr);
    return { source: `Sleeper ${sport.toUpperCase()}`, players: players.map((p) => ({ name: p.full_name || `${p.first_name} ${p.last_name}`,
      pos: p.position, status: p.status, injury: p.injury_status || '', depth: p.depth_chart_order ?? null })) };
  }
  return null;
}

async function main() {
  const teams = JSON.parse(await readFile(path.join(ROOT, 'sports/data/teams.json'), 'utf8'));
  let live = null;
  try { live = await get('https://nysportsbar.com/data/feed.json'); } catch (e) { live = { error: e.message }; }
  const sleeperCache = {};
  const report = { at: new Date().toISOString(), liveGeneratedAt: live?.generatedAt, liveErrors: live?.errors, teams: {} };

  for (const team of teams) {
    const r = {};
    const base = `${ESPN}/${team.sport}/${team.espnLeague}`;
    try {
      const info = (await get(`${base}/teams/${team.espn}`)).team;
      r.espnId = info.id; r.abbr = info.abbreviation;
      const raw = await get(`${base}/teams/${info.id}/roster`);
      const flat = (raw.athletes || []).flatMap((g) => (Array.isArray(g.items) ? g.items : [g]));
      r.espnRawStatusCounts = flat.reduce((m, a) => { const k = a.status?.name || a.status?.type || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {});
      r.espnRawSample = flat.slice(0, 3).map((a) => ({ name: a.fullName, status: a.status, injuries: a.injuries?.slice(0, 1), keys: Object.keys(a) }));
      const espn = espnRoster(raw);
      r.espnCount = espn.length;
      const off = await official(team, sleeperCache).catch((e) => ({ error: e.message }));
      if (off?.players) {
        const offSet = new Map(off.players.map((p) => [norm(p.name), p]));
        const espnSet = new Map(espn.map((p) => [norm(p.name), p]));
        r.official = { source: off.source, count: off.players.length,
          statusCounts: off.players.reduce((m, p) => { const k = p.status ?? (p.active === false ? 'not active' : 'listed'); m[k] = (m[k] || 0) + 1; return m; }, {}) };
        r.onEspnNotOfficial = espn.filter((p) => !offSet.has(norm(p.name))).map((p) => `${p.name} (${p.pos})`);
        r.onOfficialNotEspn = off.players.filter((p) => !espnSet.has(norm(p.name))).map((p) => `${p.name} (${p.pos}${p.status ? `, ${p.status}` : ''}${p.active === false ? ', not active' : ''})`);
        if (team.mlbId) r.espnNotActive = espn.filter((p) => offSet.get(norm(p.name))?.active === false).map((p) => p.name);
        if (SLEEPER[team.key]) r.espnButSleeperInactive = espn.filter((p) => { const o = offSet.get(norm(p.name)); return o && o.status && o.status !== 'Active'; }).map((p) => `${p.name}: ${offSet.get(norm(p.name)).status}`);
      } else r.official = off;
    } catch (e) { r.rosterError = e.message; }

    // Box score data for the last finished game.
    try {
      const sched = await get(`${base}/teams/${r.espnId}/schedule`);
      const games = (sched.events || []).map((e) => ({ id: e.id, date: e.date, seasonType: e.seasonType?.abbreviation || e.season?.type, g: gameSummary(e, r.espnId) }));
      r.schedule = { requestedSeason: sched.requestedSeason?.displayName || sched.season?.displayName, seasonType: sched.requestedSeason?.type, events: games.length,
        states: games.reduce((m, x) => { const k = x.g?.state || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {}) };
      const done = games.filter((x) => x.g?.state === 'post');
      const last = done[done.length - 1];
      r.liveLastGame = live?.teams?.[team.key]?.lastGame ? { id: live.teams[team.key].lastGame.id, date: live.teams[team.key].lastGame.date, state: live.teams[team.key].lastGame.state } : null;
      r.liveResults = (live?.teams?.[team.key]?.results || []).map((x) => ({ id: x.id, odds: !!x.odds, checked: x.lineChecked }));
      if (!last) { r.box = { note: 'no finished game in schedule' }; } else {
        const sum = await get(`${base}/summary?event=${last.id}`);
        const parsed = parseSummary(sum, r.espnId, team.sport);
        r.box = { id: last.id, date: last.date, topKeys: Object.keys(sum),
          headerCompetitorKeys: Object.keys(sum.header?.competitions?.[0]?.competitors?.[0] || {}),
          linescoreRows: parsed.linescore?.rows?.map((x) => `${x.abbr} ${x.periods.join(' ')} = ${x.total}`),
          boxPlayersTeams: parsed.boxPlayers.map((p) => `${p.abbr}: ${p.groups.map((g) => `${g.title}(${g.rows.length})`).join(', ')}`),
          rawPlayerGroups: (sum.boxscore?.players || []).map((p) => (p.statistics || []).map((s) => ({ name: s.name, text: s.text, labels: s.labels?.length, athletes: s.athletes?.length, keys: Object.keys(s) }))),
          teamStats: parsed.teamStats.length, odds: parsed.odds, pickcenterLen: sum.pickcenter?.length ?? null };
      }
    } catch (e) { r.boxError = e.message; }
    report.teams[team.key] = r;
  }
  await mkdir(path.join(ROOT, 'diagnostics'), { recursive: true });
  await writeFile(path.join(ROOT, 'diagnostics/report.json'), JSON.stringify(report, null, 1));
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
