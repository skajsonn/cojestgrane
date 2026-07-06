// Sekcja „Warto iść” — pionowa lista bez limitu:
//  1) WSZYSTKIE nieobejrzane filmy z watchlist aktywnych kont, które grają
//     w preferowanych kinach albo są w przedsprzedaży,
//  2) potem „bangery” — wysoko oceniane filmy z bieżącego repertuaru.
// Czysta heurystyka, zero zewnętrznych wywołań.

import { el, todayIso, dateInfo, isPastShowing } from './utils.js';
import { fmtLabel, genreLabel, STATUS_INFO } from './labels.js';
import { openFilmDialog } from './ui.js';

const BANGER_TMDB = 7.0;   // próg oceny dla „bangera”
const BANGER_VOTES = 80;   // minimalna liczba głosów (odsiewa przypadkowe 10.0)
const BANGER_WINDOW = 14;  // banger musi grać w ciągu 2 tygodni

let data = null;
const $ = (id) => document.getElementById(id);

export function initReco(loadedData) {
  data = loadedData;
  render();
}

export function refresh(loadedData) {
  data = loadedData;
  render();
}

/* ── pomocnicze ─────────────────────────────────────────────────── */
function futureShowings(film, horizonIso = null) {
  const today = todayIso();
  const out = [];
  for (const [cid, byDate] of Object.entries(film.showings)) {
    if (!data.cinemaSet.has(cid)) continue;
    for (const [d, shows] of Object.entries(byDate)) {
      if (d < today || (horizonIso && d > horizonIso)) continue;
      for (const s of shows) {
        if (isPastShowing(d, s.time)) continue;
        out.push({ cid, date: d, ...s });
      }
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function nextShowingTxt(film) {
  const next = futureShowings(film)[0];
  if (!next) return '';
  const today = todayIso();
  const di = dateInfo(next.date, today);
  const cinema = data.cinemas.find((c) => c.id === next.cid);
  const fx = next.formats.length ? ` (${next.formats.map(fmtLabel).join(', ')})` : '';
  return `najbliższy seans: ${di.isToday ? 'dziś' : di.dowFull + ' ' + di.dayMonth} ${next.time}, ${cinema?.name ?? ''}${fx}`;
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── budowa listy ───────────────────────────────────────────────── */
function buildItems() {
  const today = todayIso();
  const horizon = addDaysIso(today, BANGER_WINDOW);
  const multi = data.merged.accounts.length > 1;
  const items = [];

  // 1) watchlisty — wszystko, bez limitu; obejrzenie przez inną osobę
  //    z paczki nie kasuje polecenia, tylko dodaje adnotację
  for (const film of data.repertoire.films) {
    if (!film.lbWatchlistedBy?.length) continue;
    const inPref = Object.keys(film.showings).some((cid) => data.cinemaSet.has(cid));
    if (!inPref) continue;

    const who = multi ? ` ${film.lbWatchlistedBy.map((e) => '@' + e.user).join(', ')}` : '';
    const reasons = [`na watchliście${who}`];
    if (film.status === 'premiere') reasons.push('premiera tygodnia');
    if (film.status === 'retro') reasons.push('kinowa powtórka');
    if (film.tmdb?.voteAverage >= 6.5) reasons.push(`TMDB ${film.tmdb.voteAverage}`);
    for (const w of film.lbWatchedBy ?? []) {
      reasons.push(`@${w.user} już widział${w.rating10 ? ` (${w.rating10}/10)` : ''}`);
    }

    const next = nextShowingTxt(film);
    const when = next ||
      (film.releaseDate && film.releaseDate > today
        ? `premiera ${film.releaseDate.slice(8, 10)}.${film.releaseDate.slice(5, 7)} — bilety w przedsprzedaży`
        : '');
    items.push({ film, group: 'watchlista', why: capitalize(reasons.join(', ')) + '.', when, sort: next ? '0' + next : '1' + (film.releaseDate ?? '9') });
  }
  items.sort((a, b) => a.sort.localeCompare(b.sort));

  // 2) bangery — wysoko oceniane, grane w ciągu 2 tygodni
  const bangers = [];
  for (const film of data.repertoire.films) {
    if (film.lbWatchedBy?.length || film.lbWatchlistedBy?.length) continue;
    const v = film.tmdb?.voteAverage ?? 0;
    if (v < BANGER_TMDB || (film.tmdb?.voteCount ?? 0) < BANGER_VOTES) continue;
    if (!futureShowings(film, horizon).length) continue;

    const reasons = [`wysokie oceny widzów (TMDB ${v})`];
    if (film.status === 'premiere') reasons.push('premiera tygodnia');
    if (film.status === 'retro') reasons.push('kinowa powtórka klasyki');
    const big = film.formats.filter((x) => ['imax', '4dx', 'screenx'].includes(x));
    if (big.length) reasons.push(`grany w ${big.map(fmtLabel).join(' i ')}`);

    bangers.push({ film, group: 'banger', why: capitalize(reasons.join(', ')) + '.', when: nextShowingTxt(film), v });
  }
  bangers.sort((a, b) => b.v - a.v);

  return [...items, ...bangers];
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ── render ─────────────────────────────────────────────────────── */
function render() {
  const list = $('reco-list');
  list.replaceChildren();
  const items = buildItems();

  const wlCount = items.filter((i) => i.group === 'watchlista').length;
  $('reco-note').textContent = items.length
    ? `${wlCount ? `${wlCount} z watchlist` : 'Nic z watchlist nie gra'}${items.length - wlCount ? ` + ${items.length - wlCount} dobrze ocenianych z repertuaru` : ''} — w Twoich kinach.`
    : 'Nic ciekawego nie gra — zajrzyj do pełnego repertuaru niżej albo do kalendarza premier.';

  items.forEach((it, i) => {
    const film = it.film;
    const card = el('article', 'reco-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Szczegóły filmu ${film.title}`);

    card.append(el('span', 'reco-rank', String(i + 1)));

    const thumb = el('div', 'reco-thumb');
    const src = film.poster ?? film.tmdb?.poster;
    if (src) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = src;
      thumb.append(img);
    } else {
      thumb.append(el('div', 'poster-fallback', '🎞'));
    }
    card.append(thumb);

    const bodyEl = el('div', 'reco-body');
    const titleRow = el('div', 'reco-title-row');
    titleRow.append(el('h3', 'reco-title', film.title));
    const st = STATUS_INFO[film.status];
    if (st) titleRow.append(el('span', `badge-inline ${st.cls}`, st.label));
    if (film.lbWatchlisted) titleRow.append(el('span', 'badge-inline badge-wl', '☆ watchlista'));
    bodyEl.append(titleRow);

    const metaBits = [];
    if (film.year) metaBits.push(film.year);
    if (film.length) metaBits.push(`${film.length} min`);
    if (film.genres.length) metaBits.push(film.genres.slice(0, 3).map(genreLabel).join(', '));
    if (film.tmdb?.voteAverage) metaBits.push(`★ ${film.tmdb.voteAverage.toFixed(1)} TMDB`);
    if (metaBits.length) bodyEl.append(el('p', 'reco-meta', metaBits.join(' · ')));

    if (it.why) bodyEl.append(el('p', 'reco-why', it.why));
    if (it.when) bodyEl.append(el('p', 'reco-when', it.when));
    card.append(bodyEl);

    const open = () => openFilmDialog(film);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    list.append(card);
  });
}
