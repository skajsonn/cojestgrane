// Asystent AI (Google Gemini). Kontekst budowany jest z lokalnych JSON-ów:
// repertuar + profil Letterboxd. Ten sam kontekst zasila sekcję rekomendacji.

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
  systemPrompt = buildSystemPrompt(data);

  const lb = data.letterboxd;
  $('chat-context-info').textContent = lb
    ? `Kontekst: ${data.repertoire.films.length} filmów z repertuaru · profil @${lb.user} ` +
      `(${lb.counts.watched} obejrzanych, ${lb.counts.watchlist} na watchliście)`
    : `Kontekst: ${data.repertoire.films.length} filmów z repertuaru · brak danych Letterboxd`;

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
    'Cześć! Znam aktualny repertuar Punktu 44 i Silesii oraz Twój profil Letterboxd. ' +
    'Zapytaj mnie, na co warto pójść — powiem Ci też dlaczego.');
}

/* ── budowa kontekstu (współdzielona z rekomendacjami) ──────────── */
export function buildSystemPrompt(d) {
  const today = todayIso();
  const rep = d.repertoire;
  const lb = d.letterboxd;
  const horizon = addDaysIso(today, CONTEXT_DAYS);
  const cinemaName = Object.fromEntries(rep.cinemas.map((c) => [c.id, c.name]));

  const statusPl = {
    premiere: 'PREMIERA TYGODNIA', new: 'nowość', upcoming: 'zapowiedź (przedpremiera)',
    retro: 'POWTÓRKA/RETRO', regular: 'w repertuarze',
  };

  const filmLines = rep.films.map((f) => {
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

    const schedule = [];
    for (const [cid, byDate] of Object.entries(f.showings)) {
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
    const overview = f.tmdb?.overview ? `    Opis: ${f.tmdb.overview.slice(0, 220)}` : null;
    return [head, overview, ...schedule].filter(Boolean).join('\n');
  }).join('\n');

  let profile = 'Brak danych z Letterboxd.';
  if (lb) {
    const rated = lb.watched.filter((w) => w.rating10 != null);
    const fav = rated.filter((w) => w.rating10 >= 8).map((w) => `${w.title} (${w.year ?? '?'}) ${w.rating10}/10`);
    const meh = rated.filter((w) => w.rating10 <= 4).map((w) => `${w.title} ${w.rating10}/10`);
    const wl = lb.watchlist.map((w) => `${w.title} (${w.year ?? '?'})`);
    const reviews = (lb.recent ?? []).filter((r) => r.review).slice(0, 8)
      .map((r) => `- ${r.title}${r.rating10 ? ` (${r.rating10}/10)` : ''}: „${r.review.slice(0, 260)}”`);

    profile = [
      `Profil Letterboxd @${lb.user}: ${lb.counts.watched} obejrzanych, ${lb.counts.watchlist} na watchliście.`,
      fav.length ? `WYSOKO OCENIONE (8–10/10, to jest gust użytkownika):\n${fav.join('; ')}` : null,
      meh.length ? `NISKO OCENIONE (1–4/10, tego unikać):\n${meh.join('; ')}` : null,
      wl.length ? `WATCHLISTA (te filmy priorytetyzuj w rekomendacjach):\n${wl.join('; ')}` : null,
      reviews.length ? `OSTATNIE RECENZJE UŻYTKOWNIKA:\n${reviews.join('\n')}` : null,
      `PEŁNA LISTA OBEJRZANYCH (nie polecaj ich, chyba że użytkownik chce powtórkę):\n${lb.watched.map((w) => w.title).join('; ')}`,
    ].filter(Boolean).join('\n\n');
  }

  const di = dateInfo(today, today);
  return `Jesteś asystentem serwisu „Co jest grane?” — osobistym doradcą kinowym użytkownika z kartą Cinema City Unlimited.
Użytkownik chodzi do dwóch kin w Katowicach: Cinema City Punkt 44 (IMAX, 4DX) i Cinema City Silesia.

DZIŚ JEST: ${di.dowFull}, ${today}.

ZASADY:
1. Polecasz WYŁĄCZNIE filmy z poniższego repertuaru — nigdy nie wymyślaj tytułów ani seansów.
2. Nie polecaj filmów, które użytkownik już obejrzał (lista niżej) — chyba że wprost poprosi o powtórkę.
3. Filmy z watchlisty użytkownika traktuj priorytetowo i zawsze zaznaczaj, że są na jego watchliście.
4. Zawsze wyjaśniaj DLACZEGO film pasuje do gustu użytkownika, odwołując się do jego ocen i recenzji.
5. Rozróżniaj premiery tygodnia od powtórek/retro i mów o tym wprost.
6. Podawaj konkretne seanse: kino, dzień, godzina, format (IMAX/4DX itd.) i wersja językowa.
7. Ma kartę Unlimited — koszt biletu nie gra roli, zachęcaj do eksperymentów, ale szanuj jego czas.
8. Jeśli brakuje Ci informacji o preferencjach w danym kontekście (nastrój, towarzystwo, długość) — dopytaj.
9. Odpowiadaj po polsku, zwięźle i konkretnie. Formatuj listami z pogrubieniami, bez tabel.

REPERTUAR (od ${today}, horyzont ${CONTEXT_DAYS} dni; format godzin: HH:MM[FORMAT](wersja)):
${filmLines}

PROFIL FILMOWY UŻYTKOWNIKA:
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
    // historia w ryzach: ostatnie 20 tur wystarczy
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
