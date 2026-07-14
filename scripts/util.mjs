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
        const res = await fetch(wrap(u.toString()), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 200 && !isChallenge(text)) return text;
        }
        lastErr = new Error(`proxy HTTP ${res.status} dla ${url}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (round < rounds - 1) await sleep(1200 * (round + 1));
  }
  throw lastErr;
}

// Bezpiecznik: gdy źródło za Cloudflare blokuje runner, nie wolno mielić
// wszystkich dróg przy każdym z ~90 zapytań (to przekracza limit czasu joba
// i GitHub anuluje run). Po kilku pełnych niepowodzeniach host jest
// oznaczany jako zablokowany i kolejne zapytania padają natychmiast.
const blockedHosts = new Set();
const hostFails = new Map();
const hostRoute = new Map(); // host -> nazwa drogi, która ostatnio zadziałała
const HOST_FAIL_LIMIT = 3;

/** Pojedynczy curl bez ponawiania i bez proxy-storm (ograniczony w czasie). */
async function curlOnce(url, userAgent, timeoutSec = 12) {
  try {
    const { stdout } = await execFileP(
      'curl',
      [
        '--silent', '--show-error', '--fail-with-body', '--location',
        '--max-time', String(timeoutSec),
        '--user-agent', userAgent || UA,
        '--write-out', '\n%{http_code}',
        url,
      ],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    const idx = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(idx + 1).trim());
    const body = stdout.slice(0, idx);
    if (status >= 200 && status < 300 && !isChallenge(body)) return body;
  } catch { /* następna droga */ }
  return null;
}

/**
 * Odporne pobranie JSON dla źródeł za Cloudflare (Cinema City, Letterboxd),
 * które challenge'ują IP serwerów GitHub Actions. Kolejność dróg:
 *  - CI (Worker skonfigurowany): Worker → Node fetch → curl → proxy
 *    (Node-direct to właśnie ta droga, którą Cloudflare blokuje najczęściej),
 *  - lokalnie (brak env Workera): Node fetch → curl → proxy.
 * Każda droga jest jednostrzałowa i ograniczona czasowo; po HOST_FAIL_LIMIT
 * pełnych niepowodzeniach host jest pomijany do końca uruchomienia.
 */
export async function fetchJsonResilient(url, { headers = {} } = {}) {
  const host = new URL(url).hostname;
  if (blockedHosts.has(host)) {
    throw new Error(`${host}: pominięty (oznaczony jako zablokowany w tym uruchomieniu)`);
  }
  const ua = headers['User-Agent'] || headers['user-agent'];
  const workerOn = !!(process.env.LB_PROXY_URL || '').trim() && !!(process.env.LB_PROXY_TOKEN || '').trim();

  const nodeDirect = async () => {
    const res = await fetchWithRetry(url, { headers, retries: 0, timeoutMs: 12000 });
    if (!res.ok) return null;
    const text = await res.text();
    return isChallenge(text) ? null : text;
  };

  // nazwane drogi — kolejność zależy od środowiska; „node" bywa blokowany
  // pierwszy, więc na CI z Workerem stawiamy Worker na czele
  const named = {
    worker: () => fetchViaWorker(url),
    node: nodeDirect,
    curl: () => curlOnce(url, ua),
    proxy: () => fetchTextViaProxy(url, { rounds: 1 }).catch(() => null),
  };
  let order = workerOn ? ['worker', 'node', 'curl', 'proxy'] : ['node', 'curl', 'worker', 'proxy'];

  // droga, która ostatnio zadziałała dla tego hosta, idzie pierwsza —
  // oszczędza 12 s marnowane co zapytanie na blokowanym Node-fetchu
  const winner = hostRoute.get(host);
  if (winner) order = [winner, ...order.filter((r) => r !== winner)];

  for (const name of order) {
    let text = null;
    try { text = await named[name](); } catch { /* następna droga */ }
    if (text) {
      try {
        const parsed = JSON.parse(text);
        hostRoute.set(host, name);
        return parsed;
      } catch { /* nie-JSON, następna droga */ }
    }
  }

  const n = (hostFails.get(host) || 0) + 1;
  hostFails.set(host, n);
  if (n >= HOST_FAIL_LIMIT) {
    blockedHosts.add(host);
    console.warn(`[fetch] ${host}: ${n} nieudanych pobrań — pomijam resztę tego uruchomienia (fail-fast).`);
  }
  throw new Error(`Wszystkie drogi pobrania zawiodły dla ${url}`);
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
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 200 && !isChallenge(text)) return text;
      }
      if (res.status === 400 || res.status === 403) return null; // host niedozwolony/zły token — nie ponawiamy
    } catch { /* spróbujemy jeszcze raz / innymi drogami */ }
    if (attempt === 0) await sleep(1000);
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
