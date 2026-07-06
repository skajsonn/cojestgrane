// Zakładka „Premiery” — oś czasu nadchodzących premier kinowych
// (filmy z repertuaru, których data premiery dopiero nadejdzie albo
// właśnie przypada). Filtr „śmietanka”: watchlista + dobrze oceniane.

import { el, dateInfo, todayIso } from './utils.js';
import { fmtLabel, genreLabel } from './labels.js';
import { openFilmDialog } from './ui.js';

const CREAM_TMDB = 6.8; // próg „dobrych ocen” dla śmietanki

let data = null;
const $ = (id) => document.getElementById(id);

export function initPremieres(loadedData) {
  data = loadedData;
  $('prem-cream').addEventListener('input', render);
  render();
}

export function refresh(loadedData) {
  data = loadedData;
  render();
}

function upcoming() {
  const today = todayIso();
  return data.repertoire.films
    .filter((f) => f.releaseDate && f.releaseDate >= today)
    .filter((f) => Object.keys(f.showings).some((cid) => data.cinemaSet.has(cid)))
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.title.localeCompare(b.title, 'pl'));
}

function isCream(f) {
  return f.lbWatchlisted || f.lbWatched || (f.tmdb?.voteAverage ?? 0) >= CREAM_TMDB;
}

function render() {
  const cream = $('prem-cream').checked;
  const timeline = $('prem-timeline');
  timeline.replaceChildren();

  let films = upcoming();
  const total = films.length;
  if (cream) films = films.filter(isCream);

  $('prem-summary').textContent = total
    ? `${films.length} z ${total} nadchodzących premier w Twoich kinach (bilety w przedsprzedaży)`
    : '';
  $('prem-empty').hidden = films.length > 0;

  const today = todayIso();
  const byDate = new Map();
  for (const f of films) {
    if (!byDate.has(f.releaseDate)) byDate.set(f.releaseDate, []);
    byDate.get(f.releaseDate).push(f);
  }

  for (const [date, group] of byDate) {
    const day = el('div', 'prem-day');
    const di = dateInfo(date, today);
    const days = Math.round((new Date(date + 'T12:00') - new Date(today + 'T12:00')) / 86400000);
    const rel = days === 0 ? 'dziś!' : days === 1 ? 'jutro' : `za ${days} dni`;
    const h = el('h3', 'prem-date', `${di.dowFull} ${di.dayMonth}`);
    h.append(el('span', 'pd-rel', rel));
    day.append(h);

    const list = el('div', 'prem-films');
    for (const film of group) list.append(premFilm(film));
    day.append(list);
    timeline.append(day);
  }
}

function premFilm(film) {
  const row = el('article', 'prem-film');
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', `Szczegóły filmu ${film.title}`);

  const thumb = el('div', 'prem-thumb');
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
  row.append(thumb);

  const info = el('div', 'prem-info');
  const title = el('h4', 'prem-title', film.title);
  if (film.lbWatchlisted) title.append(el('span', 'badge-inline badge-wl', '☆ watchlista'));
  if (film.tmdb?.voteAverage >= CREAM_TMDB) {
    title.append(el('span', 'badge-inline badge-premiere', `★ ${film.tmdb.voteAverage.toFixed(1)}`));
  }
  info.append(title);

  const subBits = [];
  if (film.originalTitle) subBits.push(film.originalTitle);
  if (film.genres.length) subBits.push(film.genres.slice(0, 3).map(genreLabel).join(', '));
  const fx = film.formats.filter((x) => x !== '2d').map(fmtLabel);
  if (fx.length) subBits.push(fx.join(' · '));
  const cinemas = data.cinemas.filter((c) => film.showings[c.id]).map((c) => c.short);
  if (cinemas.length) subBits.push(`przedsprzedaż: ${cinemas.join(', ')}`);
  info.append(el('p', 'prem-sub', subBits.join('  ·  ')));
  row.append(info);

  const open = () => openFilmDialog(film);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}
