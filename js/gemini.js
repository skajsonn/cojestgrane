// Wspólny klient Gemini dla asystenta i rekomendacji.
// Klucz pochodzi wyłącznie z localStorage (Ustawienia) — nigdy z kodu.

import { getApiKey, getModel } from './settings.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function hasApiKey() {
  return !!getApiKey();
}

/**
 * Jedno wywołanie generateContent. `json: true` wymusza odpowiedź
 * w application/json (do rekomendacji strukturalnych).
 */
export async function generate({ system, contents, json = false, maxTokens = 1400, temperature = 0.8 }) {
  const key = getApiKey();
  if (!key) throw new GeminiError('Brak klucza API', 0);

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(getModel())}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new GeminiError(body?.error?.message ?? `HTTP ${res.status}`, res.status);
  }

  const data = await res.json();
  const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!reply) throw new GeminiError('Model zwrócił pustą odpowiedź — spróbuj ponownie.', 0);
  return reply;
}

export function friendlyGeminiError(err) {
  if (err.status === 0 && /Brak klucza/.test(err.message)) {
    return 'Najpierw dodaj darmowy klucz Gemini w Ustawieniach (⚙) — instrukcja jest w środku.';
  }
  if (err.status === 400 || err.status === 403) {
    return 'Klucz API wygląda na nieprawidłowy. Sprawdź go w Ustawieniach (⚙).';
  }
  if (err.status === 429) {
    return 'Przekroczony limit darmowych zapytań Gemini — odczekaj chwilę i spróbuj ponownie.';
  }
  return `Nie udało się połączyć z Gemini: ${err.message}`;
}
