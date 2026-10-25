// ESPN public site-API parsers, shared by the browser app and scripts/update-sports.mjs.

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

export const leagueBase = (team) => `${ESPN}/${team.sport}/${team.espnLeague}`;

const isoOrNull = (d) => { const t = Date.parse(d); return Number.isNaN(t) ? null : new Date(t).toISOString(); };
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// Rosters come grouped ({ position, items: [...] }) for most leagues, flat for others.
export function espnRoster(json) {
  const groups = json.athletes || [];
  const flat = groups.flatMap((g) => (Array.isArray(g.items) ? g.items.map((a) => ({ ...a, _group: g.position })) : [g]));
  return flat.map((a) => ({
    id: String(a.id ?? a.fullName),
    name: a.fullName || a.displayName,
    jersey: a.jersey ?? '',
    pos: a.position?.abbreviation || '',
    group: a._group || a.position?.parent?.name || a.position?.name || '',
    age: a.age ?? null,
    headshot: a.headshot?.href || '',
    status: a.injuries?.[0]?.status || '',
  })).filter((p) => p.name);
}

export function espnNews(json) {
  return (json.articles || []).map((a) => ({
    title: a.headline,
    url: a.links?.web?.href || '',
    summary: truncate(a.description || '', 260),
    source: 'ESPN',
    published: isoOrNull(a.published),
    image: a.images?.[0]?.url || '',
  })).filter((a) => a.title && a.url && a.published);
}

// Down & distance (NFL), count and outs (MLB); hockey scoreboards carry no situation.
function situationText(sit) {
  if (!sit) return '';
  if (sit.downDistanceText) return [sit.downDistanceText, sit.isRedZone ? 'Red zone' : ''].filter(Boolean).join(' · ');
  if (sit.outs != null) {
    const bases = [['onFirst', '1st'], ['onSecond', '2nd'], ['onThird', '3rd']].filter(([k]) => sit[k]).map(([, b]) => b);
    return `${sit.balls ?? 0}-${sit.strikes ?? 0}, ${sit.outs} out${sit.outs === 1 ? '' : 's'}${bases.length ? ` · on ${bases.join(', ')}` : ''}`;
  }
  return '';
}

// Sportsbook line from ESPN's `odds` (scoreboard) or `pickcenter` (summary), from one team's side.
// ESPN has shipped two shapes: flat (details/overUnder/moneyLine) and nested (pointSpread/moneyline/total
// with open/close), so both are read. `details` looks like "DAL -3.5" or "EVEN".
const num = (v) => (v == null || v === '' || Number.isNaN(Number(String(v).replace(/^[ou]/i, ''))) ? null : Number(String(v).replace(/^[ou]/i, '')));
const latest = (x) => x?.current ?? x?.close ?? x?.open;

export function parseOdds(list, { home, abbr, oppAbbr }) {
  const o = (Array.isArray(list) ? list : []).find((x) => x && (x.details || x.overUnder != null || x.moneyline || x.pointSpread));
  if (!o) return null;
  const side = home ? 'home' : 'away';
  const other = home ? 'away' : 'home';
  const ourOdds = home ? o.homeTeamOdds : o.awayTeamOdds;
  const theirOdds = home ? o.awayTeamOdds : o.homeTeamOdds;

  let spread = num(latest(o.pointSpread?.[side])?.line);
  if (spread == null && o.details) {
    const m = String(o.details).match(/^([A-Z0-9]{2,4})\s+([+-]?\d+(?:\.\d+)?)$/i);
    if (/^(even|pk|pick)/i.test(o.details)) spread = 0;
    else if (m) spread = m[1].toUpperCase() === String(abbr).toUpperCase() ? Number(m[2])
      : m[1].toUpperCase() === String(oppAbbr).toUpperCase() ? -Number(m[2]) : null;
  }
  const ml = ourOdds?.moneyLine ?? num(latest(o.moneyline?.[side])?.odds);
  const oppMl = theirOdds?.moneyLine ?? num(latest(o.moneyline?.[other])?.odds);
  const total = o.overUnder ?? num(latest(o.total?.over)?.line);
  if (spread == null && ml == null && total == null) return null;
  return { provider: o.provider?.displayName || o.provider?.name || 'Sportsbook', spread, ml, oppMl, total, details: o.details || '' };
}

// How the closing line played out for a finished game, from one team's side.
// Spread: our score + our spread vs theirs. Total: combined score vs the over/under.
export function betResults(odds, us, them) {
  const a = Number(us);
  const b = Number(them);
  if (!odds || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const cmp = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const out = {};
  if (odds.total != null) {
    const r = cmp(a + b - odds.total);
    out.total = { line: odds.total, actual: a + b, result: r > 0 ? 'Over' : r < 0 ? 'Under' : 'Push' };
  }
  if (odds.spread != null) {
    const r = cmp(a + odds.spread - b);
    out.spread = { line: odds.spread, result: r > 0 ? 'Covered' : r < 0 ? 'Did not cover' : 'Push' };
  }
  if (odds.ml != null && a !== b) out.ml = { line: odds.ml, result: a > b ? 'Won' : 'Lost' };
  return Object.keys(out).length ? { ...out, provider: odds.provider } : null;
}

// Straight-up, against-the-spread and over/under records over a list of finished games.
export function resultsRecord(results) {
  const r = { su: [0, 0, 0], ats: [0, 0, 0], ou: [0, 0, 0], withLine: 0 };
  for (const g of results) {
    const a = Number(g.us);
    const b = Number(g.them);
    r.su[a > b ? 0 : a < b ? 1 : 2]++;
    const bet = betResults(g.odds, g.us, g.them);
    if (!bet) continue;
    r.withLine++;
    if (bet.spread) r.ats[{ Covered: 0, 'Did not cover': 1, Push: 2 }[bet.spread.result]]++;
    if (bet.total) r.ou[{ Over: 0, Under: 1, Push: 2 }[bet.total.result]]++;
  }
  return r;
}

// Reduces an ESPN event to the game from one team's point of view.
export function gameSummary(event, teamId) {
  const comp = event?.competitions?.[0];
  if (!comp) return null;
  const us = comp.competitors.find((c) => String(c.id ?? c.team?.id) === String(teamId));
  const them = comp.competitors.find((c) => c !== us);
  if (!us || !them) return null;
  const score = (c) => (typeof c.score === 'object' ? c.score?.displayValue : c.score) ?? '';
  const status = comp.status?.type || event.status?.type || {};
  return {
    id: event.id,
    date: event.date,
    name: event.shortName || event.name,
    home: us.homeAway === 'home',
    opponent: them.team?.displayName || them.team?.name,
    opponentAbbr: them.team?.abbreviation,
    opponentLogo: them.team?.logos?.[0]?.href || them.team?.logo || '',
    us: score(us),
    them: score(them),
    winner: us.winner === true ? true : them.winner === true ? false : null,
    state: status.state || '',
    detail: status.shortDetail || status.detail || '',
    venue: comp.venue?.fullName || '',
    broadcast: comp.broadcasts?.[0]?.media?.shortName || comp.broadcasts?.[0]?.names?.[0] || '',
    lastPlay: comp.situation?.lastPlay?.text || '',
    situation: situationText(comp.situation),
    odds: parseOdds(comp.odds, { home: us.homeAway === 'home', abbr: us.team?.abbreviation, oppAbbr: them.team?.abbreviation }),
  };
}
