// Minimalny klient Gemini — używany WYŁĄCZNIE do dziennego rekonesansu
// rekomendacji (bez czatu). Klucz żyje tylko w localStorage tej przeglądarki.

const KEY_API = 'kk_gemini_key';
// Kolejność prób: flash (lepszy) → flash-lite (osobna, większa pula darmowych
// zapytań dziennych — ratuje, gdy dzienny limit flasha jest wyczerpany).
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// Wbudowany klucz strony (rekonesans działa dla każdego bez konfiguracji).
// Klucz jest jawny z założenia — MUSI mieć w Google Cloud Console ograniczenie
// „Websites: https://cojestgrane.me/*”, wtedy poza tą domeną jest bezużyteczny.
// Własny klucz w Ustawieniach ma pierwszeństwo.
const SITE_KEY = '';

export function getApiKey() {
  return (localStorage.getItem(KEY_API) ?? '').trim() || SITE_KEY || null;
}
export function setApiKey(key) {
  localStorage.setItem(KEY_API, key);
}
export function clearApiKey() {
  localStorage.removeItem(KEY_API);
}
export function hasApiKey() {
  return !!getApiKey();
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
  if (!key) throw new Error('brak klucza');

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
