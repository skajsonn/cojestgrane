// Sekcja „Warto iść” — pionowa lista rekomendacji z uzasadnieniami.
// Bez klucza Gemini: ranking heurystyczny (watchlista > premiery > oceny TMDB).
// Z kluczem: rekomendacje układa AI na tym samym kontekście co asystent
// (JSON), cache w localStorage — jedno zapytanie na dzień/aktualizację danych.

import { el, normalizeTitle, todayIso, dateInfo } from './utils.js';
import { fmtLabel, genreLabel, STATUS_INFO } from './labels.js';
import { openFilmDialog, posterEl } from './ui.js';
import { buildSystemPrompt } from './assistant.js';
import { generate, hasApiKey } from './gemini.js';
import { getModel } from './settings.js';

const KEY_CACHE = 'kk_reco_cache';
const MAX_RECOS = 5;
const WINDOW_DAYS = 7;

let data = null;
const $ = (id) => document.getElementById(id);

export function initReco(loadedData) {
  data = loadedData;
  $('reco-refresh').addEventListener('click', () => refreshAi(true));
  refresh(loadedData);
}

/** Odświeżenie po zmianie profili (bez przeładowania strony). */
export function refresh(loadedData) {
  data = loadedData;
  const cached = readCache();
  if (cached) {
    render(cached.items, cached.mode);
  } else {
    render(heuristic(), 'heur');
    if (hasApiKey()) refreshAi(false); // auto: 1 zapytanie dziennie, po cichu
  }
}

/* ── kandydaci: grają w ciągu 7 dni w preferowanych kinach ──────── */
function candidates() {
  const today = todayIso();
  const horizon = addDaysIso(today, WINDOW_DAYS);
  return data.repertoire.films.filter((f) => {
    if (f.lbWatched) return false;
    for (const [cid, byDate] of Object.entries(f.showings)) {
      if (!data.cinemaSet.has(cid)) continue;
      for (const d of Object.keys(byDate)) {
        if (d >= today && d <= horizon) return true;
      }
    }
    return false;
  });
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── heurystyka ─────────────────────────────────────────────────── */
function heuristic() {
  const scored = candidates().map((f) => {
    let score = 0;
    const why = [];
    if (f.lbWatchlisted) { score += 100; why.push('jest na Twojej watchliście'); }
    if (f.status === 'premiere') { score += 25; why.push('premiera tygodnia'); }
    if (f.status === 'new') { score += 10; why.push('nowość w repertuarze'); }
    if (f.status === 'retro') { score += 8; why.push('kinowa powtórka klasyki'); }
    if (f.tmdb?.voteAverage >= 6.5) { score += f.tmdb.voteAverage * 3; why.push(`dobre oceny widzów (TMDB ${f.tmdb.voteAverage})`); }
    const bigFormats = f.formats.filter((x) => ['imax', '4dx', 'screenx'].includes(x));
    if (bigFormats.length) { score += 6; why.push(`do zobaczenia w ${bigFormats.map(fmtLabel).join(' i ')}`); }
    return { film: f, score, why: capitalize(why.join(', ')) + '.' };
  });
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECOS)
    .map((r) => ({ title: r.film.title, why: r.why, when: nextShowing(r.film) }));
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function nextShowing(film) {
  const today = todayIso();
  const cinemaName = Object.fromEntries(data.cinemas.map((c) => [c.id, c.name]));
  let best = null;
  for (const [cid, byDate] of Object.entries(film.showings)) {
    if (!data.cinemaSet.has(cid)) continue;
    for (const d of Object.keys(byDate)) {
      if (d < today) continue;
      for (const s of byDate[d]) {
        const key = `${d} ${s.time}`;
        if (!best || key < best.key) {
          const di = dateInfo(d, today);
          best = {
            key,
            txt: `najbliższy seans: ${di.isToday ? 'dziś' : di.dowFull + ' ' + di.dayMonth} ` +
              `${s.time}, ${cinemaName[cid]}${s.formats.length ? ' (' + s.formats.map(fmtLabel).join(', ') + ')' : ''}`,
          };
        }
      }
    }
  }
  return best?.txt ?? '';
}

/* ── AI ─────────────────────────────────────────────────────────── */
function cacheKey() {
  return [
    data.repertoire.generatedAt,
    data.merged.accounts.join('+') || '-',
    [...data.cinemaSet].sort().join('+'),
    getModel(),
  ].join('|');
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY_CACHE) ?? 'null');
    return c && c.key === cacheKey() && Array.isArray(c.items) ? c : null;
  } catch { return null; }
}

async function refreshAi(manual) {
  if (!hasApiKey()) {
    if (manual) setNote('Rekomendacje AI wymagają darmowego klucza Gemini — dodasz go w Ustawieniach (⚙). Na razie pokazuję ranking wg Twojej watchlisty i ocen.');
    return;
  }
  setNote('✨ Asystent układa rekomendacje…');
  $('reco-refresh').disabled = true;
  try {
    const prompt =
      `Wybierz maksymalnie ${MAX_RECOS} filmów z repertuaru, na które temu użytkownikowi najbardziej warto pójść ` +
      `w ciągu najbliższych ${WINDOW_DAYS} dni. Tylko filmy, które mają seanse w tym oknie (pomiń zapowiedzi bez seansów). ` +
      `Nie proponuj obejrzanych. Priorytet: watchlista, potem dopasowanie do gustu. ` +
      `Zwróć WYŁĄCZNIE tablicę JSON obiektów: ` +
      `{"title": dokładny polski tytuł z repertuaru, ` +
      `"why": 2–3 zdania po polsku dlaczego ten film dla niego — odwołaj się konkretnie do jego ocen, recenzji lub watchlisty, ` +
      `"when": najlepszy konkretny seans (dzień, godzina, kino, format)}. Bez markdownu, bez komentarzy.`;
    const raw = await generate({
      system: buildSystemPrompt(data),
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      json: true,
      temperature: 0.6,
      maxTokens: 2000,
    });
    const items = sanitize(JSON.parse(raw));
    if (!items.length) throw new Error('pusta lista');
    localStorage.setItem(KEY_CACHE, JSON.stringify({ key: cacheKey(), ts: Date.now(), mode: 'ai', items }));
    render(items, 'ai');
  } catch (err) {
    if (manual) setNote(`Nie udało się pobrać rekomendacji AI (${err.message}). Pokazuję ranking lokalny.`);
    else setNote('');
    render(heuristic(), 'heur');
  } finally {
    $('reco-refresh').disabled = false;
  }
}

/** Walidacja odpowiedzi modelu: tylko znane pola, tylko filmy z repertuaru. */
function sanitize(parsed) {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((it) => it && typeof it.title === 'string')
    .map((it) => ({
      title: it.title.slice(0, 120),
      why: typeof it.why === 'string' ? it.why.slice(0, 500) : '',
      when: typeof it.when === 'string' ? it.when.slice(0, 160) : '',
    }))
    .filter((it) => findFilm(it.title))
    .slice(0, MAX_RECOS);
}

function findFilm(title) {
  const norm = normalizeTitle(title);
  return data.repertoire.films.find(
    (f) => normalizeTitle(f.title) === norm ||
           (f.originalTitle && normalizeTitle(f.originalTitle) === norm),
  ) ?? null;
}

/* ── render (pionowa lista) ─────────────────────────────────────── */
function setNote(text) {
  $('reco-note').textContent = text ?? '';
}

function render(items, mode) {
  const list = $('reco-list');
  list.replaceChildren();

  if (!items.length) {
    setNote('Brak rekomendacji — wszystko, co gra, już widziałeś? Zajrzyj do pełnego repertuaru niżej.');
    return;
  }
  setNote(mode === 'ai'
    ? '✨ Ułożone przez asystenta AI na bazie Twojego profilu Letterboxd.'
    : 'Ranking wg Twojej watchlisty, premier i ocen — klucz Gemini w Ustawieniach włączy pełne rekomendacje AI.');

  items.forEach((it, i) => {
    const film = findFilm(it.title);
    if (!film) return;
    const card = el('article', 'reco-card');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Szczegóły filmu ${film.title}`);

    card.append(el('span', 'reco-rank', String(i + 1)));

    const thumb = el('div', 'reco-thumb');
    const src = film.poster ?? film.tmdb?.poster;
    if (src) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = src;
      thumb.append(img);
    } else {
      thumb.append(el('div', 'poster-fallback', '🎞'));
    }
    card.append(thumb);

    const bodyEl = el('div', 'reco-body');
    const titleRow = el('div', 'reco-title-row');
    titleRow.append(el('h3', 'reco-title', film.title));
    const st = STATUS_INFO[film.status];
    if (st) titleRow.append(el('span', `badge-inline ${st.cls}`, st.label));
    if (film.lbWatchlisted) titleRow.append(el('span', 'badge-inline badge-wl', '☆ watchlista'));
    bodyEl.append(titleRow);

    const metaBits = [];
    if (film.year) metaBits.push(film.year);
    if (film.length) metaBits.push(`${film.length} min`);
    if (film.genres.length) metaBits.push(film.genres.slice(0, 3).map(genreLabel).join(', '));
    if (film.tmdb?.voteAverage) metaBits.push(`★ ${film.tmdb.voteAverage.toFixed(1)} TMDB`);
    if (metaBits.length) bodyEl.append(el('p', 'reco-meta', metaBits.join(' · ')));

    if (it.why) bodyEl.append(el('p', 'reco-why', it.why));
    if (it.when) bodyEl.append(el('p', 'reco-when', it.when));
    card.append(bodyEl);

    const open = () => openFilmDialog(film);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    list.append(card);
  });
}
