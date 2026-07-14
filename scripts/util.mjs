// Wspólne narzędzia dla skryptów pobierania danych.
// Zero zależności npm — tylko wbudowane API Node 20+.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const UA =
  'CoJestGrane/1.0 (cojestgrane.me; osobisty agregator repertuaru; GitHub Actions)';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pobiera URL z timeoutem i ponowieniami. Rzuca po wyczerpaniu prób.
 */
export async function fetchWithRetry(url, { retries = 2, timeoutMs = 25000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', ...headers },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} dla ${url}`);
        await sleep(1500 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.json();
}

export async function fetchText(url, opts) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} dla ${url}`);
  return res.text();
}

/** Strona-wyzwanie Cloudflare zamiast właściwej treści. */
export function isChallenge(text) {
  return /<title>\s*Just a moment|cf-browser-verification|cf-challenge/i.test(text ?? '');
}

const CORS_PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

/** Pobranie wyłącznie przez proxy (gdy bezpośrednia droga daje podejrzane odpowiedzi). */
export async function fetchTextViaProxy(url, { rounds = 3 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`Dozwolone tylko https: ${url}`);
  if (u.hostname === 'letterboxd.com') {
    const viaWorker = await fetchViaWorker(u.toString());
    if (viaWorker) return viaWorker;
  }
  let lastErr = new Error('proxy niedostępne');
  for (let round = 0; round < rounds; round++) {
    for (const wrap of CORS_PROXIES) {
      try {
        const res = await fetch(wrap(u.toString()), { redirect: 'follow' });
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 200 && !isChallenge(text)) return text;
        }
        lastErr = new Error(`proxy HTTP ${res.status} dla ${url}`);
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(1200 * (round + 1));
  }
  throw lastErr;
}

/**
 * Odporne pobranie JSON dla źródeł za Cloudflare (Cinema City, Letterboxd),
 * które potrafią challenge'ować IP serwerów GitHub Actions:
 * Node fetch → prywatny Worker → curl (inny odcisk TLS) → publiczne proxy.
 * Z „domowych" IP zwykle wystarcza pierwszy krok.
 */
export async function fetchJsonResilient(url, { headers = {} } = {}) {
  const ua = headers['User-Agent'] || headers['user-agent'];

  // 1) bezpośrednio przez Node fetch (najszybsze)
  try {
    const res = await fetchWithRetry(url, { headers, retries: 1 });
    if (res.ok) {
      const text = await res.text();
      if (!isChallenge(text)) return JSON.parse(text);
    }
  } catch { /* próbujemy dalej */ }

  // 2) prywatny Worker (wyjście sieciowe inne niż runner)
  const viaWorker = await fetchViaWorker(new URL(url).toString());
  if (viaWorker) {
    try { return JSON.parse(viaWorker); } catch { /* dalej */ }
  }

  // 3) curl → 4) publiczne proxy (fetchTextViaCurl ma oba fallbacki)
  return JSON.parse(await fetchTextViaCurl(url, { userAgent: ua }));
}

/**
 * Prywatne proxy na Cloudflare Workerze (endpoint /lb) — najpewniejsza droga
 * do źródeł za Cloudflare z GitHub Actions. Wymaga env: LB_PROXY_URL +
 * LB_PROXY_TOKEN; Worker sam waliduje dozwolone hosty.
 */
async function fetchViaWorker(url) {
  const proxy = (process.env.LB_PROXY_URL || '').trim();
  const token = (process.env.LB_PROXY_TOKEN || '').trim();
  if (!proxy || !token) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(proxy, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 200 && !isChallenge(text)) return text;
      }
    } catch { /* spróbujemy jeszcze raz / innymi drogami */ }
    await sleep(1000);
  }
  return null;
}

/**
 * Pobiera stronę przez systemowy curl (execFile — bez shella, argumenty
 * przekazywane bezpośrednio). Cloudflare blokuje fetch Node'a po
 * fingerprincie TLS, a curl przepuszcza — potrzebne dla letterboxd.com.
 * Kolejność dla letterboxd.com: prywatny Worker (jeśli skonfigurowany) →
 * curl → publiczne proxy; IP runnerów GitHub Actions bywa blokowane.
 */
export async function fetchTextViaCurl(url, { retries = 2, timeoutSec = 25, userAgent } = {}) {
  const u = new URL(url); // walidacja — odrzuca śmieci zanim trafią do curla
  if (u.protocol !== 'https:') throw new Error(`Dozwolone tylko https: ${url}`);

  if (u.hostname === 'letterboxd.com') {
    const viaWorker = await fetchViaWorker(u.toString());
    if (viaWorker) return viaWorker;
  }
  let lastErr;
  let blocked = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await execFileP(
        'curl',
        [
          '--silent', '--show-error', '--fail-with-body', '--location',
          '--max-time', String(timeoutSec),
          '--user-agent', userAgent || UA,
          '--write-out', '\n%{http_code}',
          u.toString(),
        ],
        { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      );
      const idx = stdout.lastIndexOf('\n');
      const status = Number(stdout.slice(idx + 1).trim());
      const body = stdout.slice(0, idx);
      if (status >= 200 && status < 300 && !isChallenge(body)) return body;
      lastErr = new Error(`HTTP ${status}${isChallenge(body) ? ' (challenge)' : ''} dla ${url}`);
      if (status === 404) throw lastErr;              // nie istnieje — nie ponawiamy
      if (status === 403 || isChallenge(body)) { blocked = true; break; } // od razu do proxy
    } catch (err) {
      lastErr = err;
      if (/HTTP 404/.test(String(err.message))) throw err;
    }
    await sleep(1500 * (attempt + 1));
  }

  // Fallback przez proxy CORS — pomaga, gdy nasze IP jest blokowane.
  return fetchTextViaProxy(url, { rounds: 2 });
}

export async function readJsonIfExists(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 1) + '\n', 'utf8');
}

/** Dekoduje najczęstsze encje HTML (wystarczające dla tytułów filmów). */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#0*39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, ' ');
}

/** Normalizacja tytułu do dopasowywania (bez diakrytyków, interpunkcji, wielkości liter). */
export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Data lokalna (Europe/Warsaw) w formacie YYYY-MM-DD. */
export function warsawToday() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' });
  return fmt.format(new Date());
}

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(isoA, isoB) {
  return Math.round((new Date(isoB + 'T12:00:00Z') - new Date(isoA + 'T12:00:00Z')) / 86400000);
}
