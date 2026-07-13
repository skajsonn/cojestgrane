// Cloudflare Worker dla cojestgrane.me — dwa zadania:
//  1. POST /      — proxy rekonesansu AI (Gemini); klucz w sekrecie
//     GEMINI_API_KEY, przyjmuje wyłącznie żądania z dozwolonych originów.
//  2. POST /lb    — pobieranie stron letterboxd.com dla GitHub Actions
//     (Cloudflare Letterboxda blokuje IP runnerów); dostęp wyłącznie
//     z nagłówkiem X-Sync-Token równym sekretowi SYNC_TOKEN.
//
// Sekrety Workera (Settings → Variables and Secrets):
//   GEMINI_API_KEY — klucz Gemini z AI Studio
//   SYNC_TOKEN     — losowy token współdzielony z sekretem repo LB_PROXY_TOKEN

const ALLOWED_ORIGINS = [
  'https://cojestgrane.me',
  'https://www.cojestgrane.me',
  'http://localhost:8123',
];

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

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
    const url = new URL(request.url);
    if (url.pathname === '/lb') return handleLetterboxd(request, env);
    return handleGemini(request, env);
  },
};

/* ── /lb: pobieranie Letterboxd dla codziennej synchronizacji ───── */
async function handleLetterboxd(request, env) {
  const plain = { 'Content-Type': 'application/json; charset=utf-8' };
  if (request.method !== 'POST') return json({ error: 'tylko POST' }, plain, 405);
  if (!env.SYNC_TOKEN || request.headers.get('X-Sync-Token') !== env.SYNC_TOKEN) {
    return json({ error: 'brak dostępu' }, plain, 403);
  }

  let target;
  try {
    target = new URL(String((await request.json())?.url ?? ''));
  } catch {
    return json({ error: 'nieprawidłowy url' }, plain, 400);
  }
  if (target.protocol !== 'https:' || target.hostname !== 'letterboxd.com') {
    return json({ error: 'dozwolone tylko https://letterboxd.com/…' }, plain, 400);
  }

  const res = await fetch(target.toString(), {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' },
    redirect: 'follow',
  });
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/* ── /: proxy rekonesansu AI (Gemini) ───────────────────────────── */
async function handleGemini(request, env) {
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
}
