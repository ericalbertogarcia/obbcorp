#!/usr/bin/env node
// Builds the published site into dist/: a copy of sports/ plus a prerendered HTML page for the
// home page and every team view (/new-york-giants/, /new-york-giants/rumors/, …), each with its
// own title, description, canonical URL, social tags and structured data, filled with the latest
// headlines from sports/data/feed.json. Also writes sitemap.xml, robots.txt and 404.html.
// The title strip (#seo-head: breadcrumb, H1, intro) stays put; the browser app replaces the
// prerendered lists in #app with the live view, which carries the same headlines.
// Run after scripts/update-sports.mjs. No dependencies.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SITE_NAME, TAGLINE, TAB_PATHS, INDEXED_TABS, teamPath, teamMeta, homeMeta } from '../sports/js/seo.mjs';
import { betResults, resultsRecord } from '../sports/js/espn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'sports');
const OUT = path.join(ROOT, 'dist');
const SITE = (process.env.SITE_URL || 'https://nysportsbar.com').replace(/\/$/, '');
const TZ = 'America/New_York';

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const jsonLd = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const fmtDate = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtGame = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const signed = (n) => (n == null ? '' : n === 0 ? 'PK' : n > 0 ? `+${n}` : `${n}`);
const LEAGUE_ORG = { NFL: 'National Football League', MLB: 'Major League Baseball', NBA: 'National Basketball Association', WNBA: "Women's National Basketball Association", NHL: 'National Hockey League' };
const SPORT = { football: 'American football', baseball: 'Baseball', basketball: 'Basketball', hockey: 'Ice hockey' };

// ───────────────────────── page sections ─────────────────────────

function storyList(items, limit = 20) {
  if (!items.length) return '<p>No stories yet — check back shortly.</p>';
  return `<ul class="seo-list">${items.slice(0, limit).map((n) => `<li>
    <a href="${safeUrl(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
    <span class="meta">${esc(n.source)} · <time datetime="${esc(n.published)}">${esc(fmtDate(n.published))}</time></span>
  </li>`).join('')}</ul>`;
}

function gameSentence(t, info) {
  const g = info.nextGame;
  if (!g || g.state === 'post') return '';
  const odds = g.odds;
  const line = odds ? [
    odds.spread != null ? `${t.name} ${signed(odds.spread)}` : '',
    odds.ml != null ? `moneyline ${signed(odds.ml)}` : '',
    odds.total != null ? `over/under ${odds.total}` : '',
  ].filter(Boolean).join(', ') : '';
  return `<p><strong>Next game:</strong> ${g.home ? 'vs' : 'at'} ${esc(g.opponent)}, ${esc(fmtGame(g.date))}${g.broadcast ? ` on ${esc(g.broadcast)}` : ''}${g.venue ? ` at ${esc(g.venue)}` : ''}.${line ? ` Betting line: ${esc(line)} (${esc(odds.provider)}).` : ''}</p>`;
}

function lastGameSentence(t, info) {
  const g = info.lastGame;
  if (!g || g.state !== 'post') return '';
  const res = g.winner === true ? 'beat' : g.winner === false ? 'lost to' : 'played';
  return `<p><strong>Last game:</strong> The ${esc(t.name)} ${res} the ${esc(g.opponent)} ${esc(g.us)}–${esc(g.them)}.</p>`;
}

function intro(t, info) {
  const rec = info.record ? ` The ${esc(t.name)} are ${esc(info.record)}${info.standing ? ` (${esc(info.standing)})` : ''}.` : '';
  return `<p>Follow every ${esc(t.full)} story in one place. ${SITE_NAME} tracks ${esc(t.name)} news from beat reporters, ESPN and the New York papers, plus trade rumors, injury updates, roster moves, live scores and betting odds, refreshed every few minutes.${rec}</p>`;
}

function teamBody(t, tab, feed) {
  const info = feed.teams?.[t.key] || {};
  const news = (feed.news || []).filter((n) => n.teams?.includes(t.key));
  const meta = teamMeta(t, tab);
  const crumbs = `<nav class="seo-crumbs" aria-label="Breadcrumb"><a href="/">New York Sports</a> › <a href="${teamPath(t)}">${esc(t.full)}</a>${tab !== 'news' ? ` › ${esc(meta.h1.replace(`${t.full} `, ''))}` : ''}</nav>`;
  let body = '';
  if (tab === 'news') {
    body = `${gameSentence(t, info)}${lastGameSentence(t, info)}<h2>Latest ${esc(t.name)} headlines</h2>${storyList(news, 25)}`;
  } else if (tab === 'results') {
    const results = info.results || [];
    const rec = resultsRecord(results);
    const fmt = (a) => `${a[0]}-${a[1]}${a[2] ? `-${a[2]}` : ''}`;
    const abbr = t.espn.toUpperCase();
    body = results.length ? `<p>Over the last ${results.length} games the ${esc(t.name)} are ${fmt(rec.su)} straight up${rec.withLine
      ? `, ${fmt(rec.ats)} against the spread, and ${rec.ou[0]} overs, ${rec.ou[1]} unders${rec.ou[2] ? ` and ${rec.ou[2]} pushes` : ''} on the total` : ''}.</p>
      <h2>Recent ${esc(t.name)} scores</h2>
      <table class="seo-table"><thead><tr><th>Date</th><th>Opponent</th><th>Result</th><th>Spread</th><th>Total</th></tr></thead><tbody>${results.map((g) => {
        const bet = betResults(g.odds, g.us, g.them);
        const res = g.winner === true ? 'W' : g.winner === false ? 'L' : 'T';
        return `<tr><td>${esc(new Date(g.date).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }))}</td><td>${g.home ? 'vs' : 'at'} ${esc(g.opponent)}</td><td>${res} ${esc(g.us)}–${esc(g.them)}</td>
          <td>${bet?.spread ? `${abbr} ${signed(bet.spread.line)}: ${bet.spread.result}` : '—'}</td><td>${bet?.total ? `${bet.total.result} ${bet.total.line}` : '—'}</td></tr>`;
      }).join('')}</tbody></table>` : '<p>No finished games yet this season.</p>';
  } else if (tab === 'rumors') {
    body = `<h2>${esc(t.name)} trade and signing rumors</h2>${storyList(news.filter((n) => n.isRumor), 30)}<p>Rumors are unconfirmed reports from the outlets linked.</p>`;
  } else if (tab === 'injuries') {
    const hurt = (info.roster || []).filter((p) => p.status && !/^active$/i.test(p.status));
    body = `<h2>${esc(t.name)} injury report</h2>${hurt.length
      ? `<ul class="seo-list">${hurt.map((p) => `<li>${esc(p.name)} (${esc(p.pos)}) — ${esc(p.status)}</li>`).join('')}</ul>`
      : '<p>No players currently listed with an injury designation.</p>'}
      <h2>${esc(t.name)} injury news</h2>${storyList(news.filter((n) => n.isInjury), 20)}`;
  } else if (tab === 'roster') {
    const roster = info.roster || [];
    body = `<h2>${esc(t.full)} roster</h2>${roster.length
      ? `<table class="seo-table"><thead><tr><th>No.</th><th>Player</th><th>Pos</th><th>Status</th></tr></thead><tbody>${roster
        .slice().sort((a, b) => (+a.jersey || 999) - (+b.jersey || 999))
        .map((p) => `<tr><td>${esc(p.jersey)}</td><td>${esc(p.name)}</td><td>${esc(p.pos)}</td><td>${esc(p.status || 'Active')}</td></tr>`).join('')}</tbody></table>`
      : '<p>Roster loading — check back shortly.</p>'}`;
  } else if (tab === 'moves') {
    const moves = (feed.moves || []).filter((m) => m.team === t.key);
    const reported = news.filter((n) => n.isMove);
    body = `<h2>${esc(t.name)} transactions</h2>${moves.length
      ? `<ul class="seo-list">${moves.slice(0, 30).map((m) => `<li>${esc(m.description)} <span class="meta">${esc(m.type)} · <time datetime="${esc(m.date)}">${esc(fmtDate(m.date))}</time></span></li>`).join('')}</ul>`
      : '<p>No official transactions in the last few weeks.</p>'}
      <h2>Reported ${esc(t.name)} moves</h2>${storyList(reported, 20)}`;
  } else {
    body = `${gameSentence(t, info)}${lastGameSentence(t, info)}`;
  }
  return { top: `${crumbs}<h1>${esc(meta.h1)}</h1>${intro(t, info)}`, body: `<article class="seo-page">${body}</article>` };
}

function homeBody(teams, feed) {
  const meta = homeMeta(teams);
  const top = `<h1>${esc(meta.h1)}</h1>
    <p>${SITE_NAME} is ${TAGLINE.toLowerCase()}: breaking news, live scores, trade rumors, injury updates, roster moves and Vegas betting odds for every New York team, pulled from beat reporters, ESPN and the New York papers and refreshed every few minutes.</p>`;
  return { top, body: `<article class="seo-page">${teams.map((t) => {
      const items = (feed.news || []).filter((n) => n.teams?.includes(t.key)).slice(0, 3);
      return `<section><h2><a href="${teamPath(t)}">${esc(t.full)} news</a></h2>${storyList(items, 3)}
        <p><a href="${teamPath(t, 'rumors')}">${esc(t.name)} rumors</a> · <a href="${teamPath(t, 'injuries')}">${esc(t.name)} injury report</a> · <a href="${teamPath(t, 'roster')}">${esc(t.name)} roster</a></p></section>`;
    }).join('')}</article>` };
}

// Footer links on every page: every team and its main sections, for visitors and crawlers alike.
function footerLinks(teams) {
  return `<h2>New York teams</h2><ul>${teams.map((t) => `<li><a href="${teamPath(t)}">${esc(t.full)}</a>
    <a href="${teamPath(t, 'rumors')}">Rumors</a> <a href="${teamPath(t, 'injuries')}">Injuries</a> <a href="${teamPath(t, 'roster')}">Roster</a></li>`).join('')}</ul>`;
}

// ───────────────────────── head ─────────────────────────

function head({ title, description, url, noindex, ld }) {
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ''}<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${SITE}/og-image.png">
${ld.map(jsonLd).join('\n')}`;
}

function teamLd(t, tab) {
  const url = SITE + teamPath(t);
  const crumbs = [{ name: 'New York Sports', item: `${SITE}/` }, { name: t.full, item: url }];
  if (tab !== 'news') crumbs.push({ name: teamMeta(t, tab).h1, item: SITE + teamPath(t, tab) });
  return [
    { '@context': 'https://schema.org', '@type': 'SportsTeam', name: t.full, sport: SPORT[t.sport], url,
      memberOf: { '@type': 'SportsOrganization', name: LEAGUE_ORG[t.league] || t.league } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) },
  ];
}

const HOME_LD = [
  { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${SITE}/`, description: TAGLINE },
  { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: `${SITE}/`, logo: `${SITE}/icons/icon-512.png` },
];

// ───────────────────────── build ─────────────────────────

function fill(template, { headHtml, top, body, links }) {
  const out = template
    .replace(/<title>[\s\S]*?<\/title>\s*<meta name="description"[^>]*>/, headHtml)
    .replace('<div class="seo-head" id="seo-head"></div>', `<div class="seo-head" id="seo-head">${top}</div>`)
    .replace('<main id="app" class="page"></main>', `<main id="app" class="page">${body}</main>`)
    .replace('<nav class="seo-links" aria-label="New York teams"></nav>', `<nav class="seo-links" aria-label="New York teams">${links}</nav>`);
  if (out === template || !out.includes('rel="canonical"')) throw new Error('index.html template markers not found');
  return out;
}

async function main() {
  const template = await readFile(path.join(SRC, 'index.html'), 'utf8');
  const teams = JSON.parse(await readFile(path.join(SRC, 'data', 'teams.json'), 'utf8'));
  const feed = JSON.parse(await readFile(path.join(SRC, 'data', 'feed.json'), 'utf8'));
  const lastmod = feed.generatedAt || new Date().toISOString();
  const links = footerLinks(teams);

  await rm(OUT, { recursive: true, force: true });
  await cp(SRC, OUT, { recursive: true });

  const pages = [];
  const home = homeMeta(teams);
  const homeHtml = fill(template, { headHtml: head({ ...home, url: `${SITE}/`, ld: HOME_LD }), ...homeBody(teams, feed), links });
  await writeFile(path.join(OUT, 'index.html'), homeHtml);
  pages.push({ loc: `${SITE}/`, priority: '1.0' });
  // GitHub Pages serves 404.html for unknown paths; the app then routes by URL like any page.
  await writeFile(path.join(OUT, '404.html'), homeHtml.replace('<link rel="canonical"', '<meta name="robots" content="noindex">\n<link rel="canonical"'));

  for (const t of teams) {
    for (const tab of Object.keys(TAB_PATHS)) {
      const p = teamPath(t, tab);
      const noindex = !INDEXED_TABS.includes(tab);
      const html = fill(template, {
        headHtml: head({ ...teamMeta(t, tab), url: SITE + p, noindex, ld: teamLd(t, tab) }),
        ...teamBody(t, tab, feed),
        links,
      });
      await mkdir(path.join(OUT, p), { recursive: true });
      await writeFile(path.join(OUT, p, 'index.html'), html);
      if (!noindex) pages.push({ loc: SITE + p, priority: tab === 'news' ? '0.9' : '0.7' });
    }
  }

  await writeFile(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>${p.loc}</loc><lastmod>${lastmod}</lastmod><changefreq>hourly</changefreq><priority>${p.priority}</priority></url>`).join('\n')}
</urlset>
`);
  await writeFile(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`built ${pages.length} indexable pages (+ ${teams.length * (Object.keys(TAB_PATHS).length - INDEXED_TABS.length)} noindex) into dist/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
