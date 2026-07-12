// Ustawienia: wybór kin i kont Letterboxd. Preferencje żyją wyłącznie
// w localStorage tej przeglądarki.

import {
  getCinemaPrefs, saveCinemaPrefs,
  getBrowserAccounts, addBrowserAccount, removeBrowserAccount,
  getActiveAccounts, saveActiveAccounts,
} from './data.js';
import { syncAccount, dropCache, USER_RE } from './letterboxd-client.js';

const $ = (id) => document.getElementById(id);
let onProfilesChanged = null; // callback z app.js

/* ── dialog ustawień ────────────────────────────────────────────── */
export function initSettings(data, { profilesChanged } = {}) {
  onProfilesChanged = profilesChanged ?? null;
  const dialog = $('settings-dialog');

  $('btn-settings').addEventListener('click', () => {
    renderCinemas(data);
    renderAccounts(data);
    refreshDataInfo(data);
    dialog.showModal();
  });

  $('set-add-account').addEventListener('click', () => {
    addAccountFlow($('set-new-nick'), $('set-sync-status'), data);
  });

  // stary klucz użytkownika nie jest już potrzebny — sprzątamy po cichu
  localStorage.removeItem('kk_gemini_key');
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
      location.reload(); // pełne przeliczenie widoków
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

/* ── informacje ─────────────────────────────────────────────────── */
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
  lines.push('Dane odświeżają się co 6 godzin. Rekonesans AI: wbudowany asystent strony — bez konfiguracji.');
  $('data-info').textContent = lines.join(' ');
}
