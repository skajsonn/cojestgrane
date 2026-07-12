#!/usr/bin/env node
// Globalny kalendarz premier: najciekawsze kinowe premiery bieżącego roku
// wg TMDB (discover, region PL, dystrybucja kinowa), niezależnie od tego,
// co jest już w repertuarze Cinema City. Zapis do data/calendar.json.
// Wymaga TMDB_API_KEY; bez klucza zostawia poprzedni plik nietknięty.

import { fetchJson, readJsonIfExists, writeJson, sleep, warsawToday } from './util.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TMDB_KEY = (process.env.TMDB_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
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

  const list = [...films.values()].sort((a, b) => a.date.localeCompare(b.date));
  await markNotable(list, year);

  const out = {
    generatedAt: new Date().toISOString(),
    year: Number(year),
    films: list,
  };
  await writeJson(`${ROOT}/data/calendar.json`, out);
  const notable = list.filter((f) => f.notable).length;
  console.log(`[kalendarz] OK: ${list.length} premier ${year} (region PL)` +
    (GEMINI_KEY ? `, wyróżnionych przez AI: ${notable}` : ', bez kuracji AI (brak GEMINI_API_KEY)'));
}

/**
 * AI-kurator: globalna popularność TMDB nie odróżnia dużej polskiej premiery
 * (Lalka, pop ~2) od no-name'a (pop ~3), więc listę ocenia Gemini w roli
 * polskiego krytyka. Ustawia film.notable = true/false; bez klucza — nic.
 */
async function markNotable(films, year) {
  if (!GEMINI_KEY) return;
  const lines = films.map((f) =>
    `${f.title}${f.originalTitle ? ` / ${f.originalTitle}` : ''} (${f.date}; ${f.genres.join(',') || '?'})`).join('\n');
  const user =
    `Z poniższej listy premier kinowych ${year} w Polsce wybierz ŚCISŁĄ ELITĘ — od 25 do 45 tytułów na cały rok ` +
    `(średnio 2–4 na miesiąc), które kinoman naprawdę nie powinien przegapić: blockbustery i głośne hity, ` +
    `duże polskie premiery (wielkie adaptacje, filmy znanych reżyserów, głośne biografie), uznane kino festiwalowe ` +
    `i kultowych twórców. To jest selekcja, nie przegląd: ZDECYDOWANA WIĘKSZOŚĆ listy ma ODPAŚĆ — każde małe ` +
    `no-name'owe produkcje, tanie horrory, komedie romantyczne bez rozgłosu, kino familijne niższej półki, ` +
    `dokumenty niszowe. W razie wątpliwości POMIŃ. ` +
    `Zwróć WYŁĄCZNIE tablicę JSON polskich tytułów, dokładnie jak na liście (część przed „ / ”): ["Tytuł", ...]\n\nLISTA:\n${lines}`;

  const attempts = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite'];
  for (const model of attempts) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: 'Jesteś polskim krytykiem filmowym i kuratorem repertuaru kinowego. Odpowiadasz wyłącznie JSON-em.' }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 4000,
              thinkingConfig: { thinkingBudget: 0 },
              responseMimeType: 'application/json',
            },
          }),
        },
      );
      if (!res.ok) {
        // 429 = limit (próbujemy lżejszy model), 5xx = chwilowe — ponawiamy
        if (res.status === 429 || res.status >= 500) {
          console.warn(`[kalendarz] kuracja AI (${model}): HTTP ${res.status} — ponawiam`);
          await sleep(20000); // 5xx = przeciążenie Google, krótkie odstępy nie pomagają
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      const picked = JSON.parse(text);
      if (!Array.isArray(picked)) throw new Error('odpowiedź nie jest tablicą');
      if (picked.length > 60 || picked.length < 10) {
        // model zignorował budżet selekcji — werdykt niewiarygodny
        throw new Error(`podejrzana liczba wyróżnień: ${picked.length}`);
      }
      const set = new Set(picked.map((t) => String(t).trim().toLowerCase()));
      for (const f of films) f.notable = set.has(f.title.trim().toLowerCase());
      return;
    } catch (err) {
      console.warn(`[kalendarz] kuracja AI (${model}) nieudana: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[kalendarz] BŁĄD:', err);
  process.exit(1);
});
