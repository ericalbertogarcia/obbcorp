// URLs and search-facing titles, shared by the browser app and scripts/build-pages.mjs
// so the prerendered pages and the live app always agree.

export const SITE_NAME = 'NY Sports Bar';
export const TAGLINE = 'The #1 site for New York sports';

// Tab id (as used in the app) → URL segment. Segments match what fans search for.
export const TAB_PATHS = { news: '', results: 'results', rumors: 'rumors', injuries: 'injuries', roster: 'roster', moves: 'transactions', game: 'live', insiders: 'insiders' };
// Live and insider views change minute to minute and add little for search; they're noindexed.
export const INDEXED_TABS = ['news', 'results', 'rumors', 'injuries', 'roster', 'moves'];

// Site-wide sections beyond the team pages.
export const SECTIONS = {
  futures: {
    path: '/futures/', label: 'Futures',
    title: 'New York Futures Odds: Super Bowl, World Series, NBA Title & Stanley Cup | NY Sports Bar',
    h1: 'New York Futures Odds',
    description: 'Championship, conference, division and award odds for the Giants, Jets, Bills, Yankees, Mets, Knicks, Nets, Liberty, Devils, Rangers and Islanders, updated throughout the day.',
  },
  fantasy: {
    path: '/fantasy-football/', label: 'Fantasy',
    title: 'Fantasy Football: Giants, Jets & Bills Projections, Points & Waiver Trends | NY Sports Bar',
    h1: 'Fantasy Football',
    description: 'Weekly fantasy football projections and points for every Giants, Jets and Bills player in PPR, half-PPR and standard scoring, plus the most added and dropped players and injury news.',
  },
};

export function teamPath(team, tab = 'news') {
  const seg = TAB_PATHS[tab];
  return `/${team.slug}/${seg ? `${seg}/` : ''}`;
}

export function parsePath(pathname, teams) {
  const [slug = '', seg = ''] = pathname.split('/').filter(Boolean);
  const section = Object.keys(SECTIONS).find((k) => SECTIONS[k].path === `/${slug}/`);
  if (section) return { key: '', tab: '', section };
  const team = teams.find((t) => t.slug === slug);
  if (!team) return { key: '', tab: '' };
  const tab = Object.keys(TAB_PATHS).find((k) => TAB_PATHS[k] === seg) ?? '';
  return { key: team.key, tab };
}

const teamList = (teams) => teams.map((t) => t.name).join(', ').replace(/, ([^,]*)$/, ' and $1');

export function homeMeta(teams) {
  return {
    title: `New York Sports News, Scores, Rumors & Odds | ${SITE_NAME}`,
    h1: 'New York Sports News',
    description: `${SITE_NAME} is the #1 site for New York sports: breaking news, live scores, trade rumors, injury updates and betting odds for the ${teamList(teams)}.`,
  };
}

export function teamMeta(t, tab = 'news', year = new Date().getFullYear()) {
  const f = t.full;
  const m = {
    news: [`${f} News, Rumors, Injuries & Scores`, `${f} News`,
      `The latest ${f} news, updated every few minutes: breaking headlines, beat reporter updates, trade rumors, injuries, live scores and betting odds.`],
    results: [`${f} Scores, Results & Betting Record`, `${f} Results`,
      `Recent ${f} scores and results with box scores, plus their record against the spread and over/under results for every game.`],
    rumors: [`${f} Rumors & Trade News`, `${f} Rumors`,
      `Latest ${f} trade rumors, free agent targets and signing buzz from ${t.name} beat reporters and national insiders, updated every few minutes.`],
    injuries: [`${f} Injury Report & Updates`, `${f} Injury Report`,
      `${f} injury report and injury news: who's out, who's questionable and in-game injury updates from ${t.name} beat reporters.`],
    roster: [`${f} Roster ${year}`, `${f} Roster`,
      `The current ${f} roster with jersey numbers, positions and injury status, plus the latest ${t.name} roster moves.`],
    moves: [`${f} Transactions & Roster Moves`, `${f} Transactions`,
      `Every ${f} transaction: signings, trades, releases, call-ups and injured list moves, tracked as they happen.`],
    game: [`${f} Live Score & Play-by-Play`, `${f} Live`,
      `Live ${f} score, play-by-play, scoring plays, in-game injury updates and betting lines.`],
    insiders: [`${f} Beat Reporters & Insider Updates`, `${f} Insiders`,
      `Posts from the ${f} beat reporters and national insiders we follow, in one feed.`],
  }[tab] || [];
  return { title: `${m[0]} | ${SITE_NAME}`, h1: m[1], description: m[2] };
}
