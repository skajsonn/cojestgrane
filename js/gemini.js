// Klient rekonesansu AI. Dwa tryby:
//  1) wbudowany asystent strony — żądania idą przez nasz Cloudflare Worker
//     (klucz Gemini siedzi w sekrecie Workera, nigdy w tym repo; Worker
//     przyjmuje wyłącznie żądania z cojestgrane.me),
//  2) własny klucz użytkownika z Ustawień (localStorage) — bezpośrednio
//     do API Google, z pominięciem proxy.

const KEY_API = 'kk_gemini_key';
// Kolejność prób: flash (lepszy) → flash-lite (osobna, większa pula darmowych
// zapytań dziennych — ratuje, gdy dzienny limit flasha jest wyczerpany).
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// Adres naszego Workera (cloudflare/worker.js). Pusty = tryb proxy wyłączony.
const PROXY_URL = '';

export function getApiKey() {
  return (localStorage.getItem(KEY_API) ?? '').trim() || null;
}
export function setApiKey(key) {
  localStorage.setItem(KEY_API, key);
}
export function clearApiKey() {
  localStorage.removeItem(KEY_API);
}
/** Czy rekonesans ma czym działać (własny klucz albo proxy strony). */
export function hasApiKey() {
  return !!(getApiKey() || PROXY_URL);
}

/** Walidacja formatu klucza (stary AIza…, nowy AQ.… z kropką). */
export function looksLikeKey(key) {
  return /^[A-Za-z0-9._-]{20,120}$/.test(key);
}

export async function testKey(key) {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
    headers: { 'x-goog-api-key': key },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/** Jedno wywołanie generateContent (JSON-owe odpowiedzi dla rekomendacji). */
export async function generate({ system, user, json = true, maxTokens = 4000 }) {
  const key = getApiKey();
  if (key) return generateDirect(key, { system, user, json, maxTokens });
  if (PROXY_URL) return generateViaProxy({ system, user, json, maxTokens });
  throw new Error('brak klucza');
}

async function generateViaProxy({ system, user, json, maxTokens }) {
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

async function generateDirect(key, { system, user, json, maxTokens }) {
  let lastErr;
  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: maxTokens,
            // bez trybu myślenia — tokeny myślenia zjadałyby limit wyjścia i ucinały JSON
            thinkingConfig: { thinkingBudget: 0 },
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
      if (!text) throw new Error('pusta odpowiedź modelu');
      return text;
    }
    const body = await res.json().catch(() => null);
    lastErr = new Error(body?.error?.message ?? `HTTP ${res.status}`);
    lastErr.status = res.status;
    if (res.status !== 429) break; // fallback na kolejny model tylko przy limicie
  }
  throw lastErr;
}
