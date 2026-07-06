#!/usr/bin/env node
// Pobiera pełny repertuar Cinema City (Katowice: Punkt 44 + Silesia),
// wzbogaca dane o TMDB (tytuł oryginalny, opis, ocena — opcjonalnie,
// jeśli ustawiono TMDB_API_KEY) i zapisuje do data/*.json.
//
// Uruchamiane codziennie przez GitHub Actions. Zero zależności npm.

import {
  fetchJson, fetchTextViaCurl, readJsonIfExists, writeJson, sleep,
  warsawToday, addDays, daysBetween, normalizeTitle, decodeEntities,
} from './util.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONFIG = await readJsonIfExists(`${ROOT}/config.json`);
if (!CONFIG) throw new Error('Brak config.json');

const CC_BASE = 'https://www.cinema-city.pl/pl/data-api-service/v1/quickbook/10103';
const CC_HEADERS = {
  // Cinema City nie wymaga klucza, ale odrzuca żądania bez sensownego UA.
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const TMDB_KEY = (process.env.TMDB_API_KEY || '').trim();

const TODAY = warsawToday();
const UNTIL = addDays(TODAY, CONFIG.daysAhead);

// Atrybuty CC sklasyfikowane, żeby frontend mógł je sensownie pokazać.
const FORMAT_ATTRS = new Set([
  'imax', '4dx', 'screenx', 'vip', '2d', '3d', 'dolby-atmos', 'laser-barco', 'superscreen',
]);
const LANG_ATTRS = new Set(['dubbed', 'subbed', 'voiceover', 'no-subs']);
const GENRE_ATTRS = new Set([
  'action', 'adventure', 'animation', 'biography', 'comedy', 'black-comedy', 'crime',
  'documentary', 'drama', 'family', 'fantasy', 'history', 'horror', 'musical', 'music',
  'mystery', 'romance', 'sci-fi', 'sport', 'thriller', 'war', 'western',
]);

function classifyStatus(film, firstSeen) {
  const year = parseInt(film.releaseYear, 10);
  const nowYear = parseInt(TODAY.slice(0, 4), 10);
  if (Number.isFinite(year) && year <= nowYear - 2) return 'retro';
  const rel = (film.releaseDate || '').slice(0, 10);
  if (rel) {
    const age = daysBetween(rel, TODAY);
    if (age < 0) return 'upcoming'; // oficjalna premiera dopiero będzie (przedpremiery/zapowiedzi)
    if (age <= 7) return 'premiere';
    if (age <= 21) return 'new';
    return 'regular';
  }
  // Fallback wyłącznie gdy CC nie poda daty premiery: świeżość w naszej bazie.
  if (firstSeen && daysBetween(firstSeen, TODAY) <= 7) return 'premiere';
  return 'regular';
}

async function ccDates(cinemaId) {
  const url = `${CC_BASE}/dates/in-cinema/${cinemaId}/until/${UNTIL}?attr=&lang=pl_PL`;
  const json = await fetchJson(url, { headers: CC_HEADERS });
  const dates = json?.body?.dates;
  if (!Array.isArray(dates)) throw new Error(`Nieoczekiwany format odpowiedzi dates dla kina ${cinemaId}`);
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

async function ccFilmEvents(cinemaId, date) {
  const url = `${CC_BASE}/film-events/in-cinema/${cinemaId}/at-date/${date}?attr=&lang=pl_PL`;
  const json = await fetchJson(url, { headers: CC_HEADERS });
  const body = json?.body;
  if (!body || !Array.isArray(body.films) || !Array.isArray(body.events)) {
    throw new Error(`Nieoczekiwany format film-events dla kina ${cinemaId} / ${date}`);
  }
  return body;
}

// ---------------------------------------------------------------- TMDB
async function tmdbSearch(title, year) {
  const params = new URLSearchParams({
    api_key: TMDB_KEY, query: title, language: 'pl-PL', include_adult: 'false',
  });
  if (year) params.set('primary_release_year', String(year));
  const json = await fetchJson(`https://api.themoviedb.org/3/search/movie?${params}`);
  return Array.isArray(json?.results) ? json.results : [];
}

const TMDB_GENRES = {
  28: 'akcja', 12: 'przygodowy', 16: 'animacja', 35: 'komedia', 80: 'kryminał',
  99: 'dokumentalny', 18: 'dramat', 10751: 'familijny', 14: 'fantasy', 36: 'historyczny',
  27: 'horror', 10402: 'muzyczny', 9648: 'tajemnica', 10749: 'romans', 878: 'sci-fi',
  10770: 'film TV', 53: 'thriller', 10752: 'wojenny', 37: 'western',
};

async function tmdbEnrich(film, cache) {
  const cached = cache[film.id];
  if (cached) {
    // Trafienie trzymamy na stałe; pudło ponawiamy raz w tygodniu.
    if (cached.tmdb || daysBetween(cached.fetchedAt, TODAY) < 7) return cached.tmdb;
  }
  const year = parseInt(film.releaseYear, 10) || undefined;
  let results = await tmdbSearch(film.name, year);
  if (!results.length && year) results = await tmdbSearch(film.name, undefined);
  await sleep(120);

  const norm = normalizeTitle(film.name);
  const pick =
    results.find((r) => normalizeTitle(r.title) === norm || normalizeTitle(r.original_title) === norm) ||
    results[0] || null;

  const tmdb = pick
    ? {
        id: pick.id,
        originalTitle: pick.original_title,
        title: pick.title,
        overview: (pick.overview || '').slice(0, 600) || null,
        voteAverage: typeof pick.vote_average === 'number' ? Math.round(pick.vote_average * 10) / 10 : null,
        voteCount: pick.vote_count ?? null,
        releaseDate: pick.release_date || null,
        genres: (pick.genre_ids || []).map((g) => TMDB_GENRES[g]).filter(Boolean),
        poster: pick.poster_path ? `https://image.tmdb.org/t/p/w500${pick.poster_path}` : null,
        backdrop: pick.backdrop_path ? `https://image.tmdb.org/t/p/w780${pick.backdrop_path}` : null,
      }
    : null;
  cache[film.id] = { fetchedAt: TODAY, q: film.name, tmdb };
  return tmdb;
}

// ------------------------------------------------- Letterboxd mapping
// Wyszukiwarka Letterboxd indeksuje tytuły alternatywne (w tym polskie),
// więc dla polskiego tytułu z Cinema City dostajemy kanoniczny slug
// i tytuł oryginalny. Slug to potem klucz dopasowania do list użytkownika.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function parseLbSearch(html) {
  const results = [];
  for (const block of html.split('<li class="search-result').slice(1)) {
    const slug = block.match(/data-item-slug="([^"]+)"/)?.[1];
    const nameRaw = block.match(/data-item-name="([^"]+)"/)?.[1];
    if (!slug || !nameRaw) continue;
    const m = decodeEntities(nameRaw).match(/^(.*)\s\((\d{4})\)$/);
    results.push({
      slug,
      title: m ? m[1] : decodeEntities(nameRaw),
      year: m ? Number(m[2]) : null,
    });
  }
  return results;
}

async function lbLookup(film, cache) {
  const cached = cache[film.id];
  if (cached && (cached.slug || daysBetween(cached.fetchedAt, TODAY) < 7)) return cached;

  const queries = [film.name];
  // fallback: sam człon główny tytułu ("Backrooms. Bez wyjścia" → "Backrooms")
  const stem = film.name.split(/[.:]/)[0].trim();
  if (stem && stem !== film.name) queries.push(stem);

  const year = parseInt(film.releaseYear, 10) || null;
  let found = null;
  for (const q of queries) {
    // "/" i ":" w ścieżce wyszukiwarka odrzuca (HTTP 400) — zamieniamy na spacje
    const safeQ = q.replace(/[/\\:]+/g, ' ').replace(/\s+/g, ' ').trim();
    const url = `https://letterboxd.com/s/search/films/${encodeURIComponent(safeQ)}/`;
    let results = [];
    try {
      results = parseLbSearch(await fetchTextViaCurl(url, { userAgent: BROWSER_UA }));
    } catch (err) {
      console.warn(`[lb-map] wyszukiwanie "${q}" nieudane: ${err.message}`);
    }
    await sleep(400);
    if (!results.length) continue;
    found =
      (year && results.find((r) => r.year === year)) ||
      (year && results.find((r) => r.year && Math.abs(r.year - year) <= 1)) ||
      results[0];
    if (found) break;
  }

  const entry = found
    ? { fetchedAt: TODAY, q: film.name, slug: found.slug, title: found.title, year: found.year }
    : { fetchedAt: TODAY, q: film.name, slug: null };
  cache[film.id] = entry;
  return entry;
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`[repertuar] ${TODAY} → ${UNTIL}, kina: ${CONFIG.cinemas.map((c) => c.name).join(', ')}`);

  const films = new Map(); // filmId -> rekord filmu
  let totalEvents = 0;

  for (const cinema of CONFIG.cinemas) {
    const dates = await ccDates(cinema.id);
    console.log(`[repertuar] ${cinema.name}: ${dates.length} dni z seansami`);
    for (const date of dates) {
      const body = await ccFilmEvents(cinema.id, date);
      for (const f of body.films) {
        if (!f?.id || !f?.name) continue;
        if (!films.has(f.id)) {
          films.set(f.id, {
            id: String(f.id),
            title: String(f.name),
            year: String(f.releaseYear || ''),
            releaseDate: (f.releaseDate || '').slice(0, 10) || null,
            length: Number.isFinite(f.length) ? f.length : null,
            poster: typeof f.posterLink === 'string' && f.posterLink.startsWith('https://') ? f.posterLink : null,
            trailer: typeof f.videoLink === 'string' && f.videoLink.startsWith('https://') ? f.videoLink : null,
            link: typeof f.link === 'string' && f.link.startsWith('https://') ? f.link : null,
            genres: [], formats: [], showings: {},
          });
        }
        const rec = films.get(f.id);
        for (const a of f.attributeIds || []) {
          if (GENRE_ATTRS.has(a) && !rec.genres.includes(a)) rec.genres.push(a);
          if (FORMAT_ATTRS.has(a) && !rec.formats.includes(a)) rec.formats.push(a);
        }
      }
      for (const e of body.events) {
        if (!e?.filmId || !e?.eventDateTime) continue;
        const rec = films.get(e.filmId);
        if (!rec) continue;
        const attrs = e.attributeIds || [];
        const show = {
          time: String(e.eventDateTime).slice(11, 16),
          formats: attrs.filter((a) => FORMAT_ATTRS.has(a) && a !== '2d'),
          lang: attrs.find((a) => LANG_ATTRS.has(a)) || null,
          auditorium: e.auditorium || null,
          booking: typeof e.bookingLink === 'string' && e.bookingLink.startsWith('https://') ? e.bookingLink : null,
          soldOut: !!e.soldOut,
        };
        ((rec.showings[cinema.id] ??= {})[date] ??= []).push(show);
        for (const fm of show.formats) if (!rec.formats.includes(fm)) rec.formats.push(fm);
        totalEvents++;
      }
      await sleep(200); // grzeczne tempo wobec API
    }
  }

  if (films.size === 0 || totalEvents === 0) {
    // Nie nadpisujemy dobrych danych pustymi — lepiej przerwać z błędem.
    throw new Error('API zwróciło 0 filmów/seansów — przerywam bez zapisu.');
  }

  // Historia „pierwszego zauważenia” filmu (wykrywanie premier + archiwum).
  const seenPath = `${ROOT}/data/films-history.json`;
  const seen = (await readJsonIfExists(seenPath, {})) || {};
  for (const f of films.values()) {
    if (!seen[f.id]) seen[f.id] = { firstSeen: TODAY, title: f.title };
    seen[f.id].lastSeen = TODAY;
  }

  // Wzbogacenie TMDB (opcjonalne).
  const cachePath = `${ROOT}/data/tmdb-cache.json`;
  const tmdbCache = (await readJsonIfExists(cachePath, {})) || {};
  if (TMDB_KEY) {
    for (const f of films.values()) {
      try {
        f.tmdb = await tmdbEnrich(f, tmdbCache);
      } catch (err) {
        console.warn(`[tmdb] pominięto "${f.title}": ${err.message}`);
        f.tmdb = tmdbCache[f.id]?.tmdb ?? null;
      }
    }
    await writeJson(cachePath, tmdbCache);
  } else {
    console.log('[tmdb] TMDB_API_KEY nie ustawiony — pomijam wzbogacanie (plakaty i tak są z Cinema City).');
    for (const f of films.values()) f.tmdb = tmdbCache[f.id]?.tmdb ?? null;
  }

  // Mapowanie na Letterboxd (slug + tytuł oryginalny) — bez klucza, przez wyszukiwarkę.
  const lbMapPath = `${ROOT}/data/lb-map.json`;
  const lbMap = (await readJsonIfExists(lbMapPath, {})) || {};
  let mapped = 0;
  for (const f of films.values()) {
    const entry = await lbLookup({ id: f.id, name: f.title, releaseYear: f.year }, lbMap);
    f.lbSlug = entry.slug;
    f.lbTitle = entry.slug ? entry.title : null;
    if (entry.slug) mapped++;
  }
  await writeJson(lbMapPath, lbMap);
  console.log(`[lb-map] dopasowano ${mapped}/${films.size} filmów do Letterboxd`);

  const out = {
    generatedAt: new Date().toISOString(),
    today: TODAY,
    cinemas: CONFIG.cinemas,
    films: [...films.values()]
      .map((f) => {
        const orig = f.tmdb?.originalTitle ?? f.lbTitle;
        return {
          ...f,
          originalTitle: orig && normalizeTitle(orig) !== normalizeTitle(f.title) ? orig : null,
          firstSeen: seen[f.id].firstSeen,
          status: classifyStatus({ releaseYear: f.year, releaseDate: f.releaseDate }, seen[f.id].firstSeen),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'pl')),
  };

  await writeJson(`${ROOT}/data/repertoire.json`, out);
  await writeJson(seenPath, seen);

  // Archiwum repertuaru: jeden kompaktowy wpis dziennie.
  const histPath = `${ROOT}/data/history.json`;
  const hist = (await readJsonIfExists(histPath, { days: [] })) || { days: [] };
  hist.days = hist.days.filter((d) => d.date !== TODAY);
  hist.days.push({
    date: TODAY,
    films: out.films.map((f) => ({ id: f.id, t: f.title, s: f.status, c: Object.keys(f.showings) })),
  });
  hist.days = hist.days.slice(-CONFIG.historyMaxDays);
  await writeJson(histPath, hist);

  const premieres = out.films.filter((f) => f.status === 'premiere').length;
  const retro = out.films.filter((f) => f.status === 'retro').length;
  console.log(`[repertuar] OK: ${out.films.length} filmów, ${totalEvents} seansów, premiery: ${premieres}, powtórki: ${retro}`);
}

main().catch((err) => {
  console.error('[repertuar] BŁĄD:', err);
  process.exit(1);
});
