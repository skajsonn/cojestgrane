// Synchronizacja profilu Letterboxd bezpośrednio w przeglądarce.
// Letterboxd nie wysyła nagłówków CORS, więc publiczne strony profilu
// pobieramy przez proxy CORS (allorigins). Dane trafiają wyłącznie do
// localStorage tej przeglądarki. Konta z config.json są nadal
// synchronizowane server-side (codziennie, pełniejsze i pewniejsze) —
// ten moduł obsługuje konta dopisane ręcznie w Ustawieniach.

export const USER_RE = /^[a-zA-Z0-9_]{2,30}$/;

const CACHE_PREFIX = 'kk_lb_cache_';
const MAX_PAGES = 40;          // twardy limit: 40 stron × 72 pozycje
const FRESH_HOURS = 20;        // odświeżamy raz na dobę

const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

/** Cloudflare potrafi odpowiedzieć stroną-wyzwaniem zamiast treścią. */
function isChallenge(text) {
  return /<title>\s*Just a moment|cf-browser-verification|cf-challenge/i.test(text);
}

async function fetchViaProxy(url, { rounds = 3 } = {}) {
  let lastErr = new Error('proxy niedostępne');
  for (let round = 0; round < rounds; round++) {
    for (const wrap of PROXIES) {
      try {
        const res = await fetch(wrap(url), { cache: 'no-store' });
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 200 && !isChallenge(text)) return text;
          lastErr = new Error(isChallenge(text ?? '') ? 'Cloudflare challenge' : 'pusta odpowiedź');
        } else {
          lastErr = new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        lastErr = err;
      }
    }
    await new Promise((r) => setTimeout(r, 800 * (round + 1)));
  }
  throw lastErr;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Ten sam parser co w scripts/sync-letterboxd.mjs — musi zostać zgodny. */
function parseGrid(html, { withRatings }) {
  const items = [];
  for (const block of html.split('<li class="griditem">').slice(1)) {
    const slug = block.match(/data-item-slug="([^"]+)"/)?.[1];
    const nameRaw = block.match(/data-item-full-display-name="([^"]+)"/)?.[1]
      ?? block.match(/data-item-name="([^"]+)"/)?.[1];
    if (!slug || !nameRaw) continue;
    const decoded = decodeEntities(nameRaw);
    const m = decoded.match(/^(.*)\s\((\d{4})\)$/);
    const item = { slug, title: m ? m[1] : decoded, year: m ? Number(m[2]) : null };
    if (withRatings) {
      const r = block.match(/\brated-(\d{1,2})\b/);
      item.rating10 = r ? Number(r[1]) : null;
    }
    items.push(item);
  }
  return items;
}

function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const tag = (name) => it.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null;
    const title = tag('letterboxd:filmTitle');
    if (!title) continue;
    const desc = tag('description') || '';
    const paragraphs = [...desc.matchAll(/<p>([\s\S]*?)<\/p>/g)]
      .map((p) => p[1].replace(/<[^>]+>/g, '').trim())
      .filter((t) => t && !/^Watched on /.test(t));
    out.push({
      title: decodeEntities(title),
      year: Number(tag('letterboxd:filmYear')) || null,
      slug: tag('link')?.match(/\/film\/([a-z0-9-]+)\//)?.[1] ?? null,
      rating10: tag('letterboxd:memberRating') ? Math.round(parseFloat(tag('letterboxd:memberRating')) * 2) : null,
      watchedDate: tag('letterboxd:watchedDate'),
      review: paragraphs.length ? decodeEntities(paragraphs.join(' ')).slice(0, 400) : null,
    });
  }
  return out;
}

async function scrapeGrid(user, path, { withRatings }, onProgress, label) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchViaProxy(`https://letterboxd.com/${user}/${path}/page/${page}/`);
    const items = parseGrid(html, { withRatings });
    if (!items.length) break;
    all.push(...items);
    onProgress?.(`@${user}: ${label} ${all.length}…`);
  }
  return all;
}

/* ── API modułu ─────────────────────────────────────────────────── */

export function readCache(user) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_PREFIX + user) ?? 'null');
    return c && Array.isArray(c.watched) ? c : null;
  } catch { return null; }
}

export function cacheFresh(cache) {
  return !!cache && (Date.now() - Date.parse(cache.generatedAt)) < FRESH_HOURS * 3600e3;
}

export function dropCache(user) {
  localStorage.removeItem(CACHE_PREFIX + user);
}

/**
 * Pełna synchronizacja profilu w przeglądarce.
 * Rzuca z czytelnym komunikatem gdy profil nie istnieje / proxy padło.
 */
export async function syncAccount(user, onProgress) {
  if (!USER_RE.test(user)) throw new Error('nieprawidłowy nick');
  onProgress?.(`@${user}: łączę się…`);

  // Kolejność „najcenniejsze najpierw” — Cloudflare przepuszcza żądania
  // losowo, więc watchlistę i RSS zbieramy zanim spróbujemy pełnej historii.
  let watchlist = [];
  try {
    watchlist = await scrapeGrid(user, 'watchlist', { withRatings: false }, onProgress, 'watchlista');
  } catch { /* spróbujemy dalej */ }

  let recent = [];
  try {
    recent = parseRss(await fetchViaProxy(`https://letterboxd.com/${user}/rss/`));
  } catch { /* RSS bywa kapryśny — nie blokuje synchronizacji */ }

  let watched = [];
  let partial = false;
  try {
    watched = await scrapeGrid(user, 'films', { withRatings: true }, onProgress, 'obejrzane');
  } catch { /* pełna historia nie przeszła — fallback niżej */ }

  if (!watched.length && recent.length) {
    // Tryb częściowy: obejrzane z RSS (ostatnie ~50, ze slugami i ocenami).
    partial = true;
    const seen = new Set();
    for (const r of recent) {
      if (!r.slug || seen.has(r.slug)) continue;
      seen.add(r.slug);
      watched.push({ slug: r.slug, title: r.title, year: r.year, rating10: r.rating10 });
    }
  }

  if (!watched.length && !watchlist.length && !recent.length) {
    throw new Error(`profil @${user} niedostępny (pusty, prywatny albo proxy zablokowane) — spróbuj za chwilę`);
  }

  const data = {
    generatedAt: new Date().toISOString(),
    user,
    source: 'browser',
    partial,
    counts: { watched: watched.length, watchlist: watchlist.length },
    watched,
    watchlist,
    recent,
  };

  try {
    localStorage.setItem(CACHE_PREFIX + user, JSON.stringify(data));
  } catch {
    // limit localStorage — tniemy recenzje i próbujemy raz jeszcze
    data.recent = [];
    try { localStorage.setItem(CACHE_PREFIX + user, JSON.stringify(data)); }
    catch { throw new Error('profil zbyt duży na pamięć przeglądarki'); }
  }
  onProgress?.(`@${user}: gotowe — ${watched.length} obejrzanych${partial ? ' (ostatnie z RSS — pełna historia była chwilowo niedostępna)' : ''}, ${watchlist.length} na watchliście`);
  return data;
}
