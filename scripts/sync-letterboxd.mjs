#!/usr/bin/env node
// Synchronizuje publiczne profile Letterboxd (bez logowania, bez tokenów):
//  - wszystkie obejrzane filmy + oceny  (strony /films/)
//  - watchlista                         (strony /watchlist/)
//  - ostatnia aktywność + recenzje      (kanał RSS)
// Konta z config.json (letterboxdUsers). Zapis do data/letterboxd/<user>.json
// + data/letterboxd/index.json. Zero zależności npm.

import {
  fetchTextViaCurl, fetchTextViaProxy, readJsonIfExists, writeJson, sleep,
  decodeEntities, normalizeTitle,
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
  let viaProxy = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${base}/${path}/page/${page}/`;
    let html = viaProxy
      ? await fetchTextViaProxy(url)
      : await fetchTextViaCurl(url, { userAgent: BROWSER_UA });
    let items = parseGrid(html, { withRatings });

    // Pułapka z runnerów GitHub Actions: Letterboxd potrafi zwrócić 200
    // z okrojoną stroną BEZ siatki (to nie challenge, więc curl "się udaje").
    // Pusta pierwsza strona = podejrzane → wymuszamy pobranie przez proxy.
    if (items.length === 0 && page === 1 && !viaProxy) {
      console.warn(`[letterboxd] ${path}/1: 0 pozycji z bezpośredniego pobrania ` +
        `(len=${html.length}, tytuł=${html.match(/<title>([^<]*)/)?.[1]?.slice(0, 60) ?? '?'}) — próbuję przez proxy`);
      viaProxy = true;
      html = await fetchTextViaProxy(url);
      items = parseGrid(html, { withRatings });
    }

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
      slug: tag('link')?.match(/\/film\/([a-z0-9-]+)\//)?.[1] ?? null,
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
  let scrapeError = null;
  try {
    if (process.env.LB_FORCE_DELTA) throw new Error('wymuszony tryb delta (test)');
    watched = await scrapeGrid(base, 'films', { withRatings: true });
    watchlist = await scrapeGrid(base, 'watchlist', { withRatings: false });
    if (watched.length === 0 && previous?.watched?.length) {
      throw new Error('0 obejrzanych w odpowiedzi');
    }
    recent = parseRss(await fetchTextViaCurl(`${base}/rss/`, { userAgent: BROWSER_UA }));
  } catch (err) {
    scrapeError = err.message.slice(0, 160);
    if (!previous?.watched?.length) throw err;
    // Pełny scraping zablokowany — tryb przyrostowy: kanał RSS (przechodzi
    // przez anty-bota) nanosi na poprzednie dane nowe obejrzenia/oceny
    // i zdejmuje je z watchlisty. Dodania do watchlisty poczekają na
    // najbliższy udany pełny scraping.
    console.warn(`[letterboxd] ${user}: pełny scraping nieudany (${scrapeError}) — nanoszę różnice z RSS.`);
    const rss = parseRss(await fetchTextViaCurl(`${base}/rss/`, { userAgent: BROWSER_UA }));
    const data = applyRssDelta(previous, rss);
    await writeJson(outPath, data);
    console.log(`[letterboxd] ${user}: delta OK — obejrzane ${data.counts.watched}, watchlista ${data.counts.watchlist}`);
    return { data, mode: 'delta', reason: scrapeError };
  }

  // Klucze do dopasowywania z repertuarem po tytule (fallback, gdy brak sluga).
  for (const list of [watched, watchlist]) {
    for (const f of list) f.norm = normalizeTitle(f.title);
  }

  const data = {
    generatedAt: new Date().toISOString(),
    fullSyncAt: new Date().toISOString(),
    user,
    profileUrl: `${base}/`,
    counts: { watched: watched.length, watchlist: watchlist.length },
    watched,
    watchlist,
    recent,
  };
  await writeJson(outPath, data);
  console.log(`[letterboxd] ${user}: obejrzane ${watched.length}, watchlista ${watchlist.length}, RSS ${recent.length}`);
  return { data, mode: 'full' };
}

/** Nanosi aktywność z RSS na poprzedni profil (nowe seanse, oceny, zdjęcia z watchlisty). */
function applyRssDelta(previous, rss) {
  const watched = [...(previous.watched ?? [])];
  const bySlug = new Map(watched.map((w, i) => [w.slug, i]));
  let added = 0;
  let updated = 0;

  for (const r of rss) {
    if (!r.slug || !r.watchedDate) continue; // wpisy list itp. pomijamy
    const idx = bySlug.get(r.slug);
    if (idx === undefined) {
      watched.push({
        slug: r.slug, title: r.title, year: r.year,
        rating10: r.rating10 ?? null, norm: normalizeTitle(r.title),
      });
      bySlug.set(r.slug, watched.length - 1);
      added++;
    } else if (r.rating10 != null && watched[idx].rating10 !== r.rating10) {
      watched[idx].rating10 = r.rating10;
      updated++;
    }
  }

  // obejrzane znika z watchlisty (Letterboxd robi to samo po zalogowaniu seansu)
  const watchedSlugs = new Set(watched.map((w) => w.slug));
  const watchlist = (previous.watchlist ?? []).filter((w) => !watchedSlugs.has(w.slug));

  console.log(`[letterboxd] delta: +${added} obejrzanych, ${updated} zmian ocen, ` +
    `watchlista ${previous.watchlist?.length ?? 0} → ${watchlist.length}`);

  return {
    ...previous,
    generatedAt: new Date().toISOString(),
    fullSyncAt: previous.fullSyncAt ?? previous.generatedAt,
    counts: { watched: watched.length, watchlist: watchlist.length },
    watched,
    watchlist,
    recent: rss,
  };
}

async function main() {
  const index = { generatedAt: new Date().toISOString(), users: [] };
  const errors = [];
  for (const user of USERS) {
    try {
      const { data, mode, reason } = await syncUser(user);
      // telemetria diagnozowalna wprost z wdrożonego pliku:
      // mode 'full' = pełny scraping, 'delta' = tylko przyrost z RSS
      index.users.push({
        user,
        counts: data.counts,
        syncedAt: data.generatedAt,
        fullSyncAt: data.fullSyncAt ?? null,
        mode,
        ...(reason ? { reason } : {}),
      });
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
