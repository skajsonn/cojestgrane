#!/usr/bin/env node
// Globalny kalendarz premier: najciekawsze kinowe premiery bieżącego roku
// wg TMDB (discover, region PL, dystrybucja kinowa), niezależnie od tego,
// co jest już w repertuarze Cinema City. Zapis do data/calendar.json.
// Wymaga TMDB_API_KEY; bez klucza zostawia poprzedni plik nietknięty.

import { fetchJson, readJsonIfExists, writeJson, sleep, warsawToday } from './util.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TMDB_KEY = (process.env.TMDB_API_KEY || '').trim();
const PAGES = 8; // 8 × 20 = do 160 najpopularniejszych premier roku

const TMDB_GENRES = {
  28: 'akcja', 12: 'przygodowy', 16: 'animacja', 35: 'komedia', 80: 'kryminał',
  99: 'dokumentalny', 18: 'dramat', 10751: 'familijny', 14: 'fantasy', 36: 'historyczny',
  27: 'horror', 10402: 'muzyczny', 9648: 'tajemnica', 10749: 'romans', 878: 'sci-fi',
  10770: 'film TV', 53: 'thriller', 10752: 'wojenny', 37: 'western',
};

async function main() {
  if (!TMDB_KEY) {
    console.log('[kalendarz] TMDB_API_KEY nie ustawiony — pomijam (poprzedni plik zostaje).');
    return;
  }
  const year = warsawToday().slice(0, 4);
  const films = new Map();

  const addResults = (results) => {
    for (const r of results ?? []) {
      if (!r?.id || !r.release_date || films.has(r.id)) continue;
      films.set(r.id, {
        tmdbId: r.id,
        title: r.title,
        originalTitle: r.original_title !== r.title ? r.original_title : null,
        date: r.release_date,
        poster: r.poster_path ? `https://image.tmdb.org/t/p/w342${r.poster_path}` : null,
        popularity: Math.round((r.popularity ?? 0) * 10) / 10,
        voteAverage: typeof r.vote_average === 'number' ? Math.round(r.vote_average * 10) / 10 : null,
        voteCount: r.vote_count ?? 0,
        genres: (r.genre_ids || []).map((g) => TMDB_GENRES[g]).filter(Boolean).slice(0, 3),
        overview: (r.overview || '').slice(0, 320) || null,
      });
    }
  };

  const discover = async (extra) => {
    const params = new URLSearchParams({
      api_key: TMDB_KEY,
      language: 'pl-PL',
      region: 'PL',
      with_release_type: '3|2', // premiera kinowa (szeroka lub limitowana)
      sort_by: 'popularity.desc',
      include_adult: 'false',
      ...extra,
    });
    return fetchJson(`https://api.themoviedb.org/3/discover/movie?${params}`);
  };

  // najpopularniejsze w całym roku…
  for (let page = 1; page <= PAGES; page++) {
    const json = await discover({
      'release_date.gte': `${year}-01-01`,
      'release_date.lte': `${year}-12-31`,
      page: String(page),
    });
    addResults(json?.results);
    if (page >= (json?.total_pages ?? 1)) break;
    await sleep(120);
  }

  // …plus top-20 każdego miesiąca (globalny ranking faworyzuje filmy grane
  // teraz, a kalendarz ma pokazywać cały rok — w tym grudniową Diunę)
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const lastDay = new Date(Number(year), m, 0).getDate();
    const json = await discover({
      'release_date.gte': `${year}-${mm}-01`,
      'release_date.lte': `${year}-${mm}-${lastDay}`,
      page: '1',
    });
    addResults(json?.results);
    await sleep(120);
  }

  if (films.size < 20) {
    // Podejrzanie mało — nie nadpisujemy dobrych danych byle czym.
    throw new Error(`TMDB zwróciło tylko ${films.size} filmów — przerywam bez zapisu.`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    year: Number(year),
    films: [...films.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
  await writeJson(`${ROOT}/data/calendar.json`, out);
  console.log(`[kalendarz] OK: ${out.films.length} premier ${year} (region PL).`);
}

main().catch((err) => {
  console.error('[kalendarz] BŁĄD:', err);
  process.exit(1);
});
