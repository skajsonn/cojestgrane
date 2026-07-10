// Zakładka „Premiery” — globalny kalendarz premier kinowych bieżącego roku
// (najciekawsze wg TMDB dla regionu PL) połączony z repertuarem Cinema City
// i watchlistami. Widok miesiąca + lista premier danego miesiąca.

import { el, dateInfo, todayIso, normalizeTitle } from './utils.js';
import { genreLabel } from './labels.js';
import { openFilmDialog } from './ui.js';

const CREAM_POPULARITY = 8;  // „hit” (skala popularity TMDB po 2024 jest mała — Diuna ~9)

const MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const DOWS = ['pn', 'wt', 'śr', 'cz', 'pt', 'sb', 'nd'];

let data = null;
let entries = [];             // scalone premiery całego roku
let month = null;             // "YYYY-MM"

const $ = (id) => document.getElementById(id);

export async function initPremieres(loadedData) {
  data = loadedData;
  month = todayIso().slice(0, 7);

  const calendar = await fetch('data/calendar.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  entries = buildEntries(calendar);
  $('prem-cream').addEventListener('input', render);
  $('cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('cal-next').addEventListener('click', () => shiftMonth(1));
  render();
  renderRetro();
}

export function refresh(loadedData) {
  data = loadedData;
  for (const e of entries) matchProfile(e); // watchlisty mogły się zmienić
  render();
  renderRetro();
}

/* ── klasyka (retro) grana lub w przedsprzedaży ─────────────────── */
function renderRetro() {
  const block = $('retro-block');
  const box = $('retro-films');
  box.replaceChildren();

  const retro = data.repertoire.films
    .filter((f) => f.status === 'retro')
    .filter((f) => Object.keys(f.showings).some((cid) => data.cinemaSet.has(cid)))
    .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''));

  block.hidden = retro.length === 0;
  for (const f of retro) {
    const e = {
      key: 'retro:' + f.id,
      title: f.title,
      originalTitle: f.originalTitle,
      date: f.releaseDate,
      poster: f.poster ?? f.tmdb?.poster,
      genres: f.genres.map(genreLabel),
      cc: f,
      watchlisted: f.lbWatchlisted,
      watched: f.lbWatched,
    };
    box.append(premRow(e));
  }
}

/** Zakres dat seansów filmu w preferowanych kinach: "24.07–30.07". */
function playRange(film) {
  const dates = [];
  for (const [cid, byDate] of Object.entries(film.showings)) {
    if (!data.cinemaSet.has(cid)) continue;
    dates.push(...Object.keys(byDate));
  }
  if (!dates.length) return null;
  dates.sort();
  const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
  const first = dates[0];
  const last = dates[dates.length - 1];
  return first === last ? `gra ${fmt(first)}` : `gra ${fmt(first)}–${fmt(last)}`;
}

/* ── scalanie źródeł: TMDB (globalne) + Cinema City + watchlisty ── */
function buildEntries(calendar) {
  const out = new Map(); // klucz: tmdbId lub cc:<id>
  const ccByTmdb = new Map();
  for (const f of data.repertoire.films) {
    if (f.tmdb?.id) ccByTmdb.set(f.tmdb.id, f);
  }

  for (const c of calendar?.films ?? []) {
    const cc = ccByTmdb.get(c.tmdbId) ?? null;
    out.set(c.tmdbId, {
      key: String(c.tmdbId),
      title: cc?.title ?? c.title,
      originalTitle: c.originalTitle,
      date: cc?.releaseDate ?? c.date, // dokładna polska data z CC, gdy znana
      poster: cc?.poster ?? c.poster,
      popularity: c.popularity,
      voteAverage: c.voteAverage,
      voteCount: c.voteCount,
      genres: c.genres,
      overview: c.overview,
      cc,
    });
  }

  // premiery z repertuaru CC, których nie ma na liście TMDB
  const today = todayIso();
  for (const f of data.repertoire.films) {
    if (!f.releaseDate || f.releaseDate < today) continue;
    if (f.tmdb?.id && out.has(f.tmdb.id)) continue;
    out.set('cc:' + f.id, {
      key: 'cc:' + f.id,
      title: f.title,
      originalTitle: f.originalTitle,
      date: f.releaseDate,
      poster: f.poster ?? f.tmdb?.poster,
      popularity: 0,
      voteAverage: f.tmdb?.voteAverage ?? null,
      voteCount: f.tmdb?.voteCount ?? 0,
      genres: f.genres.map(genreLabel),
      overview: f.tmdb?.overview ?? null,
      cc: f,
    });
  }

  const list = [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const e of list) matchProfile(e);
  return list;
}

/** Dopasowanie wpisu kalendarza do watchlist/obejrzanych (po tytule). */
function matchProfile(e) {
  if (e.cc) {
    e.watchlisted = e.cc.lbWatchlisted ?? null;
    e.watched = e.cc.lbWatched ?? null;
    return;
  }
  const norms = new Set([normalizeTitle(e.title)]);
  if (e.originalTitle) norms.add(normalizeTitle(e.originalTitle));
  const find = (list) => list.find((w) => norms.has(w.norm)) ?? null;
  e.watchlisted = find(data.merged.watchlist);
  e.watched = find(data.merged.watched);
}

function isCream(e) {
  return !!e.watchlisted || !!e.watched || !!e.cc ||
    (e.popularity ?? 0) >= CREAM_POPULARITY ||
    (e.cc?.lbRating ?? 0) >= 3.5;
}

/* ── nawigacja miesięcy ─────────────────────────────────────────── */
function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  render();
}

/* ── render ─────────────────────────────────────────────────────── */
function render() {
  const cream = $('prem-cream').checked;
  const inMonth = entries.filter((e) => e.date.startsWith(month));
  const visible = cream ? inMonth.filter(isCream) : inMonth;

  const [y, m] = month.split('-').map(Number);
  $('cal-title').textContent = `${MONTHS[m - 1]} ${y}`;
  $('prem-summary').textContent = inMonth.length
    ? `${visible.length} z ${inMonth.length} premier w tym miesiącu` +
      (visible.some((e) => e.cc) ? ' · pozycje z biletami w Cinema City klikają się do repertuaru' : '')
    : '';
  $('prem-empty').hidden = visible.length > 0;

  renderGrid(y, m, visible);
  renderList(visible);
}

function renderGrid(year, m, visible) {
  const grid = $('cal-grid');
  grid.replaceChildren();
  for (const d of DOWS) grid.append(el('div', 'cal-dow', d));

  const byDay = new Map();
  for (const e of visible) {
    const day = Number(e.date.slice(8, 10));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const first = new Date(year, m - 1, 1);
  const lead = (first.getDay() + 6) % 7; // poniedziałek = 0
  const daysInMonth = new Date(year, m, 0).getDate();
  const today = todayIso();

  for (let i = 0; i < lead; i++) grid.append(el('div', 'cal-cell is-other'));
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cell = el('div', 'cal-cell' + (iso === today ? ' is-today' : ''));
    cell.append(el('span', 'cal-num', String(day)));
    for (const e of (byDay.get(day) ?? []).slice(0, 4)) {
      cell.append(calEntry(e));
    }
    const extra = (byDay.get(day)?.length ?? 0) - 4;
    if (extra > 0) cell.append(el('span', 'cal-more', `+${extra}`));
    grid.append(cell);
  }
}

function calEntry(e) {
  const btn = el('button', 'cal-entry' + (e.watchlisted ? ' is-wl' : ''));
  btn.type = 'button';
  btn.title = e.title;
  if (e.poster) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = e.poster;
    btn.append(img);
  }
  btn.append(el('span', null, e.title));
  btn.addEventListener('click', () => openEntry(e));
  return btn;
}

function renderList(visible) {
  const timeline = $('prem-timeline');
  timeline.replaceChildren();
  const today = todayIso();

  const byDate = new Map();
  for (const e of visible) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }

  for (const [date, group] of byDate) {
    const day = el('div', 'prem-day');
    const di = dateInfo(date, today);
    const diff = Math.round((new Date(date + 'T12:00') - new Date(today + 'T12:00')) / 86400000);
    const rel = diff === 0 ? 'dziś!' : diff === 1 ? 'jutro' : diff > 1 ? `za ${diff} dni` : 'już w kinach';
    const h = el('h3', 'prem-date', `${di.dowFull} ${di.dayMonth}`);
    h.append(el('span', 'pd-rel', rel));
    day.append(h);

    const list = el('div', 'prem-films');
    for (const e of group) list.append(premRow(e));
    day.append(list);
    timeline.append(day);
  }
}

function premRow(e) {
  const row = el('article', 'prem-film');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Szczegóły: ${e.title}`);

  const thumb = el('div', 'prem-thumb');
  if (e.poster) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = e.poster;
    thumb.append(img);
  } else {
    thumb.append(el('div', 'poster-fallback', '🎞'));
  }
  row.append(thumb);

  const info = el('div', 'prem-info');
  const title = el('h4', 'prem-title', e.title);
  if (e.watchlisted) title.append(el('span', 'badge-inline badge-wl', '☆ watchlista'));
  if (e.watched) title.append(el('span', 'badge-inline badge-new', '✓ obejrzane'));
  if (e.cc?.status === 'retro') title.append(el('span', 'badge-inline badge-retro', 'RETRO'));
  if (e.cc) title.append(el('span', 'badge-inline badge-premiere', '🎟 bilety w CC'));
  if (e.cc?.lbRating) {
    const b = el('span', 'badge-inline badge-retro', `★ ${e.cc.lbRating.toFixed(2)}`);
    b.title = 'średnia Letterboxd';
    title.append(b);
  }
  info.append(title);

  const subBits = [];
  if (e.originalTitle) subBits.push(e.originalTitle);
  if (e.genres?.length) subBits.push(e.genres.slice(0, 3).join(', '));
  if (e.cc?.status === 'retro') {
    const range = playRange(e.cc);
    if (range) subBits.push(range);
  }
  info.append(el('p', 'prem-sub', subBits.join('  ·  ')));
  row.append(info);

  const open = () => openEntry(e);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
  });
  return row;
}

/* ── szczegóły wpisu ────────────────────────────────────────────── */
function openEntry(e) {
  if (e.cc) { openFilmDialog(e.cc); return; } // pełny harmonogram + bilety

  const dialog = $('film-dialog');
  const body = $('film-dialog-body');
  body.replaceChildren();

  const close = el('button', 'dialog-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Zamknij');
  close.addEventListener('click', () => dialog.close());
  body.append(close);

  const hero = el('div', 'film-hero');
  const posterWrap = el('div', 'poster-wrap');
  if (e.poster) {
    const img = document.createElement('img');
    img.alt = `Plakat: ${e.title}`;
    img.src = e.poster;
    posterWrap.append(img);
  } else {
    posterWrap.append(el('div', 'poster-fallback', '🎞'));
  }
  hero.append(posterWrap);

  const info = el('div');
  info.append(el('h2', null, e.title));
  if (e.originalTitle) info.append(el('p', 'orig-title', e.originalTitle));
  const meta = el('div', 'hero-meta');
  if (e.genres?.length) meta.append(el('span', null, e.genres.join(' · ')));
  info.append(meta);
  info.append(el('p', 'card-meta', `Premiera w Polsce: ${e.date}`));
  if (e.watchlisted) {
    info.append(el('p', 'card-meta', `☆ Na watchliście${e.watchlisted.user ? ` @${e.watchlisted.user}` : ''}`));
  }
  if (e.overview) info.append(el('p', 'overview', e.overview));
  info.append(el('p', 'hint', 'Tego filmu nie ma jeszcze w przedsprzedaży Cinema City — pojawi się w repertuarze automatycznie, gdy ruszą bilety.'));
  hero.append(info);
  body.append(hero);

  dialog.showModal();
}
