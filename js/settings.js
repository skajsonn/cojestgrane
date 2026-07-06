// Ustawienia: kina, konta Letterboxd, klucz Gemini (tylko localStorage),
// wybór modelu, dziennik rekomendacji. Żadna z tych danych nie opuszcza
// urządzenia użytkownika (poza wywołaniami API Google jego własnym kluczem).

import { downloadJson } from './utils.js';
import {
  getCinemaPrefs, saveCinemaPrefs,
  getBrowserAccounts, addBrowserAccount, removeBrowserAccount,
  getActiveAccounts, saveActiveAccounts,
} from './data.js';
import { syncAccount, dropCache, USER_RE } from './letterboxd-client.js';

const KEY_API = 'kk_gemini_key';
const KEY_MODEL = 'kk_gemini_model';
const KEY_LOG = 'kk_reco_log';
const DEFAULT_MODEL = 'gemini-2.5-flash';
// Limit istnieje, bo dziennik żyje w localStorage (~5 MB na całą domenę,
// dzielone z cache'ami profili). 500 rozmów to bezpieczny kompromis.
const LOG_LIMIT = 500;

const $ = (id) => document.getElementById(id);
let onProfilesChanged = null; // callback z app.js

export function getApiKey() {
  return (localStorage.getItem(KEY_API) ?? '').trim() || null;
}

export function getModel() {
  const m = (localStorage.getItem(KEY_MODEL) ?? '').trim();
  return /^[a-z0-9.-]{3,60}$/.test(m) ? m : DEFAULT_MODEL;
}

export function logRecommendation(entry) {
  const log = readLog();
  log.push(entry);
  try {
    localStorage.setItem(KEY_LOG, JSON.stringify(log.slice(-LOG_LIMIT)));
  } catch {
    localStorage.setItem(KEY_LOG, JSON.stringify(log.slice(-50))); // awaryjnie: mniej
  }
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
export function initSettings(data, { profilesChanged } = {}) {
  onProfilesChanged = profilesChanged ?? null;
  const dialog = $('settings-dialog');

  $('btn-settings').addEventListener('click', () => {
    $('set-api-key').value = getApiKey() ?? '';
    refreshModelSelect([getModel()]);
    renderCinemas(data);
    renderAccounts(data);
    refreshLogInfo();
    refreshDataInfo(data);
    dialog.showModal();
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

  $('set-add-account').addEventListener('click', () => {
    addAccountFlow($('set-new-nick'), $('set-sync-status'), data);
  });

  $('btn-export-log').addEventListener('click', () => {
    downloadJson('cojestgrane-rekomendacje.json', readLog());
  });
  $('btn-clear-log').addEventListener('click', () => {
    localStorage.removeItem(KEY_LOG);
    refreshLogInfo();
  });
}

/* ── kina ───────────────────────────────────────────────────────── */
function renderCinemas(data) {
  const box = $('set-cinemas');
  box.replaceChildren();
  const all = data.repertoire.cinemas;
  const prefs = getCinemaPrefs(all.map((c) => c.id));

  for (const c of all) {
    const label = document.createElement('label');
    label.className = 'cinema-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = prefs.includes(c.id);
    cb.addEventListener('change', () => {
      const checked = [...box.querySelectorAll('input:checked')].map((i) => i.value);
      if (!checked.length) { cb.checked = true; return; } // min. 1 kino
      saveCinemaPrefs(checked);
      location.reload(); // pełne przeliczenie widoków i kontekstu AI
    });
    label.append(cb, document.createTextNode(` ${c.name}`));
    label.append(Object.assign(document.createElement('span'), { className: 'ci-city', textContent: c.fullName }));
    box.append(label);
  }
}

/* ── konta Letterboxd ───────────────────────────────────────────── */
function renderAccounts(data) {
  const box = $('set-accounts');
  box.replaceChildren();
  const browser = getBrowserAccounts();
  const known = [...new Set([...data.configUsers, ...browser])];
  const active = getActiveAccounts(known);

  for (const user of known) {
    const item = document.createElement('label');
    item.className = 'account-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = user;
    cb.checked = active.includes(user);
    cb.addEventListener('change', async () => {
      const checked = [...box.querySelectorAll('input:checked')].map((i) => i.value);
      saveActiveAccounts(checked);
      await onProfilesChanged?.();
      refreshDataInfo(data);
    });
    item.append(cb, document.createTextNode(` @${user}`));

    const src = document.createElement('span');
    src.className = 'ai-src';
    src.textContent = data.configUsers.includes(user) ? 'synchronizacja codzienna' : 'w tej przeglądarce';
    item.append(src);

    if (!data.configUsers.includes(user)) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ai-remove';
      rm.textContent = '✕';
      rm.title = 'Usuń konto z przeglądarki';
      rm.addEventListener('click', async (e) => {
        e.preventDefault();
        removeBrowserAccount(user);
        dropCache(user);
        renderAccounts(data);
        await onProfilesChanged?.();
        refreshDataInfo(data);
      });
      item.append(rm);
    }
    box.append(item);
  }
}

/** Wspólny przepływ dodawania konta (ustawienia i onboarding). */
export async function addAccountFlow(input, statusEl, data) {
  const nick = input.value.trim().replace(/^@/, '');
  if (!USER_RE.test(nick)) {
    statusEl.textContent = 'Nick może zawierać litery, cyfry i podkreślenia (2–30 znaków).';
    return false;
  }
  input.disabled = true;
  try {
    await syncAccount(nick, (msg) => { statusEl.textContent = msg; });
    addBrowserAccount(nick);
    saveActiveAccounts([...new Set([...getActiveAccounts(), nick])]);
    input.value = '';
    if (data) renderAccounts(data);
    await onProfilesChanged?.();
    if (data) refreshDataInfo(data);
    return true;
  } catch (err) {
    statusEl.textContent = `Nie udało się: ${err.message}`;
    return false;
  } finally {
    input.disabled = false;
  }
}

/* ── klucz / model ──────────────────────────────────────────────── */
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

/* ── informacje ─────────────────────────────────────────────────── */
function refreshLogInfo() {
  const log = readLog();
  $('log-info').textContent = (log.length
    ? `Zapisanych rozmów: ${log.length} z maks. ${LOG_LIMIT}. `
    : 'Dziennik jest pusty — rozmowy z asystentem zapisują się tutaj automatycznie. ')
    + `Limit wynika z pojemności pamięci przeglądarki (localStorage, ~5 MB wspólne dla całej strony) — `
    + `najstarsze wpisy ustępują nowym; eksportuj, jeśli chcesz zachować historię na zawsze.`;
}

function refreshDataInfo(data) {
  const rep = data?.repertoire;
  const m = data?.merged;
  const lines = [];
  if (rep) {
    lines.push(`Repertuar: ${rep.films.length} filmów z ${rep.cinemas.length} kin, aktualizacja ${new Date(rep.generatedAt).toLocaleString('pl-PL')}.`);
  }
  lines.push(m?.accounts?.length
    ? `Aktywne profile: ${m.accounts.map((u) => '@' + u).join(', ')} — łącznie ${m.counts.watched} obejrzanych, ${m.counts.watchlist} na watchliście.`
    : 'Brak aktywnych profili Letterboxd.');
  lines.push('Repertuar odświeża codziennie GitHub Actions (~5:45).');
  $('data-info').textContent = lines.join(' ');
}
