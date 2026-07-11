// Cloudflare Worker: proxy rekonesansu AI dla cojestgrane.me.
// Klucz Gemini żyje w sekrecie Workera (GEMINI_API_KEY) — nigdy w repo.
// Worker przyjmuje wyłącznie żądania POST z dozwolonych originów.
//
// Wdrożenie (darmowe konto Cloudflare):
//  1. dash.cloudflare.com → Workers & Pages → Create → Worker → nazwa np. cojestgrane-ai
//  2. Edit code → wklej ten plik → Deploy
//  3. Worker → Settings → Variables and Secrets → Add:
//     typ Secret, nazwa GEMINI_API_KEY, wartość: Twój klucz z AI Studio
//  4. Skopiuj adres https://cojestgrane-ai.<subdomena>.workers.dev
//     i wpisz go jako PROXY_URL w js/gemini.js.

const ALLOWED_ORIGINS = [
  'https://cojestgrane.me',
  'https://www.cojestgrane.me',
  'http://localhost:8123',
];

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

const json = (obj, headers, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers });

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'tylko POST' }, cors, 405);
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'niedozwolony origin' }, cors, 403);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'nieprawidłowy JSON' }, cors, 400);
    }
    const system = String(body?.system ?? '').slice(0, 300000);
    const user = String(body?.user ?? '').slice(0, 5000);
    const wantJson = body?.json !== false;
    const maxTokens = Math.min(Number(body?.maxTokens) || 4000, 8000);
    if (!system || !user) return json({ error: 'brak system/user' }, cors, 400);

    let lastError = 'nieznany błąd';
    let lastStatus = 500;
    for (const model of MODELS) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: maxTokens,
              thinkingConfig: { thinkingBudget: 0 },
              ...(wantJson ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
        if (text) return json({ text }, cors);
        lastError = 'pusta odpowiedź modelu';
        continue;
      }
      const errBody = await res.json().catch(() => null);
      lastError = errBody?.error?.message ?? `HTTP ${res.status}`;
      lastStatus = res.status;
      if (res.status !== 429) break; // kolejny model próbujemy tylko przy limicie
    }
    return json({ error: lastError }, cors, lastStatus);
  },
};
