// Ustawienia: klucz Gemini (tylko localStorage tej przeglądarki),
// wybór modelu, dziennik rekomendacji. Żadna z tych danych nie opuszcza
// urządzenia użytkownika (poza wywołaniem API Google jego własnym kluczem).

import { downloadJson } from './utils.js';
import { saveAccount } from './data.js';

const KEY_API = 'kk_gemini_key';
const KEY_MODEL = 'kk_gemini_model';
const KEY_LOG = 'kk_reco_log';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const LOG_LIMIT = 100;

const $ = (id) => document.getElementById(id);

export function getApiKey() {
  return (localStorage.getItem(KEY_API) ?? '').trim() || null;
}

export function getModel() {
  const m = (localStorage.getItem(KEY_MODEL) ?? '').trim();
  // walidacja: identyfikator modelu, nic więcej (trafia do URL-a)
  return /^[a-z0-9.-]{3,60}$/.test(m) ? m : DEFAULT_MODEL;
}

export function logRecommendation(entry) {
  const log = readLog();
  log.push(entry);
  localStorage.setItem(KEY_LOG, JSON.stringify(log.slice(-LOG_LIMIT)));
}

function readLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_LOG) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ── dialog ustawień ────────────────────────────────────────────── */
export function initSettings(data) {
  const dialog = $('settings-dialog');

  $('btn-settings').addEventListener('click', () => {
    $('set-api-key').value = getApiKey() ?? '';
    refreshModelSelect([getModel()]);
    refreshAccountSelect(data);
    refreshLogInfo();
    refreshDataInfo(data);
    dialog.showModal();
  });

  $('set-lb-user').addEventListener('change', (e) => {
    saveAccount(e.target.value);
    location.reload(); // przeliczenie dopasowań i kontekstu asystenta
  });

  $('btn-test-key').addEventListener('click', saveAndTestKey);
  $('btn-forget-key').addEventListener('click', () => {
    localStorage.removeItem(KEY_API);
    $('set-api-key').value = '';
    setKeyStatus('Klucz usunięty z tej przeglądarki.', 'ok');
  });

  $('set-model').addEventListener('change', (e) => {
    localStorage.setItem(KEY_MODEL, e.target.value);
  });

  $('btn-export-log').addEventListener('click', () => {
    downloadJson('cojestgrane-rekomendacje.json', readLog());
  });
  $('btn-clear-log').addEventListener('click', () => {
    localStorage.removeItem(KEY_LOG);
    refreshLogInfo();
  });
}

function setKeyStatus(text, cls) {
  const s = $('key-status');
  s.textContent = text;
  s.className = `hint ${cls ?? ''}`;
}

function refreshModelSelect(models) {
  const sel = $('set-model');
  sel.replaceChildren();
  const current = getModel();
  const list = [...new Set([current, DEFAULT_MODEL, ...models])];
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === current) opt.selected = true;
    sel.append(opt);
  }
}

/**
 * Zapisuje klucz i robi próbne wywołanie ListModels — przy okazji
 * wypełnia listę modeli dostępnych dla tego klucza.
 */
async function saveAndTestKey() {
  const key = $('set-api-key').value.trim();
  // stary format: AIza… (39 znaków), nowy: AQ.… (z kropką)
  if (!/^[A-Za-z0-9._-]{20,120}$/.test(key)) {
    setKeyStatus('To nie wygląda na klucz API (oczekiwany format: AIza… lub AQ.…).', 'bad');
    return;
  }
  localStorage.setItem(KEY_API, key);
  setKeyStatus('Sprawdzam klucz…');

  try {
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=50',
      { headers: { 'x-goog-api-key': key } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .filter((m) => /^gemini/.test(m) && !/embedding|vision$|-tts|image|live|audio/.test(m));
    refreshModelSelect(models);
    setKeyStatus(`Klucz działa. Dostępnych modeli: ${models.length}. Zapisano.`, 'ok');
  } catch (err) {
    setKeyStatus(`Klucz zapisany, ale test nie przeszedł (${err.message}). Sprawdź klucz w aistudio.google.com.`, 'bad');
  }
}

function refreshAccountSelect(data) {
  const sel = $('set-lb-user');
  sel.replaceChildren();
  const users = data?.users ?? [];
  if (!users.length) {
    const opt = document.createElement('option');
    opt.textContent = 'brak zsynchronizowanych kont';
    opt.disabled = true;
    opt.selected = true;
    sel.append(opt);
    sel.disabled = true;
    return;
  }
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = `@${u}`;
    if (u === data.account) opt.selected = true;
    sel.append(opt);
  }
}

function refreshLogInfo() {
  const log = readLog();
  $('log-info').textContent = log.length
    ? `Zapisanych rozmów z asystentem: ${log.length} (maks. ${LOG_LIMIT}, tylko w tej przeglądarce).`
    : 'Dziennik jest pusty — rozmowy z asystentem zapisują się tutaj automatycznie.';
}

function refreshDataInfo(data) {
  const rep = data?.repertoire;
  const lb = data?.letterboxd;
  const lines = [];
  if (rep) {
    lines.push(`Repertuar: ${rep.films.length} filmów, aktualizacja ${new Date(rep.generatedAt).toLocaleString('pl-PL')}.`);
  }
  lines.push(lb
    ? `Letterboxd @${lb.user}: ${lb.counts.watched} obejrzanych, ${lb.counts.watchlist} na watchliście, synchronizacja ${new Date(lb.generatedAt).toLocaleString('pl-PL')}.`
    : 'Letterboxd: brak danych (uruchom workflow „Aktualizacja danych”).');
  lines.push('Dane odświeża codziennie GitHub Actions — patrz README.');
  $('data-info').textContent = lines.join(' ');
}
