// Klient rekonesansu AI. Wszystkie żądania idą przez nasz Cloudflare Worker
// (cloudflare/worker.js) — klucz Gemini żyje wyłącznie w sekrecie Workera,
// nigdy w tym repo ani w przeglądarce. Worker odpowiada tylko żądaniom
// z cojestgrane.me (i lokalnego podglądu), sam robi fallback
// gemini-2.5-flash → flash-lite przy dziennych limitach.

const PROXY_URL = 'https://cojestgrane-ai.yflsiemano.workers.dev';

/** Czy rekonesans ma czym działać. */
export function hasApiKey() {
  return !!PROXY_URL;
}

/** Jedno wywołanie generateContent (JSON-owe odpowiedzi dla rekomendacji). */
export async function generate({ system, user, json = true, maxTokens = 4000 }) {
  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, user, json, maxTokens }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.text) {
    const err = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.text;
}
