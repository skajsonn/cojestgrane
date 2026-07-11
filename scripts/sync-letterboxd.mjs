#!/usr/bin/env node
// Synchronizuje publiczne profile Letterboxd (bez logowania, bez tokenów):
//  - wszystkie obejrzane filmy + oceny  (strony /films/)
//  - watchlista                         (strony /watchlist/)
//  - ostatnia aktywność + recenzje      (kanał RSS)
// Konta z config.json (letterboxdUsers). Zapis do data/letterboxd/<user>.json
// + data/letterboxd/index.json. Zero zależności npm.

import {
  fetchTextViaCurl, readJsonIfExists, writeJson, sleep, decodeEntities, normalizeTitle,
} from './util.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CONFIG = await readJsonIfExists(`${ROOT}/config.json`);
const USERS = [...new Set(
  (Array.isArray(CONFIG?.letterboxdUsers) ? CONFIG.letterboxdUsers : [CONFIG?.letterboxdUser])
    .filter(Boolean).map((u) => String(u).trim()),
)];
if (!USERS.length) throw new Error('Brak kont w config.json (letterboxdUsers).');
for (const u of USERS) {
  if (!/^[a-zA-Z0-9_]{2,30}$/.test(u)) throw new Error(`Nieprawidłowy nick Letterboxd: "${u}"`);
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_PAGES = 60; // twardy limit bezpieczeństwa (60 stron × 72 pozycje)

/** Parsuje stronę siatki plakatów (films/ lub watchlist/) na listę filmów. */
function parseGrid(html, { withRatings }) {
  const items = [];
  const blocks = html.split('<li class="griditem">').slice(1);
  for (const block of blocks) {
    const slug = block.match(/data-item-slug="([^"]+)"/)?.[1];
    const nameRaw = block.match(/data-item-full-display-name="([^"]+)"/)?.[1]
      ?? block.match(/data-item-name="([^"]+)"/)?.[1];
    if (!slug || !nameRaw) continue;
    const decoded = decodeEntities(nameRaw);
    const m = decoded.match(/^(.*)\s\((\d{4})\)$/);
    const item = {
      slug,
      title: m ? m[1] : decoded,
      year: m ? Number(m[2]) : null,
    };
    if (withRatings) {
      const r = block.match(/\brated-(\d{1,2})\b/);
      item.rating10 = r ? Number(r[1]) : null; // skala 1–10 (Letterboxd: gwiazdki × 2)
    }
    items.push(item);
  }
  return items;
}

async function scrapeGrid(base, path, { withRatings }) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchTextViaCurl(`${base}/${path}/page/${page}/`, { userAgent: BROWSER_UA });
    const items = parseGrid(html, { withRatings });
    if (items.length === 0) break;
    all.push(...items);
    await sleep(400); // grzeczne tempo
  }
  return all;
}

/** Parsuje kanał RSS (ostatnie ~50 aktywności: oceny, daty obejrzenia, recenzje). */
function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const tag = (name) => it.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
    const title = tag('letterboxd:filmTitle');
    if (!title) continue; // wpisy list itp. pomijamy
    const desc = tag('description') || '';
    // Recenzja = akapity z CDATA bez obrazka i bez stopki "Watched on".
    const paragraphs = [...desc.matchAll(/<p>([\s\S]*?)<\/p>/g)]
      .map((p) => p[1].replace(/<[^>]+>/g, '').trim())
      .filter((t) => t && !/^Watched on /.test(t));
    out.push({
      title: decodeEntities(title),
      year: Number(tag('letterboxd:filmYear')) || null,
      rating10: tag('letterboxd:memberRating') ? Math.round(parseFloat(tag('letterboxd:memberRating')) * 2) : null,
      watchedDate: tag('letterboxd:watchedDate'),
      rewatch: tag('letterboxd:rewatch') === 'Yes',
      tmdbId: Number(tag('tmdb:movieId')) || null,
      review: paragraphs.length ? decodeEntities(paragraphs.join(' ')).slice(0, 500) : null,
    });
  }
  return out;
}

async function syncUser(user) {
  console.log(`[letterboxd] synchronizuję profil: ${user}`);
  const base = `https://letterboxd.com/${user}`;
  const outPath = `${ROOT}/data/letterboxd/${user}.json`;
  const previous = await readJsonIfExists(outPath);

  let watched, watchlist, recent;
  try {
    watched = await scrapeGrid(base, 'films', { withRatings: true });
    watchlist = await scrapeGrid(base, 'watchlist', { withRatings: false });
    recent = parseRss(await fetchTextViaCurl(`${base}/rss/`, { userAgent: BROWSER_UA }));
  } catch (err) {
    if (previous?.watched?.length) {
      // Scraping bywa blokowany — nie nadpisujemy dobrych danych, zostawiamy stare.
      console.warn(`[letterboxd] ${user}: pobieranie nieudane (${err.message}) — zachowuję poprzednie dane.`);
      return previous;
    }
    throw err;
  }

  if (watched.length === 0 && previous?.watched?.length) {
    console.warn(`[letterboxd] ${user}: 0 obejrzanych mimo wcześniejszych danych — zachowuję poprzednie.`);
    return previous;
  }

  // Klucze do dopasowywania z repertuarem po tytule (fallback, gdy brak sluga).
  for (const list of [watched, watchlist]) {
    for (const f of list) f.norm = normalizeTitle(f.title);
  }

  const data = {
    generatedAt: new Date().toISOString(),
    user,
    profileUrl: `${base}/`,
    counts: { watched: watched.length, watchlist: watchlist.length },
    watched,
    watchlist,
    recent,
  };
  await writeJson(outPath, data);
  console.log(`[letterboxd] ${user}: obejrzane ${watched.length}, watchlista ${watchlist.length}, RSS ${recent.length}`);
  return data;
}

async function main() {
  const index = { generatedAt: new Date().toISOString(), users: [] };
  const errors = [];
  for (const user of USERS) {
    try {
      const data = await syncUser(user);
      // syncedAt = kiedy NAPRAWDĘ pobrano dane (guard może zwrócić stare)
      index.users.push({ user, counts: data.counts, syncedAt: data.generatedAt });
    } catch (err) {
      errors.push(`${user}: ${err.message}`);
      console.error(`[letterboxd] ${user}: BŁĄD — ${err.message}`);
    }
  }
  if (!index.users.length) throw new Error(`Żadne konto nie zsynchronizowane (${errors.join('; ')})`);
  await writeJson(`${ROOT}/data/letterboxd/index.json`, index);
  console.log(`[letterboxd] OK: ${index.users.length}/${USERS.length} kont.`);
}

main().catch((err) => {
  console.error('[letterboxd] BŁĄD:', err);
  process.exit(1);
});
