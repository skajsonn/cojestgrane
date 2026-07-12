// Sekcja „Warto iść”:
//  1) WSZYSTKIE nieobejrzane filmy z watchlist aktywnych kont (bez limitu,
//     także przedsprzedaż) — deterministycznie,
//  2) potem „rekonesans” — z kluczem Gemini: AI wybiera filmy pod gusty
//     paczki (na bazie ocen i recenzji z Letterboxd, raz dziennie, cache);
//     bez klucza: najlepiej oceniane na Letterboxd filmy z repertuaru.

import { el, todayIso, dateInfo, isPastShowing, normalizeTitle } from './utils.js';
import { fmtLabel, genreLabel, STATUS_INFO } from './labels.js';
import { openFilmDialog } from './ui.js';
import { generate, hasApiKey } from './gemini.js';

const BANGER_LB = 3.5;      // próg średniej Letterboxd (0.5–5)
const BANGER_VOTES = 1000;  // minimalna liczba ocen
const BANGER_WINDOW = 14;   // banger musi grać w ciągu 2 tygodni
const KEY_AI_CACHE = 'kk_reco_ai';
const MAX_AI = 6;

let data = null;
const $ = (id) => document.getElementById(id);

export function initReco(loadedData) {
  data = loadedData;
  render();
  maybeRunAi();
}

export function refresh(loadedData) {
  data = loadedData;
  render();
  maybeRunAi();
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

function lbStars(film) {
  return film.lbRating ? `${film.lbRating.toFixed(2)}★` : null;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/* ── blok 1: watchlisty ─────────────────────────────────────────── */
function watchlistItems() {
  const today = todayIso();
  const multi = data.merged.accounts.length > 1;
  const items = [];

  for (const film of data.repertoire.films) {
    if (!film.lbWatchlistedBy?.length) continue;
    if (!Object.keys(film.showings).some((cid) => data.cinemaSet.has(cid))) continue;

    const who = multi ? ` ${film.lbWatchlistedBy.map((e) => '@' + e.user).join(', ')}` : '';
    const reasons = [`na watchliście${who}`];
    if (film.status === 'premiere') reasons.push('premiera tygodnia');
    if (film.status === 'retro') reasons.push('kinowa powtórka');
    const stars = lbStars(film);
    if (stars && film.lbRating >= 3.2) reasons.push(`${stars} na Letterboxd`);
    for (const w of film.lbWatchedBy ?? []) {
      reasons.push(`@${w.user} już widział${w.rating10 ? ` (${w.rating10}/10)` : ''}`);
    }

    const next = nextShowingTxt(film);
    const when = next ||
      (film.releaseDate && film.releaseDate > today
        ? `premiera ${film.releaseDate.slice(8, 10)}.${film.releaseDate.slice(5, 7)} — bilety w przedsprzedaży`
        : '');
    items.push({ film, why: capitalize(reasons.join(', ')) + '.', when, sort: next ? '0' + next : '1' + (film.releaseDate ?? '9') });
  }
  return items.sort((a, b) => a.sort.localeCompare(b.sort));
}

/* ── blok 2a: fallback — najlepiej oceniani na Letterboxd ───────── */
function bangerItems() {
  const horizon = addDaysIso(todayIso(), BANGER_WINDOW);
  const out = [];
  for (const film of data.repertoire.films) {
    if (film.lbWatchedBy?.length || film.lbWatchlistedBy?.length) continue;
    if ((film.lbRating ?? 0) < BANGER_LB || (film.lbRatingCount ?? 0) < BANGER_VOTES) continue;
    if (!futureShowings(film, horizon).length) continue;

    const reasons = [`${lbStars(film)} na Letterboxd (${Math.round(film.lbRatingCount / 1000)}k ocen)`];
    if (film.status === 'premiere') reasons.push('premiera tygodnia');
    if (film.status === 'retro') reasons.push('kinowa powtórka klasyki');
    const big = film.formats.filter((x) => ['imax', '4dx', 'screenx'].includes(x));
    if (big.length) reasons.push(`grany w ${big.map(fmtLabel).join(' i ')}`);
    out.push({ film, why: capitalize(reasons.join(', ')) + '.', when: nextShowingTxt(film), v: film.lbRating });
  }
  return out.sort((a, b) => b.v - a.v);
}

/* ── blok 2b: rekonesans AI ─────────────────────────────────────── */
function aiCacheKey() {
  return [
    data.repertoire.generatedAt,
    data.merged.accounts.join('+') || '-',
    [...data.cinemaSet].sort().join('+'),
  ].join('|');
}

function readAiCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY_AI_CACHE) ?? 'null');
    return c && c.key === aiCacheKey() && Array.isArray(c.items) ? c.items : null;
  } catch { return null; }
}

let aiInFlight = false;
const KEY_AI_BACKOFF = 'kk_reco_ai_backoff';

async function maybeRunAi() {
  if (!hasApiKey() || readAiCache() || aiInFlight) return;
  if (Number(localStorage.getItem(KEY_AI_BACKOFF) ?? 0) > Date.now()) return; // szanujemy limity
  aiInFlight = true;
  try {
    const raw = await generate({ system: buildContext(), user: buildPrompt() });
    const items = sanitizeAi(JSON.parse(raw));
    if (items.length) {
      localStorage.setItem(KEY_AI_CACHE, JSON.stringify({ key: aiCacheKey(), ts: Date.now(), items }));
      render();
    } else {
      console.warn('[reco-ai] sanityzacja odrzuciła wszystko; raw:', raw.slice(0, 400));
    }
  } catch (err) {
    console.warn('[reco-ai] rekonesans nieudany:', err.message);
    if (err.status === 429 || /quota/i.test(err.message)) {
      // dzienny limit — nie ponawiamy przy każdym przeładowaniu strony
      localStorage.setItem(KEY_AI_BACKOFF, String(Date.now() + 3 * 3600e3));
    }
  } finally {
    aiInFlight = false;
  }
}

function buildContext() {
  const today = todayIso();
  const m = data.merged;
  const multi = m.accounts.length > 1;

  const filmLines = data.repertoire.films
    .filter((f) => Object.keys(f.showings).some((cid) => data.cinemaSet.has(cid)))
    .map((f) => [
      `• ${f.title}${f.originalTitle ? ` (oryg. „${f.originalTitle}”)` : ''} (${f.year})`,
      f.genres.map(genreLabel).join('/'),
      f.length ? `${f.length} min` : null,
      f.lbRating ? `Letterboxd ${f.lbRating} (${f.lbRatingCount} ocen)` : null,
      f.status === 'upcoming' ? 'przedpremiera' : null,
      f.lbWatchedBy?.length ? `OBEJRZANE przez ${f.lbWatchedBy.map((e) => `@${e.user}${e.rating10 ? ` ${e.rating10}/10` : ''}`).join(', ')}` : null,
      f.lbWatchlistedBy?.length ? `NA WATCHLIŚCIE ${f.lbWatchlistedBy.map((e) => '@' + e.user).join(', ')}` : null,
      f.tmdb?.overview ? `Opis: ${f.tmdb.overview.slice(0, 180)}` : null,
    ].filter(Boolean).join(' | '))
    .join('\n');

  const tastes = m.accounts.map((user) => {
    const mine = m.watched.filter((w) => w.user === user && w.rating10 != null);
    const fav = mine.filter((w) => w.rating10 >= 8).slice(0, 60).map((w) => `${w.title} ${w.rating10}/10`);
    const meh = mine.filter((w) => w.rating10 <= 4).slice(0, 20).map((w) => `${w.title} ${w.rating10}/10`);
    const reviews = m.recent.filter((r) => r.user === user && r.review).slice(0, 5)
      .map((r) => `„${r.review.slice(0, 200)}” (${r.title})`);
    return `GUST @${user}:\nlubi: ${fav.join('; ') || 'brak danych'}\nnie podeszło: ${meh.join('; ') || 'brak danych'}${reviews.length ? `\nrecenzje: ${reviews.join(' | ')}` : ''}`;
  }).join('\n\n');

  return `Jesteś doradcą filmowym serwisu „Co jest grane?”. Dziś jest ${today}.
Analizujesz repertuar kin (${data.cinemas.map((c) => c.name).join(', ')}) i gusty ${multi ? 'paczki znajomych' : 'użytkownika'} z Letterboxd.

REPERTUAR:
${filmLines}

${tastes}`;
}

function buildPrompt() {
  return `Zrób rekonesans repertuaru: wybierz od 3 do ${MAX_AI} filmów, które NIE są na żadnej watchliście i NIE zostały przez nikogo obejrzane, a najbardziej pasują do powyższych gustów — ciekawe, warte kina, także mniej oczywiste odkrycia. ` +
    `KRYTERIA JAKOŚCI: nie polecaj filmów słabo przyjętych — jeśli film ma średnią Letterboxd poniżej 3.2 albo ledwie garść ocen i nic go nie broni, pomiń go. Lepiej zwrócić 3 mocne propozycje niż dopychać słabe. ` +
    `Pomiń przedpremiery bez seansów. Zwróć WYŁĄCZNIE tablicę JSON: ` +
    `[{"title": dokładny tytuł z repertuaru, "why": 2–3 zdania po polsku, dlaczego ten film do nich pasuje — odwołaj się do konkretnych ocen/recenzji/upodobań}]. Bez markdownu.`;
}

function sanitizeAi(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((it) => it && typeof it.title === 'string')
    .map((it) => ({ title: it.title.slice(0, 120), why: typeof it.why === 'string' ? it.why.slice(0, 500) : '' }))
    .map((it) => ({ ...it, film: findFilm(it.title) }))
    .filter((it) => it.film && !it.film.lbWatchedBy?.length && !it.film.lbWatchlistedBy?.length)
    // twarda podłoga jakości: znany film ze słabą średnią odpada, nawet gdy AI go przemyci
    .filter((it) => {
      const r = it.film.lbRating;
      const n = it.film.lbRatingCount ?? 0;
      if (r != null && r < 3.2 && n >= 300) return false;
      return true;
    })
    .slice(0, MAX_AI);
}

function findFilm(title) {
  const norm = normalizeTitle(title);
  return data.repertoire.films.find(
    (f) => normalizeTitle(f.title) === norm ||
           (f.originalTitle && normalizeTitle(f.originalTitle) === norm),
  ) ?? null;
}

/* ── render ─────────────────────────────────────────────────────── */
function render() {
  const list = $('reco-list');
  list.replaceChildren();

  const wl = watchlistItems();
  const aiCached = readAiCache();
  const ai = aiCached
    ? aiCached.map((it) => ({ ...it, film: findFilm(it.title) }))
        .filter((it) => it.film)
        .map((it) => ({ film: it.film, why: it.why, when: nextShowingTxt(it.film) }))
    : null;
  const second = ai ?? bangerItems();

  $('reco-note').textContent = [
    wl.length ? `${wl.length} z watchlist` : 'nic z watchlist nie gra',
    second.length
      ? (ai ? `✨ ${second.length} od AI wg Waszych gustów` : `${second.length} najlepiej ocenianych na Letterboxd`)
      : null,
  ].filter(Boolean).join(' + ') + ' — w Twoich kinach.';

  [...wl, ...second].forEach((it, i) => list.append(recoCard(it, i)));
  if (!wl.length && !second.length) {
    $('reco-note').textContent = 'Nic ciekawego nie gra — zajrzyj do pełnego repertuaru niżej albo do kalendarza premier.';
  }
}

function recoCard(it, i) {
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
  if (film.lbRating) metaBits.push(`★ ${film.lbRating.toFixed(2)} Letterboxd`);
  if (metaBits.length) bodyEl.append(el('p', 'reco-meta', metaBits.join(' · ')));

  if (it.why) bodyEl.append(el('p', 'reco-why', it.why));
  if (it.when) bodyEl.append(el('p', 'reco-when', it.when));
  card.append(bodyEl);

  const open = () => openFilmDialog(film);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}
