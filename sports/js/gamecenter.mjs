// Parses ESPN's game summary endpoint (…/summary?event=ID) into a live game view.
// Each league shapes its plays differently, so every field is read defensively.

import { INJURY_WORDS } from './insiders.mjs';

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
    plays: plays.slice(-40).reverse(),
    scoring: scoring.reverse(),
    inGameInjuries: plays.filter((p) => p.injury).reverse(),
    injuries,
    leaders,
  };
}
