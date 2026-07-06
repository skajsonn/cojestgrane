// Warstwa danych: ładuje wygenerowane JSON-y, waliduje ich kształt,
// wybiera aktywne konto Letterboxd (localStorage) i dopasowuje repertuar
// do profilu (obejrzane / watchlista) — najpierw po slugu Letterboxd,
// w razie braku po znormalizowanym tytule.

import { normalizeTitle } from './utils.js';

const KEY_LB_USER = 'kk_lb_user';
const USER_RE = /^[a-zA-Z0-9_]{2,30}$/; // nick trafia do URL-a pliku danych

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nie mogę wczytać ${path} (HTTP ${res.status})`);
  return res.json();
}

function assertRepertoire(rep) {
  if (!rep || !Array.isArray(rep.films) || !Array.isArray(rep.cinemas)) {
    throw new Error('Uszkodzony plik repertoire.json');
  }
}

export function getSavedAccount() {
  const u = localStorage.getItem(KEY_LB_USER);
  return u && USER_RE.test(u) ? u : null;
}

export function saveAccount(user) {
  if (USER_RE.test(user)) localStorage.setItem(KEY_LB_USER, user);
}

/* ── dopasowanie repertuar ↔ Letterboxd ─────────────────────────── */
function buildTitleIndex(list) {
  const index = new Map();
  for (const entry of list ?? []) {
    const key = entry.norm ?? normalizeTitle(entry.title);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  return index;
}

function matchByTitle(film, index) {
  const keys = new Set();
  if (film.originalTitle) keys.add(normalizeTitle(film.originalTitle));
  if (film.tmdb?.originalTitle) keys.add(normalizeTitle(film.tmdb.originalTitle));
  if (film.tmdb?.title) keys.add(normalizeTitle(film.tmdb.title));
  keys.add(normalizeTitle(film.title));

  const ccYear = parseInt(film.year, 10) || null;
  for (const key of keys) {
    for (const entry of index.get(key) ?? []) {
      if (!ccYear || !entry.year || Math.abs(ccYear - entry.year) <= 1) return entry;
    }
  }
  return null;
}

function annotate(repertoire, letterboxd) {
  const bySlugWatched = new Map((letterboxd?.watched ?? []).map((w) => [w.slug, w]));
  const slugsWatchlist = new Set((letterboxd?.watchlist ?? []).map((w) => w.slug));
  const watchedIdx = buildTitleIndex(letterboxd?.watched);
  const watchlistIdx = buildTitleIndex(letterboxd?.watchlist);

  for (const film of repertoire.films) {
    film.lbWatched = (film.lbSlug && bySlugWatched.get(film.lbSlug)) || matchByTitle(film, watchedIdx) || null;
    film.lbWatchlisted = !film.lbWatched &&
      ((film.lbSlug && slugsWatchlist.has(film.lbSlug)) || !!matchByTitle(film, watchlistIdx));
  }
}

/* ── ładowanie ──────────────────────────────────────────────────── */
export async function loadAll() {
  const [repertoire, lbIndex] = await Promise.all([
    loadJson('data/repertoire.json'),
    loadJson('data/letterboxd/index.json').catch(() => null), // może jeszcze nie istnieć
  ]);
  assertRepertoire(repertoire);

  const users = (lbIndex?.users ?? [])
    .map((u) => u.user)
    .filter((u) => USER_RE.test(u));

  const saved = getSavedAccount();
  const account = saved && users.includes(saved) ? saved : users[0] ?? null;
  const letterboxd = account
    ? await loadJson(`data/letterboxd/${account}.json`).catch(() => null)
    : null;

  annotate(repertoire, letterboxd);

  // Posortowane daty seansów w całym repertuarze (do paska dat).
  const allDates = new Set();
  for (const film of repertoire.films) {
    for (const byDate of Object.values(film.showings)) {
      for (const date of Object.keys(byDate)) allDates.add(date);
    }
  }

  return {
    repertoire,
    letterboxd,
    users,
    account,
    needsAccountChoice: users.length > 0 && !saved,
    dates: [...allDates].sort(),
  };
}

/** Seanse danego filmu w danym dniu, pogrupowane po kinie. */
export function showingsForDay(film, date, cinemaFilter) {
  const out = [];
  for (const [cinemaId, byDate] of Object.entries(film.showings)) {
    if (cinemaFilter && cinemaId !== cinemaFilter) continue;
    const shows = byDate[date];
    if (shows?.length) out.push({ cinemaId, shows });
  }
  return out;
}

export function filmHasFormat(film, format) {
  return !format || film.formats.includes(format);
}
