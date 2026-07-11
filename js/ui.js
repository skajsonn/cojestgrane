// Renderowanie widoku repertuaru: pasek dat, filtry, karty, szczegóły filmu.
// Wszystko liczone wyłącznie dla preferowanych kin (data.cinemas / data.cinemaSet).
// Zasada: dane z JSON-ów nigdy nie trafiają do innerHTML — tylko textContent.

import { el, dateInfo, todayIso, normalizeTitle, isPastShowing } from './utils.js';
import { fmtLabel, genreLabel, langLabel, STATUS_INFO } from './labels.js';
import { showingsForDay, filmHasFormat } from './data.js';

const state = {
  data: null,
  day: null,
  cinema: '',
  format: '',
  status: '',
  onlyWatchlist: false,
  hideWatched: false,
  search: '',
};

const $ = (id) => document.getElementById(id);

export function initRepertoire(data) {
  state.data = data;
  const today = todayIso();
  state.day = data.dates.find((d) => d >= today) ?? data.dates[0];

  $('brand-tag').textContent = data.cinemas.map((c) => c.name).join(' · ') || 'Cinema City';

  renderDatestrip();
  initFilters();
  renderGrid();
  renderFooter();
}

/** Odświeżenie po dosynchronizowaniu profili (bez przeładowania strony). */
export function rerenderGrid() {
  renderGrid();
  renderFooter();
}

/* ── pasek dat ──────────────────────────────────────────────────── */
function renderDatestrip() {
  const strip = $('datestrip');
  strip.replaceChildren();
  const today = todayIso();
  for (const iso of state.data.dates) {
    if (iso < today) continue;
    const info = dateInfo(iso, today);
    const chip = el('button', 'date-chip' + (iso === state.day ? ' is-active' : ''));
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.append(el('span', 'dc-dow', info.label), el('span', 'dc-day', info.dayMonth));
    chip.addEventListener('click', () => {
      state.day = iso;
      renderDatestrip();
      renderGrid();
    });
    strip.append(chip);
  }
}

/* ── filtry ─────────────────────────────────────────────────────── */
function initFilters() {
  const cinemaSel = $('f-cinema');
  // opcje kin = tylko preferowane
  while (cinemaSel.options.length > 1) cinemaSel.remove(1);
  for (const c of state.data.cinemas) {
    const opt = el('option', null, c.name);
    opt.value = c.id;
    cinemaSel.append(opt);
  }

  const formats = new Set();
  for (const f of state.data.repertoire.films) for (const fm of f.formats) if (fm !== '2d') formats.add(fm);
  const formatSel = $('f-format');
  while (formatSel.options.length > 1) formatSel.remove(1);
  for (const fm of [...formats].sort()) {
    const opt = el('option', null, fmtLabel(fm));
    opt.value = fm;
    formatSel.append(opt);
  }

  const bind = (id, key, prop = 'value') => {
    $(id).addEventListener('input', (e) => {
      state[key] = prop === 'checked' ? e.target.checked : e.target.value;
      renderGrid();
    });
  };
  bind('f-cinema', 'cinema');
  bind('f-format', 'format');
  bind('f-status', 'status');
  bind('f-watchlist', 'onlyWatchlist', 'checked');
  bind('f-hide-watched', 'hideWatched', 'checked');
  bind('f-search', 'search');
}

function visibleFilms() {
  const q = normalizeTitle(state.search);
  return state.data.repertoire.films.filter((film) => {
    if (state.status && film.status !== state.status) return false;
    if (state.onlyWatchlist && !film.lbWatchlistedBy?.length) return false;
    // „ukryj obejrzane”: nie chowamy filmu, który ktoś z paczki wciąż chce zobaczyć
    if (state.hideWatched && film.lbWatchedBy?.length && !film.lbWatchlistedBy?.length) return false;
    if (!filmHasFormat(film, state.format)) return false;
    if (q && !normalizeTitle(film.title).includes(q) &&
        !(film.originalTitle && normalizeTitle(film.originalTitle).includes(q))) return false;
    return showingsForDay(film, state.day, state.cinema, state.data.cinemaSet).length > 0;
  });
}

/* ── siatka kart ────────────────────────────────────────────────── */
function renderGrid() {
  const grid = $('film-grid');
  grid.replaceChildren();
  const films = visibleFilms();

  const info = dateInfo(state.day, todayIso());
  const toTue = daysToTuesday();
  const tueTxt = toTue === 0 ? 'dziś' : toTue === 1 ? 'jutro' : `za ${toTue} dni`;
  $('grid-summary').textContent =
    `${films.length} ${plural(films.length, 'film', 'filmy', 'filmów')} • ${info.dowFull} ${info.dayMonth}` +
    ` • nowy tydzień sprzedaży CC zwykle we wtorek (${tueTxt})`;
  $('empty-note').hidden = films.length > 0;

  for (const film of films) grid.append(filmCard(film));
}

function daysDiff(isoA, isoB) {
  return Math.round((new Date(isoB + 'T12:00') - new Date(isoA + 'T12:00')) / 86400000);
}

/** Dni do najbliższego wtorku — wtedy CC zwykle otwiera nowy tydzień sprzedaży. */
function daysToTuesday() {
  const dow = new Date(todayIso() + 'T12:00').getDay(); // 0=nd … 2=wt
  return (2 - dow + 7) % 7;
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return few;
  return many;
}

export function posterEl(film) {
  const wrap = el('div', 'poster-wrap');
  const src = film.poster ?? film.tmdb?.poster;
  if (src) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = `Plakat: ${film.title}`;
    img.src = src;
    img.addEventListener('error', () => {
      img.remove();
      wrap.prepend(el('div', 'poster-fallback', '🎞'));
    });
    wrap.append(img);
  } else {
    wrap.append(el('div', 'poster-fallback', '🎞'));
  }
  return wrap;
}

function badgeEls(film) {
  const nodes = [];
  const st = STATUS_INFO[film.status];
  if (st) nodes.push(el('span', `badge ${st.cls}`, st.label));

  const multi = state.data.merged.accounts.length > 1;
  const marks = el('div', 'user-marks');
  // bilety weszły do sprzedaży w ciągu ostatniej doby
  const today = todayIso();
  if (film.firstSeen && daysDiff(film.firstSeen, today) <= 1 && film.status !== 'premiere') {
    marks.append(el('span', 'mark mark-fresh', '🆕 nowe bilety'));
  }
  if (film.lbWatched) {
    const who = multi ? `@${film.lbWatched.user}` : 'obejrzane';
    const rating = film.lbWatched.rating10 ? ` ${film.lbWatched.rating10}/10` : '';
    const mark = el('span', 'mark mark-watched', `✓ ${who}${rating}`);
    mark.title = film.lbWatchedBy.map((e) => `@${e.user}${e.rating10 ? ` ${e.rating10}/10` : ''}`).join(', ');
    marks.append(mark);
  }
  if (film.lbWatchlisted) {
    const mark = el('span', 'mark mark-watchlist',
      multi ? `☆ @${film.lbWatchlisted.user}${film.lbWatchlistedBy.length > 1 ? ` +${film.lbWatchlistedBy.length - 1}` : ''}` : '☆ watchlista');
    mark.title = 'Na watchliście: ' + film.lbWatchlistedBy.map((e) => '@' + e.user).join(', ');
    marks.append(mark);
  }
  if (marks.childElementCount) nodes.push(marks);
  return nodes;
}

function filmCard(film) {
  const card = el('article', 'film-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `Szczegóły filmu ${film.title}`);

  const poster = posterEl(film);
  poster.append(...badgeEls(film));
  card.append(poster);

  const body = el('div', 'card-body');
  body.append(el('h3', 'card-title', film.title));

  const metaBits = [];
  if (film.year) metaBits.push(film.year);
  if (film.length) metaBits.push(`${film.length} min`);
  if (film.genres.length) metaBits.push(film.genres.slice(0, 3).map(genreLabel).join(', '));
  body.append(el('p', 'card-meta', metaBits.join(' · ')));

  const specials = film.formats.filter((f) => f !== '2d');
  if (specials.length) {
    const chips = el('div', 'fmt-chips');
    for (const f of specials) chips.append(el('span', `fmt-chip fmt-${f}`, fmtLabel(f)));
    body.append(chips);
  }

  const times = el('div', 'card-times');
  for (const { cinemaId, shows } of showingsForDay(film, state.day, state.cinema, state.data.cinemaSet)) {
    const row = el('div', 'times-cinema');
    const cinema = state.data.cinemas.find((c) => c.id === cinemaId);
    row.append(el('span', 'tc-name', cinema?.short ?? cinemaId));
    for (const s of shows.slice(0, 7)) {
      const past = isPastShowing(state.day, s.time);
      const pill = el('span',
        'time-pill' + (s.formats.length ? ' is-format' : '') + (s.soldOut ? ' is-soldout' : '') + (past ? ' is-past' : ''),
        s.time);
      const extra = [...s.formats.map(fmtLabel), langLabel(s.lang)].filter(Boolean).join(', ');
      pill.title = past ? 'Seans już się rozpoczął' : extra;
      row.append(pill);
    }
    if (shows.length > 7) row.append(el('span', 'no-times', `+${shows.length - 7}`));
    times.append(row);
  }
  body.append(times);
  card.append(body);

  const open = () => openFilmDialog(film);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

/* ── szczegóły filmu (pełny harmonogram) ───────────────────────── */
export function openFilmDialog(film) {
  const dialog = $('film-dialog');
  const body = $('film-dialog-body');
  body.replaceChildren();

  const close = el('button', 'dialog-close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', 'Zamknij');
  close.addEventListener('click', () => dialog.close());
  body.append(close);

  const hero = el('div', 'film-hero');
  const posterCol = posterEl(film);
  posterCol.append(...badgeEls(film));
  hero.append(posterCol);

  const info = el('div');
  info.append(el('h2', null, film.title));
  if (film.originalTitle) info.append(el('p', 'orig-title', film.originalTitle));

  const meta = el('div', 'hero-meta');
  if (film.year) meta.append(el('span', null, film.year));
  if (film.length) meta.append(el('span', null, `${film.length} min`));
  if (film.genres.length) meta.append(el('span', null, film.genres.map(genreLabel).join(' · ')));
  if (film.lbRating) {
    const score = el('span', 'tmdb-score', `★ ${film.lbRating.toFixed(2)} Letterboxd`);
    score.title = `Średnia społeczności Letterboxd (${film.lbRatingCount.toLocaleString('pl-PL')} ocen)`;
    meta.append(score);
  }
  info.append(meta);

  if (film.releaseDate) info.append(el('p', 'card-meta', `Premiera: ${film.releaseDate}`));
  if (film.tmdb?.overview) info.append(el('p', 'overview', film.tmdb.overview));
  if (film.lbWatched?.rating10) {
    info.append(el('p', 'card-meta',
      `Ocena na Letterboxd (@${film.lbWatched.user}): ${film.lbWatched.rating10}/10`));
  }

  const links = el('div', 'hero-links');
  if (film.trailer) links.append(extLink(film.trailer, 'Zwiastun', 'btn btn-ghost'));
  if (film.link) links.append(extLink(film.link, 'Strona Cinema City', 'btn btn-ghost'));
  info.append(links);
  hero.append(info);
  body.append(hero);

  // Pełny harmonogram: preferowane kina → każda data → godziny.
  const sched = el('div', 'schedule');
  const today = todayIso();
  for (const cinema of state.data.cinemas) {
    const byDate = film.showings[cinema.id];
    if (!byDate) continue;
    sched.append(el('h3', null, `Cinema City ${cinema.name}`));
    for (const date of Object.keys(byDate).sort()) {
      if (date < today) continue;
      const day = el('div', 'sched-day');
      const di = dateInfo(date, today);
      const dateCol = el('div', 'sched-date');
      if (di.isToday) dateCol.append(el('span', 'sd-today', 'dziś, '));
      dateCol.append(document.createTextNode(`${di.dowFull} ${di.dayMonth}`));
      day.append(dateCol);

      const timesCol = el('div', 'sched-times');
      for (const s of byDate[date]) {
        const label = [...s.formats.map(fmtLabel), langLabel(s.lang)].filter(Boolean).join(' · ');
        const past = isPastShowing(date, s.time);
        let pill;
        if (s.booking && !s.soldOut && !past) {
          // Deep-link quickbook na stronę filmu w cinema-city.pl (z datą
          // i kinem) — kupujesz w swojej zalogowanej sesji (karta Unlimited).
          const target = film.link
            ? `${film.link}#/buy-tickets-by-film?in-cinema=${encodeURIComponent(cinema.id)}&at=${date}&for-movie=${encodeURIComponent(film.id)}&view-mode=list`
            : s.booking;
          pill = extLink(target, s.time, 'time-pill' + (s.formats.length ? ' is-format' : ''));
          pill.title = `Kup bilet na cinema-city.pl (Twoje konto/Unlimited)${label ? ` — ${label}` : ''}`;
        } else {
          pill = el('span', 'time-pill' + (s.soldOut ? ' is-soldout' : '') + (past ? ' is-past' : ''), s.time);
          if (past) pill.title = 'Seans już się rozpoczął';
          else if (s.soldOut) pill.title = 'Wyprzedane';
        }
        if (label) pill.append(el('span', 'pill-sub', label));
        timesCol.append(pill);
      }
      day.append(timesCol);
      sched.append(day);
    }
  }
  body.append(sched);

  dialog.showModal();
}

function extLink(href, text, cls) {
  const a = el('a', cls, text);
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:') throw new Error('tylko https');
    a.href = u.toString();
  } catch {
    a.href = '#';
  }
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/* ── stopka ─────────────────────────────────────────────────────── */
function renderFooter() {
  const rep = state.data.repertoire;
  const m = state.data.merged;
  const parts = [`Repertuar zaktualizowany: ${new Date(rep.generatedAt).toLocaleString('pl-PL')}`];
  if (m.accounts.length) {
    parts.push(`Letterboxd (${m.accounts.map((u) => '@' + u).join(', ')}): ` +
      `${m.counts.watched} obejrzanych, ${m.counts.watchlist} na watchliście`);
    // uczciwe ostrzeżenie, gdy profile są nieświeże (np. scraping blokowany)
    const oldest = Math.min(...state.data.profiles.map((p) => Date.parse(p.generatedAt) || 0));
    const hours = (Date.now() - oldest) / 3600e3;
    if (hours > 26) {
      parts.push(`⚠ profile Letterboxd nieodświeżone od ${Math.round(hours)} h`);
    }
  }
  $('footer-meta').textContent = parts.join(' • ');
}
