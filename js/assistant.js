// Asystent AI (Google Gemini) — działa jako popup, kontekst budowany
// z lokalnych JSON-ów: repertuar preferowanych kin + złączone profile
// Letterboxd. Ten sam kontekst zasila sekcję rekomendacji.

import { el, renderMarkdownSafe, dateInfo, todayIso } from './utils.js';
import { fmtLabel, genreLabel, langLabel } from './labels.js';
import { logRecommendation } from './settings.js';
import { generate, friendlyGeminiError } from './gemini.js';

const CONTEXT_DAYS = 14;

let chatHistory = []; // [{role:'user'|'model', parts:[{text}]}]
let systemPrompt = '';
let data = null;

const $ = (id) => document.getElementById(id);

export function initAssistant(loadedData) {
  data = loadedData;
  rebuildContext(data);

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send($('chat-input').value);
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send($('chat-input').value);
    }
  });
  $('chat-suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.sugg');
    if (btn) send(btn.textContent);
  });

  addMessage('ai',
    `Cześć! Znam repertuar (${data.cinemas.map((c) => c.name).join(', ')}) ` +
    'i Twój profil Letterboxd. Zapytaj, na co warto pójść — powiem Ci też dlaczego.');
}

/** Przebudowa kontekstu po zmianie profili/kin (bez utraty rozmowy). */
export function rebuildContext(loadedData) {
  data = loadedData;
  systemPrompt = buildSystemPrompt(data);
  const m = data.merged;
  $('chat-context-info').textContent = m.accounts.length
    ? `Kontekst: ${data.repertoire.films.length} filmów · ${data.cinemas.length} kin(a) · ` +
      `${m.accounts.map((u) => '@' + u).join(', ')} (${m.counts.watched} obejrzanych, ${m.counts.watchlist} watchlista)`
    : `Kontekst: ${data.repertoire.films.length} filmów · ${data.cinemas.length} kin(a) · brak profilu Letterboxd`;
}

/* ── budowa kontekstu (współdzielona z rekomendacjami) ──────────── */
export function buildSystemPrompt(d) {
  const today = todayIso();
  const rep = d.repertoire;
  const m = d.merged;
  const horizon = addDaysIso(today, CONTEXT_DAYS);
  const cinemaName = Object.fromEntries(d.cinemas.map((c) => [c.id, c.name]));

  const statusPl = {
    premiere: 'PREMIERA TYGODNIA', new: 'nowość', upcoming: 'zapowiedź (przedpremiera)',
    retro: 'POWTÓRKA/RETRO', regular: 'w repertuarze',
  };

  const filmLines = rep.films.map((f) => {
    const schedule = [];
    for (const [cid, byDate] of Object.entries(f.showings)) {
      if (!d.cinemaSet.has(cid)) continue;
      const days = Object.keys(byDate).sort().filter((dd) => dd >= today && dd <= horizon);
      if (!days.length) continue;
      const daysTxt = days.map((dd) => {
        const di = dateInfo(dd, today);
        const times = byDate[dd].map((s) => {
          const fx = s.formats.map(fmtLabel).join('+');
          const lang = langLabel(s.lang);
          return s.time + (fx ? `[${fx}]` : '') + (lang ? `(${lang})` : '');
        }).join(' ');
        return `${di.dow} ${di.dayMonth}: ${times}`;
      }).join('; ');
      schedule.push(`    ${cinemaName[cid] ?? cid}: ${daysTxt}`);
    }
    if (!schedule.length) return null; // film nie gra w preferowanych kinach

    const head = [
      `• ${f.title}${f.originalTitle ? ` (oryg. „${f.originalTitle}”)` : ''} (${f.year})`,
      `[${statusPl[f.status] ?? f.status}]`,
      f.length ? `${f.length} min` : null,
      f.genres.length ? f.genres.map(genreLabel).join('/') : null,
      f.formats.filter((x) => x !== '2d').map(fmtLabel).join(', ') || null,
      f.tmdb?.voteAverage ? `TMDB ${f.tmdb.voteAverage}` : null,
      f.lbWatched ? `UŻYTKOWNIK JUŻ OBEJRZAŁ${f.lbWatched.rating10 ? ` (ocenił ${f.lbWatched.rating10}/10)` : ''}` : null,
      f.lbWatchlisted ? 'NA WATCHLIŚCIE UŻYTKOWNIKA' : null,
    ].filter(Boolean).join(' | ');

    const overview = f.tmdb?.overview ? `    Opis: ${f.tmdb.overview.slice(0, 220)}` : null;
    return [head, overview, ...schedule].filter(Boolean).join('\n');
  }).filter(Boolean).join('\n');

  let profile = 'Brak danych z Letterboxd.';
  if (m.accounts.length) {
    const multi = m.accounts.length > 1;
    const tag = (w) => (multi ? ` [@${w.user}]` : '');
    const rated = m.watched.filter((w) => w.rating10 != null);
    const fav = rated.filter((w) => w.rating10 >= 8).map((w) => `${w.title} (${w.year ?? '?'}) ${w.rating10}/10${tag(w)}`);
    const meh = rated.filter((w) => w.rating10 <= 4).map((w) => `${w.title} ${w.rating10}/10${tag(w)}`);
    const wl = m.watchlist.map((w) => `${w.title} (${w.year ?? '?'})${tag(w)}`);
    const reviews = m.recent.filter((r) => r.review).slice(0, 8)
      .map((r) => `- ${r.title}${r.rating10 ? ` (${r.rating10}/10)` : ''}${multi ? ` [@${r.user}]` : ''}: „${r.review.slice(0, 260)}”`);

    profile = [
      `Profile Letterboxd (${m.accounts.map((u) => '@' + u).join(', ')}): łącznie ${m.counts.watched} obejrzanych, ${m.counts.watchlist} na watchliście.` +
        (multi ? ' Dane wielu osób — jeśli rekomendacja ma pasować wszystkim, szukaj części wspólnej gustów.' : ''),
      fav.length ? `WYSOKO OCENIONE (8–10/10, to jest gust użytkownika):\n${fav.join('; ')}` : null,
      meh.length ? `NISKO OCENIONE (1–4/10, tego unikać):\n${meh.join('; ')}` : null,
      wl.length ? `WATCHLISTA (te filmy priorytetyzuj):\n${wl.join('; ')}` : null,
      reviews.length ? `OSTATNIE RECENZJE:\n${reviews.join('\n')}` : null,
      `PEŁNA LISTA OBEJRZANYCH (nie polecaj ich, chyba że użytkownik chce powtórkę):\n${m.watched.map((w) => w.title).join('; ')}`,
    ].filter(Boolean).join('\n\n');
  }

  const di = dateInfo(today, today);
  const cinemasTxt = d.cinemas.map((c) => `Cinema City ${c.name}`).join(', ');
  return `Jesteś asystentem serwisu „Co jest grane?” — osobistym doradcą kinowym użytkownika z kartą Cinema City Unlimited.
Użytkownik ogląda repertuar kin: ${cinemasTxt}.

DZIŚ JEST: ${di.dowFull}, ${today}.

ZASADY:
1. Polecasz WYŁĄCZNIE filmy z poniższego repertuaru — nigdy nie wymyślaj tytułów ani seansów.
2. Nie polecaj filmów, które użytkownik już obejrzał (lista niżej) — chyba że wprost poprosi o powtórkę.
3. Filmy z watchlisty traktuj priorytetowo i zawsze zaznaczaj, że są na watchliście.
4. Zawsze wyjaśniaj DLACZEGO film pasuje do gustu użytkownika, odwołując się do jego ocen i recenzji.
5. Rozróżniaj premiery tygodnia od powtórek/retro i mów o tym wprost.
6. Podawaj konkretne seanse: kino, dzień, godzina, format (IMAX/4DX itd.) i wersja językowa.
7. Użytkownik ma kartę Unlimited — koszt nie gra roli, zachęcaj do eksperymentów, ale szanuj jego czas.
8. Jeśli brakuje Ci informacji (nastrój, towarzystwo, dojazd do którego kina) — dopytaj.
9. Odpowiadaj po polsku, zwięźle i konkretnie. Formatuj listami z pogrubieniami, bez tabel.

REPERTUAR (od ${today}, horyzont ${CONTEXT_DAYS} dni; format godzin: HH:MM[FORMAT](wersja)):
${filmLines}

PROFIL FILMOWY:
${profile}`;
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── rozmowa ────────────────────────────────────────────────────── */
function addMessage(kind, text) {
  const log = $('chat-log');
  const msg = el('div', `msg msg-${kind === 'user' ? 'user' : kind}`);
  if (kind === 'ai') msg.innerHTML = renderMarkdownSafe(text); // tekst przeszedł przez escaping
  else msg.textContent = text;
  log.append(msg);
  log.scrollTop = log.scrollHeight;
  return msg;
}

async function send(rawText) {
  const text = String(rawText ?? '').trim().slice(0, 2000);
  if (!text) return;

  $('chat-input').value = '';
  $('chat-send').disabled = true;
  addMessage('user', text);
  const typing = addMessage('ai', '');
  typing.classList.add('msg-typing');
  typing.textContent = 'kinomaniak myśli';

  chatHistory.push({ role: 'user', parts: [{ text }] });

  try {
    const reply = await generate({ system: systemPrompt, contents: chatHistory });
    typing.remove();
    chatHistory.push({ role: 'model', parts: [{ text: reply }] });
    if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
    addMessage('ai', reply);
    logRecommendation({ ts: new Date().toISOString(), question: text, answer: reply });
  } catch (err) {
    typing.remove();
    chatHistory.pop();
    addMessage('err', friendlyGeminiError(err));
  } finally {
    $('chat-send').disabled = false;
    $('chat-input').focus();
  }
}
