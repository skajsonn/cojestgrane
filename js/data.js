// Warstwa danych: ładuje wygenerowane JSON-y, zarządza preferencjami
// (wybrane kina, konta Letterboxd) i dopasowuje repertuar do ZŁĄCZONEGO
// profilu z wielu kont — najpierw po slugu Letterboxd, potem po tytule.
//
// Konta Letterboxd pochodzą z dwóch źródeł:
//  - config.json → synchronizowane codziennie przez GitHub Actions (data/letterboxd/…)
//  - dodane w przeglądarce → synchronizowane client-side (letterboxd-client.js)

import { normalizeTitle } from './utils.js';
import { readCache, USER_RE } from './letterboxd-client.js';

const KEY_ONBOARDED = 'kk_onboarded';
const KEY_CINEMAS = 'kk_cinemas';
const KEY_ACCOUNTS = 'kk_lb_accounts'; // konta dodane w przeglądarce
const KEY_ACTIVE = 'kk_lb_active';     // konta aktualnie aktywne (dowolne źródło)

function readLs(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v ?? fallback;
  } catch { return fallback; }
}

async function loadJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Nie mogę wczytać ${path} (HTTP ${res.status})`);
  return res.json();
}

/* ── preferencje ────────────────────────────────────────────────── */
export function isOnboarded() { return localStorage.getItem(KEY_ONBOARDED) === '1'; }
export function setOnboarded() { localStorage.setItem(KEY_ONBOARDED, '1'); }

export function getCinemaPrefs(allIds) {
  const stored = readLs(KEY_CINEMAS, null);
  const valid = Array.isArray(stored) ? stored.filter((id) => allIds.includes(id)) : [];
  return valid.length ? valid : allIds;
}
export function saveCinemaPrefs(ids) { localStorage.setItem(KEY_CINEMAS, JSON.stringify(ids)); }

export function getBrowserAccounts() {
  return (readLs(KEY_ACCOUNTS, []) || []).filter((u) => USER_RE.test(u));
}
export function addBrowserAccount(user) {
  const list = getBrowserAccounts();
  if (!list.includes(user)) list.push(user);
  localStorage.setItem(KEY_ACCOUNTS, JSON.stringify(list));
}
export function removeBrowserAccount(user) {
  localStorage.setItem(KEY_ACCOUNTS, JSON.stringify(getBrowserAccounts().filter((u) => u !== user)));
  localStorage.setItem(KEY_ACTIVE, JSON.stringify(getActiveAccounts().filter((u) => u !== user)));
}

export function getActiveAccounts(known) {
  const stored = readLs(KEY_ACTIVE, null);
  if (Array.isArray(stored)) return known ? stored.filter((u) => known.includes(u)) : stored;
  return known ?? []; // brak wyboru = wszystkie znane
}
export function saveActiveAccounts(users) { localStorage.setItem(KEY_ACTIVE, JSON.stringify(users)); }

/* ── profil złączony z wielu kont ───────────────────────────────── */
function mergeProfiles(profiles) {
  // Wpisy per (konto, film) — kto obejrzał/chce obejrzeć ma znaczenie,
  // więc NIE deduplikujemy między kontami (liczniki liczą unikalne filmy).
  const watched = [];
  const watchlist = [];
  const recent = [];

  for (const p of profiles) {
    for (const f of p.watched ?? []) {
      watched.push({ ...f, user: p.user, norm: f.norm ?? normalizeTitle(f.title) });
    }
    for (const f of p.watchlist ?? []) {
      watchlist.push({ ...f, user: p.user, norm: f.norm ?? normalizeTitle(f.title) });
    }
    for (const r of p.recent ?? []) recent.push({ ...r, user: p.user });
  }

  const groupBySlug = (list) => {
    const map = new Map();
    for (const e of list) {
      if (!map.has(e.slug)) map.set(e.slug, []);
      map.get(e.slug).push(e);
    }
    return map;
  };

  return {
    accounts: profiles.map((p) => p.user),
    counts: {
      watched: new Set(watched.map((w) => w.slug)).size,
      watchlist: new Set(watchlist.map((w) => w.slug)).size,
    },
    watched,
    watchlist,
    recent,
    bySlugWatched: groupBySlug(watched),
    bySlugWatchlist: groupBySlug(watchlist),
  };
}

function buildTitleIndex(list) {
  const index = new Map();
  for (const entry of list) {
    if (!index.has(entry.norm)) index.set(entry.norm, []);
    index.get(entry.norm).push(entry);
  }
  return index;
}

function matchAllByTitle(film, index) {
  const keys = new Set();
  if (film.originalTitle) keys.add(normalizeTitle(film.originalTitle));
  if (film.tmdb?.originalTitle) keys.add(normalizeTitle(film.tmdb.originalTitle));
  if (film.tmdb?.title) keys.add(normalizeTitle(film.tmdb.title));
  keys.add(normalizeTitle(film.title));

  const ccYear = parseInt(film.year, 10) || null;
  const out = [];
  for (const key of keys) {
    for (const entry of index.get(key) ?? []) {
      if (!ccYear || !entry.year || Math.abs(ccYear - entry.year) <= 1) out.push(entry);
    }
  }
  return out;
}

export function annotate(repertoire, merged) {
  const watchedIdx = buildTitleIndex(merged.watched);
  const watchlistIdx = buildTitleIndex(merged.watchlist);

  for (const film of repertoire.films) {
    const collect = (bySlug, idx) => {
      const found = [
        ...(film.lbSlug ? bySlug.get(film.lbSlug) ?? [] : []),
        ...matchAllByTitle(film, idx),
      ];
      // jeden wpis na konto
      const seen = new Set();
      return found.filter((e) => !seen.has(e.user) && seen.add(e.user));
    };

    const watchedBy = collect(merged.bySlugWatched, watchedIdx);
    const watchedUsers = new Set(watchedBy.map((e) => e.user));
    // watchlista danej osoby liczy się, dopóki TA osoba nie obejrzała —
    // to, że ktoś inny z paczki już widział, nie kasuje polecenia
    const watchlistedBy = collect(merged.bySlugWatchlist, watchlistIdx)
      .filter((e) => !watchedUsers.has(e.user));

    film.lbWatchedBy = watchedBy;
    film.lbWatchlistedBy = watchlistedBy;
    film.lbWatched = watchedBy[0] ?? null;
    film.lbWatchlisted = watchlistedBy[0] ?? null;
  }
}

/** Wczytuje profile aktywnych kont (config → plik z repo, browser → cache). */
async function loadProfiles(configUsers, active) {
  const profiles = [];
  for (const user of active) {
    let p = null;
    if (configUsers.includes(user)) {
      p = await loadJson(`data/letterboxd/${encodeURIComponent(user)}.json`).catch(() => null);
    }
    if (!p) p = readCache(user); // konto przeglądarkowe albo fallback
    if (p) profiles.push(p);
  }
  return profiles;
}

/* ── główne ładowanie ───────────────────────────────────────────── */
export async function loadAll() {
  const [repertoire, lbIndex] = await Promise.all([
    loadJson('data/repertoire.json'),
    loadJson('data/letterboxd/index.json').catch(() => null),
  ]);
  if (!repertoire || !Array.isArray(repertoire.films) || !Array.isArray(repertoire.cinemas)) {
    throw new Error('Uszkodzony plik repertoire.json');
  }

  const configUsers = (lbIndex?.users ?? []).map((u) => u.user).filter((u) => USER_RE.test(u));
  const browserUsers = getBrowserAccounts();
  const known = [...new Set([...configUsers, ...browserUsers])];
  const active = getActiveAccounts(known);

  const profiles = await loadProfiles(configUsers, active);
  const merged = mergeProfiles(profiles);
  annotate(repertoire, merged);

  // preferowane kina (obiekty) + szybki zbiór id
  const allIds = repertoire.cinemas.map((c) => c.id);
  const prefIds = getCinemaPrefs(allIds);
  const cinemas = repertoire.cinemas.filter((c) => prefIds.includes(c.id));
  const cinemaSet = new Set(prefIds);

  // daty seansów w preferowanych kinach (do paska dat)
  const allDates = new Set();
  for (const film of repertoire.films) {
    for (const [cid, byDate] of Object.entries(film.showings)) {
      if (!cinemaSet.has(cid)) continue;
      for (const date of Object.keys(byDate)) allDates.add(date);
    }
  }

  return {
    repertoire,
    merged,
    cinemas,        // tylko preferowane (obiekty)
    cinemaSet,      // tylko preferowane (id)
    configUsers,
    browserUsers,
    activeAccounts: active,
    needsOnboarding: !isOnboarded(),
    dates: [...allDates].sort(),
  };
}

/** Przeliczenie profili bez przeładowania strony (po dosynchronizowaniu konta). */
export async function recomputeProfiles(data) {
  const known = [...new Set([...data.configUsers, ...getBrowserAccounts()])];
  const active = getActiveAccounts(known);
  const profiles = await loadProfiles(data.configUsers, active);
  data.merged = mergeProfiles(profiles);
  data.browserUsers = getBrowserAccounts();
  data.activeAccounts = active;
  annotate(data.repertoire, data.merged);
}

/** Seanse filmu w danym dniu, pogrupowane po kinie (tylko dozwolone kina). */
export function showingsForDay(film, date, cinemaFilter, allowedSet) {
  const out = [];
  for (const [cinemaId, byDate] of Object.entries(film.showings)) {
    if (allowedSet && !allowedSet.has(cinemaId)) continue;
    if (cinemaFilter && cinemaId !== cinemaFilter) continue;
    const shows = byDate[date];
    if (shows?.length) out.push({ cinemaId, shows });
  }
  return out;
}

export function filmHasFormat(film, format) {
  return !format || film.formats.includes(format);
}
