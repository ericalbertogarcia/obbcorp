// Parses ESPN's game summary endpoint (…/summary?event=ID) into a live game view.
// Each league shapes its plays differently, so every field is read defensively.

import { INJURY_WORDS } from './insiders.mjs';
import { parseOdds } from './espn.mjs';

const MLB_NOISE = /^(ball|strike|foul|pickoff|mound visit|batter timeout|pitch|\w+ (pitches|pitching) to\b)/i;

function periodLabel(sport, period) {
  if (!period) return '';
  if (period.displayValue) return period.displayValue;
  const n = period.number;
  if (sport === 'baseball') return `${period.type || ''} ${n}`.trim();
  if (sport === 'hockey') return n > 3 ? 'OT' : `P${n}`;
  return n > 4 ? 'OT' : `Q${n}`;
}

function normPlay(p, sport, teamNames) {
  const text = (p.text || p.shortText || p.description || '').trim();
  return {
    id: String(p.id ?? `${p.period?.number}-${p.clock?.displayValue}-${text.slice(0, 20)}`),
    text,
    period: periodLabel(sport, p.period),
    clock: p.clock?.displayValue || '',
    scoring: !!p.scoringPlay,
    team: teamNames[String(p.team?.id)] || '',
    score: p.awayScore != null && p.homeScore != null ? `${p.awayScore}–${p.homeScore}` : '',
    injury: INJURY_WORDS.test(text),
  };
}

function periodHeader(sport, i) {
  const n = i + 1;
  const regulation = sport === 'hockey' ? 3 : sport === 'baseball' ? Infinity : 4;
  if (n <= regulation) return String(n);
  const ot = n - regulation;
  return ot === 1 ? 'OT' : `${ot}OT`;
}

// Score by period/inning, away team first as in a printed box score.
function lineScore(competitors, teamId, sport) {
  const rows = [...competitors].sort((a, b) => (a.homeAway === 'away' ? -1 : b.homeAway === 'away' ? 1 : 0)).map((c) => ({
    abbr: c.team?.abbreviation || '',
    ours: String(c.id ?? c.team?.id) === String(teamId),
    periods: (c.linescores || []).map((l) => l.displayValue ?? l.value ?? ''),
    total: typeof c.score === 'object' ? c.score?.displayValue : c.score ?? '',
    hits: c.hits ?? null,
    errors: c.errors ?? null,
  }));
  const n = Math.max(0, ...rows.map((r) => r.periods.length));
  if (!n) return null;
  return { headers: Array.from({ length: n }, (_, i) => periodHeader(sport, i)), rows, rhe: sport === 'baseball' && rows.every((r) => r.hits != null) };
}

// ESPN names groups inconsistently: NFL "New York Passing" (+ name "passing"), MLB type "batting",
// NHL name "defenses", NBA nothing at all.
const GROUP_TITLES = { defenses: 'Defense', forwards: 'Forwards', goalies: 'Goalies', skaters: 'Skaters', kickReturns: 'Kick returns', puntReturns: 'Punt returns' };
function groupTitle(g) {
  const key = g.name || g.type || '';
  if (GROUP_TITLES[key]) return GROUP_TITLES[key];
  if (key) return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  return g.displayName || 'Players';
}

// Player stat tables per team and category (passing, batting, skaters, …).
function playerBox(json, teamId) {
  return (json.boxscore?.players || []).map((p) => ({
    abbr: p.team?.abbreviation || '',
    name: p.team?.displayName || '',
    ours: String(p.team?.id) === String(teamId),
    groups: (p.statistics || []).map((g) => ({
      title: groupTitle(g),
      labels: g.labels || [],
      rows: (g.athletes || []).filter((a) => a.stats?.length).map((a) => ({
        name: a.athlete?.shortName || a.athlete?.displayName || '',
        pos: a.athlete?.position?.abbreviation || '',
        starter: !!a.starter,
        stats: a.stats,
      })),
      totals: g.totals || [],
    })).filter((g) => g.rows.length && g.labels.length),
  })).filter((t) => t.groups.length).sort((a, b) => b.ours - a.ours);
}

// Side-by-side team totals (yards, shots, rebounds, …).
function teamStats(json, teamId) {
  const teams = json.boxscore?.teams || [];
  const us = teams.find((t) => String(t.team?.id) === String(teamId));
  const them = teams.find((t) => t !== us);
  if (!us || !them) return [];
  const theirs = new Map((them.statistics || []).map((s) => [s.name || s.label, s.displayValue]));
  return (us.statistics || []).filter((s) => s.displayValue != null && theirs.has(s.name || s.label))
    .map((s) => ({ label: s.label || s.name, us: s.displayValue, them: theirs.get(s.name || s.label) })).slice(0, 12);
}

// Every play, grouped by quarter / period / inning, newest period first and newest play first.
function groupByPeriod(plays) {
  const groups = [];
  for (const p of plays) {
    let g = groups[groups.length - 1];
    if (!g || g.label !== p.period) groups.push((g = { label: p.period || 'Game', plays: [] }));
    g.plays.push(p);
  }
  return groups.reverse().map((g) => ({
    label: g.label,
    plays: g.plays.reverse(),
    scoring: g.plays.filter((p) => p.scoring).length,
    injury: g.plays.some((p) => p.injury),
  }));
}

export function parseSummary(json, teamId, sport) {
  const comp = json.header?.competitions?.[0] || {};
  const competitors = comp.competitors || [];
  const teamNames = Object.fromEntries(competitors.map((c) => [String(c.id ?? c.team?.id), c.team?.abbreviation || c.team?.displayName]));
  const us = competitors.find((c) => String(c.id ?? c.team?.id) === String(teamId));
  const them = competitors.find((c) => c !== us);
  const status = comp.status?.type || {};

  let plays = [];
  if (sport === 'football') {
    const drives = [...(json.drives?.previous || []), ...(json.drives?.current ? [json.drives.current] : [])];
    plays = drives.flatMap((d) => d.plays || []);
    // Drive lists can repeat the current drive's plays.
    const seen = new Set();
    plays = plays.filter((p) => !seen.has(p.id) && seen.add(p.id));
  } else {
    plays = json.plays || [];
  }
  plays = plays.map((p) => normPlay(p, sport, teamNames)).filter((p) => p.text);
  if (sport === 'baseball') plays = plays.filter((p) => p.scoring || (p.text.length > 24 && !MLB_NOISE.test(p.text)));

  const scoring = (json.scoringPlays?.length ? json.scoringPlays.map((p) => normPlay(p, sport, teamNames)) : plays.filter((p) => p.scoring));

  const injuries = (json.injuries || []).flatMap((t) => (t.injuries || []).map((i) => ({
    team: t.team?.abbreviation || '',
    ours: String(t.team?.id) === String(teamId),
    player: i.athlete?.displayName || '',
    pos: i.athlete?.position?.abbreviation || '',
    status: i.status || i.type?.description || '',
    detail: [i.details?.type, i.details?.location, i.details?.detail].filter(Boolean).join(' · '),
  }))).filter((i) => i.player);

  const leaders = (json.leaders || []).filter((l) => String(l.team?.id) === String(teamId))
    .flatMap((l) => (l.leaders || []).map((cat) => ({
      category: cat.displayName || cat.name,
      player: cat.leaders?.[0]?.athlete?.displayName || '',
      value: cat.leaders?.[0]?.displayValue || '',
    }))).filter((l) => l.player).slice(0, 4);

  return {
    state: status.state || '',
    detail: status.shortDetail || status.detail || '',
    us: { name: us?.team?.displayName, abbr: us?.team?.abbreviation, score: us?.score ?? '', logo: us?.team?.logos?.[0]?.href || us?.team?.logo || '' },
    them: { name: them?.team?.displayName, abbr: them?.team?.abbreviation, score: them?.score ?? '', logo: them?.team?.logos?.[0]?.href || them?.team?.logo || '' },
    home: us?.homeAway === 'home',
    odds: parseOdds(json.pickcenter || json.odds, { home: us?.homeAway === 'home', abbr: us?.team?.abbreviation, oppAbbr: them?.team?.abbreviation, sport }),
    linescore: lineScore(competitors, teamId, sport),
    boxPlayers: playerBox(json, teamId),
    teamStats: teamStats(json, teamId),
    plays: plays.slice(-40).reverse(),
    periods: groupByPeriod(plays),
    scoring: scoring.reverse(),
    inGameInjuries: plays.filter((p) => p.injury).reverse(),
    injuries,
    leaders,
  };
}
