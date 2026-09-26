#!/usr/bin/env node
// Pobiera pełny repertuar Cinema City (Katowice: Punkt 44 + Silesia),
// wzbogaca dane o TMDB (tytuł oryginalny, opis, ocena — opcjonalnie,
// jeśli ustawiono TMDB_API_KEY) i zapisuje do data/*.json.
//
// Uruchamiane codziennie przez GitHub Actions. Zero zależności npm.

import {
  fetchJson, fetchJsonResilient, fetchTextViaCurl, readJsonIfExists, writeJson, sleep,
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

function pickBooking(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.startsWith('https://')) return c;
  }
  return null;
}

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
  // fetchJsonResilient: Cinema City bywa za Cloudflare i challenge'uje IP
  // runnerów (Node→Worker→curl→proxy)
  const json = await fetchJsonResilient(url, { headers: CC_HEADERS });
  const dates = json?.body?.dates;
  if (!Array.isArray(dates)) throw new Error(`Nieoczekiwany format odpowiedzi dates dla kina ${cinemaId}`);
  return dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

async function ccFilmEvents(cinemaId, date) {
  const url = `${CC_BASE}/film-events/in-cinema/${cinemaId}/at-date/${date}?attr=&lang=pl_PL`;
  const json = await fetchJsonResilient(url, { headers: CC_HEADERS });
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
  const year = parseInt(film.releaseYear, 10) || undefined;
  const yearOk = (dateStr) => {
    if (!year) return true;
    const y = parseInt(String(dateStr ?? '').slice(0, 4), 10);
    return Number.isFinite(y) && Math.abs(y - year) <= 1;
  };

  const cached = cache[film.id];
  if (cached) {
    // Trafienie trzymamy, o ile rok się zgadza (stare złe matche unieważniamy);
    // pudło ponawiamy raz w tygodniu.
    if (cached.tmdb && yearOk(cached.tmdb.releaseDate)) return cached.tmdb;
    if (!cached.tmdb && daysBetween(cached.fetchedAt, TODAY) < 7) return null;
  }
  let results = await tmdbSearch(film.name, year);
  if (!results.length && year) {
    // retry bez filtra roku, ale wyniki nadal muszą mieścić się w ±1 roku
    results = (await tmdbSearch(film.name, undefined)).filter((r) => yearOk(r.release_date));
  }
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

// Wersja schematu wpisów lb-map. Wpisy bez `v: LB_MAP_VERSION` powstały przed
// walidacją tytułów (wtedy brano w ciemno results[0] — stąd np. koncert
// André Rieu zmapowany na „One Battle After Another") i są sprawdzane ponownie.
const LB_MAP_VERSION = 2;
// Minimalne podobieństwo tytułu wyniku do tytułu z CC, żeby uznać trafienie.
const LB_MIN_TITLE_SCORE = 0.75;

function parseLbSearch(html) {
  const results = [];
  for (const block of html.split('<li class="search-result').slice(1)) {
    const slug = block.match(/data-item-slug="([^"]+)"/)?.[1];
    const nameRaw = block.match(/data-item-name="([^"]+)"/)?.[1];
    if (!slug || !nameRaw) continue;
    const m = decodeEntities(nameRaw).match(/^(.*)\s\((\d{4})\)$/);
    // Letterboxd pokazuje w wynikach tytuły alternatywne (m.in. polskie) —
    // to po nich wyszukiwarka dopasowała zapytanie, więc po nich weryfikujemy.
    const alt = block.match(/Alternative titles?:\s*([^<]+)/i)?.[1];
    const orig = block.match(/Original title:\s*([^<]+)/i)?.[1];
    results.push({
      slug,
      title: m ? m[1] : decodeEntities(nameRaw),
      year: m ? Number(m[2]) : null,
      altTitles: [
        ...(alt ? decodeEntities(alt).split(/,\s*/) : []),
        ...(orig ? [decodeEntities(orig)] : []),
      ].map((t) => t.trim()).filter(Boolean),
    });
  }
  return results;
}

function titleTokens(s) {
  return new Set(normalizeTitle(s).split(' ').filter((t) => t.length > 1));
}

/** Podobieństwo dwóch tytułów 0..1 (równość, zawieranie całych słów, wspólne słowa). */
function titleScore(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  // zawieranie całej frazy — tylko dla min. 2 słów („spider man calkiem nowy
  // dzien" w wersji z dubbingiem), pojedyncze słowo („avengers") to za mało
  if (short.includes(' ') && ` ${long} `.includes(` ${short} `)) return 0.9;
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  // względem dłuższego — inaczej jednowyrazowy tytuł zawsze dawałby 1.0
  return common / Math.max(A.size, B.size);
}

/** Najlepsze dopasowanie któregokolwiek znanego tytułu filmu do wyniku wyszukiwania. */
function bestTitleScore(knownTitles, result) {
  let best = 0;
  for (const q of knownTitles) {
    for (const t of [result.title, ...result.altTitles]) best = Math.max(best, titleScore(q, t));
  }
  return best;
}

async function lbLookup(film, cache) {
  const cached = cache[film.id];
  if (cached && cached.v === LB_MAP_VERSION && (cached.slug || daysBetween(cached.fetchedAt, TODAY) < 7)) {
    return cached;
  }

  // Zapytania do wyszukiwarki: pełny tytuł, tytuł bez dopisków w nawiasach
  // („Auta (re-release)" → „Auta") i sam człon główny („Backrooms. Bez wyjścia").
  const cleaned = film.name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.split(/[.:]/)[0].trim();
  const queries = [...new Set([film.name, cleaned, stem].filter(Boolean))];
  const year = parseInt(film.releaseYear, 10) || null;
  const yearConflict = (y) => !!(year && y && Math.abs(y - year) > 1);
  // Tytuły, do których wynik może pasować częściowo: pełny polski z CC
  // + oryginalny/PL z TMDB. Sam skrót („Avengers" z „Avengers: Koniec gry –
  // wersja rozszerzona") musi pasować DOKŁADNIE — inaczej trafia w „The Avengers".
  const knownTitles = [...new Set([film.name, cleaned, ...(film.extraTitles || [])].filter(Boolean))];
  const stemNorm = stem !== cleaned ? normalizeTitle(stem) : null;
  const scoreOf = (r) => {
    const s = bestTitleScore(knownTitles, r);
    if (s >= LB_MIN_TITLE_SCORE || !stemNorm) return s;
    // skrót to słaby dowód — liczy się tylko przy potwierdzonym roku
    // („Backrooms" 2026 = 2026 tak; „Avengers" bez roku w CC — nie)
    const yearConfirmed = !!(year && r.year && Math.abs(r.year - year) <= 1);
    return yearConfirmed && [r.title, ...r.altTitles].some((t) => normalizeTitle(t) === stemNorm) ? 1 : s;
  };


  let found = null;
  let anySearchOk = false; // czy choć jedno zapytanie w ogóle doszło do serwera
  for (const q of queries) {
    // "/" i ":" w ścieżce wyszukiwarka odrzuca (HTTP 400) — zamieniamy na spacje
    const safeQ = q.replace(/[/\:]+/g, ' ').replace(/\s+/g, ' ').trim();
    const url = `https://letterboxd.com/s/search/films/${encodeURIComponent(safeQ)}/`;
    let results = [];
    try {
      results = parseLbSearch(await fetchTextViaCurl(url, { userAgent: BROWSER_UA }));
      anySearchOk = true;
    } catch (err) {
      console.warn(`[lb-map] wyszukiwanie "${q}" nieudane: ${err.message}`);
    }
    await sleep(400);

    // Bez walidacji ŻADEN wynik nie przechodzi — pierwszy z brzegu wynik
    // (albo śmieciowa strona od proxy) to fałszywe „obejrzane"/„na watchliście".
    const valid = results
      .filter((r) => !yearConflict(r.year))
      .map((r) => ({ r, score: scoreOf(r), dy: year && r.year ? Math.abs(r.year - year) : 1 }))
      .filter((x) => x.score >= LB_MIN_TITLE_SCORE)
      .sort((a, b) => b.score - a.score || a.dy - b.dy);
    if (valid.length) {
      found = valid[0].r;
      break;
    }
    if (results.length) {
      console.warn(`[lb-map] "${q}": ${results.length} wyników, żaden nie pasuje tytułem/rokiem — pomijam`);
    }
  }

  if (!found && !anySearchOk) {
    // Sieć padła: stare dopasowanie zostawiamy (lepsze niż nic), chyba że
    // przeczy mu rok — do ponownej weryfikacji w kolejnym runie.
    if (cached?.slug && !yearConflict(cached.year)) return cached;
    return { q: film.name, slug: null, transient: true };
  }

  const entry = found
    ? { v: LB_MAP_VERSION, fetchedAt: TODAY, q: film.name, slug: found.slug, title: found.title, year: found.year }
    : { v: LB_MAP_VERSION, fetchedAt: TODAY, q: film.name, slug: null };
  // ten sam film co wcześniej — nie wyrzucamy świeżej oceny
  if (found && cached?.slug === found.slug) {
    for (const k of ['rating', 'ratingCount', 'ratingAt']) if (k in cached) entry[k] = cached[k];
  }
  cache[film.id] = entry;
  return entry;
}

/**
 * Średnia ocena społeczności Letterboxd (0.5–5) ze strony filmu (JSON-LD).
 * Odświeżana co 3 dni; brak oceny (mało głosów / przedpremiera) = null.
 */
async function lbRating(entry) {
  if (!entry.slug) return entry;
  if (entry.ratingAt && daysBetween(entry.ratingAt, TODAY) < 3) return entry;
  try {
    const html = await fetchTextViaCurl(`https://letterboxd.com/film/${entry.slug}/`, { userAgent: BROWSER_UA });
    const m = html.match(/"aggregateRating"[\s\S]{0,400}?"ratingValue":\s*([\d.]+)[\s\S]{0,200}?"ratingCount":\s*(\d+)/) ||
              html.match(/"ratingCount":\s*(\d+)[\s\S]{0,400}?"ratingValue":\s*([\d.]+)/);
    if (m) {
      const [value, count] = m.length === 3 && Number(m[1]) <= 5
        ? [Number(m[1]), Number(m[2])]
        : [Number(m[2]), Number(m[1])];
      entry.rating = Math.round(value * 100) / 100;
      entry.ratingCount = count;
    } else {
      entry.rating = null;
      entry.ratingCount = 0;
    }
    entry.ratingAt = TODAY;
  } catch (err) {
    console.warn(`[lb-rating] ${entry.slug}: ${err.message}`);
  }
  await sleep(300);
  return entry;
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`[repertuar] ${TODAY} → ${UNTIL}, kina: ${CONFIG.cinemas.map((c) => c.name).join(', ')}`);

  const films = new Map(); // filmId -> rekord filmu
  let totalEvents = 0;
  const failedCinemas = [];

  for (const cinema of CONFIG.cinemas) {
    let dates;
    try {
      dates = await ccDates(cinema.id);
    } catch (err) {
      // Kino niedostępne na żadnej z dróg — zapamiętujemy i nie nadpisujemy
      // repertuaru częściowymi danymi (guard niżej zostawia kompletny stary plik).
      console.warn(`[repertuar] ${cinema.name}: pominięte — ${err.message}`);
      failedCinemas.push(cinema.name);
      continue;
    }
    console.log(`[repertuar] ${cinema.name}: ${dates.length} dni z seansami`);
    for (const date of dates) {
      let body;
      try {
        body = await ccFilmEvents(cinema.id, date);
      } catch (err) {
        console.warn(`[repertuar] ${cinema.name} ${date}: pominięty dzień — ${err.message}`);
        if (!failedCinemas.includes(cinema.name)) failedCinemas.push(cinema.name);
        continue;
      }
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
          // Bezpośredni link do systemu biletowego. Celowo NIE booking-router:
          // ten potrafi przekierować na tickets.dev.* (zablokowane Cloudflare).
          booking: pickBooking(e.bookingLink, e.compositeBookingLink?.obsoleteBookingUrl),
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
  if (failedCinemas.length) {
    // Częściowy snapshot pominąłby seanse padniętego kina — zostawiamy
    // kompletny poprzedni repertuar, kolejny cron (za 6 h) ponowi.
    throw new Error(`Niekompletne dane — nieosiągalne kina: ${failedCinemas.join(', ')}. Zostawiam poprzedni repertuar.`);
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
        // tmdbEnrich przyjmuje surowy kształt CC (name/releaseYear)
        f.tmdb = await tmdbEnrich({ id: f.id, name: f.title, releaseYear: f.year }, tmdbCache);
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
  let rated = 0;
  // Twardy budzet: wzbogacanie o Letterboxd to metadane OPCJONALNE i nigdy
  // nie moze zjesc limitu czasu joba (wczesniej ~100 zapytan x ~100 s przy
  // blokadzie => run anulowany). Po przekroczeniu korzystamy z cache'u.
  const lbDeadline = Date.now() + 6 * 60 * 1000;
  let lbSkipped = 0;

  for (const f of films.values()) {
    if (Date.now() > lbDeadline) {
      // po budzecie: tylko to, co juz jest w cache — zero zapytan sieciowych
      const cached = lbMap[f.id];
      f.lbSlug = cached?.slug ?? null;
      f.lbTitle = cached?.slug ? cached.title : null;
      f.lbRating = cached?.rating ?? null;
      f.lbRatingCount = cached?.ratingCount ?? 0;
      if (cached?.slug) mapped++;
      lbSkipped++;
      continue;
    }
    const entry = await lbLookup({
      id: f.id, name: f.title, releaseYear: f.year,
      extraTitles: [f.tmdb?.originalTitle, f.tmdb?.title],
    }, lbMap);
    await lbRating(entry);
    f.lbSlug = entry.slug;
    f.lbTitle = entry.slug ? entry.title : null;
    f.lbRating = entry.rating ?? null;
    f.lbRatingCount = entry.ratingCount ?? 0;
    if (entry.slug) mapped++;
    if (entry.rating) rated++;
  }
  await writeJson(lbMapPath, lbMap);
  console.log(`[lb-map] dopasowano ${mapped}/${films.size} filmów, ocen Letterboxd: ${rated}` +
    (lbSkipped ? `, pominięto po budżecie czasu: ${lbSkipped}` : ''));

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
