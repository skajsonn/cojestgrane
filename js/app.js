// Punkt wejścia: ładuje dane, inicjalizuje widoki (repertuar, premiery),
// popup asystenta, onboarding przy pierwszym wejściu i odświeżanie profili.

import {
  loadAll, recomputeProfiles, isOnboarded, setOnboarded,
  saveCinemaPrefs, saveActiveAccounts, getActiveAccounts, getBrowserAccounts,
} from './data.js';
import { readCache, cacheFresh, syncAccount } from './letterboxd-client.js';
import { initRepertoire, rerenderGrid } from './ui.js';
import { initAssistant, rebuildContext } from './assistant.js';
import { initSettings, addAccountFlow } from './settings.js';
import { initReco, refresh as refreshReco } from './reco.js';
import { initPremieres, refresh as refreshPremieres } from './premieres.js';
import { el } from './utils.js';

const $ = (id) => document.getElementById(id);

function initNav() {
  const buttons = document.querySelectorAll('.nav-btn[data-view]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.toggle('is-active', b === btn));
      $('view-repertoire').hidden = btn.dataset.view !== 'repertoire';
      $('view-premieres').hidden = btn.dataset.view !== 'premieres';
    });
  });
}

function initChatPopup() {
  const fab = $('chat-fab');
  const panel = $('chat-panel');
  const setOpen = (open) => {
    panel.hidden = !open;
    fab.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', String(open));
    if (open) $('chat-input').focus();
  };
  fab.addEventListener('click', () => setOpen(panel.hidden));
  $('chat-close').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
}

function initDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });
}

/** Po każdej zmianie profili: przelicz dopasowania i odśwież widoki. */
async function profilesChanged(data) {
  await recomputeProfiles(data);
  rerenderGrid();
  refreshReco(data);
  refreshPremieres(data);
  rebuildContext(data);
}

/* ── onboarding (pierwsze wejście) ──────────────────────────────── */
function showOnboarding(data) {
  const dialog = $('onboarding-dialog');

  // 1) kina — wszystkie zaznaczone na start
  const cinemaBox = $('ob-cinemas');
  cinemaBox.replaceChildren();
  for (const c of data.repertoire.cinemas) {
    const label = el('label', 'cinema-item');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c.id;
    cb.checked = true;
    label.append(cb, document.createTextNode(` ${c.name}`));
    label.append(el('span', 'ci-city', c.fullName));
    cinemaBox.append(label);
  }

  // 2) konta — z config + dodawane nickiem
  const accountBox = $('ob-accounts');
  const renderAccounts = () => {
    accountBox.replaceChildren();
    const known = [...new Set([...data.configUsers, ...getBrowserAccounts()])];
    for (const user of known) {
      const label = el('label', 'account-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = user;
      cb.checked = true;
      label.append(cb, document.createTextNode(` @${user}`));
      label.append(el('span', 'ai-src',
        data.configUsers.includes(user) ? 'synchronizacja codzienna' : 'w tej przeglądarce'));
      accountBox.append(label);
    }
    if (!known.length) accountBox.append(el('p', 'hint', 'Brak kont — dopisz swój nick poniżej albo pomiń.'));
  };
  renderAccounts();

  $('ob-add-account').addEventListener('click', async () => {
    const ok = await addAccountFlow($('ob-new-nick'), $('ob-sync-status'), null);
    if (ok) renderAccounts();
  });

  $('ob-done').addEventListener('click', () => {
    const cinemas = [...cinemaBox.querySelectorAll('input:checked')].map((i) => i.value);
    if (cinemas.length) saveCinemaPrefs(cinemas);
    const accounts = [...accountBox.querySelectorAll('input:checked')].map((i) => i.value);
    saveActiveAccounts(accounts);
    setOnboarded();
    dialog.close();
    location.reload(); // czysty start z wybranymi preferencjami
  });

  dialog.showModal();
}

/** Konta przeglądarkowe z przeterminowanym cache — dosynchronizuj w tle. */
async function backgroundRefresh(data) {
  const active = getActiveAccounts([...new Set([...data.configUsers, ...getBrowserAccounts()])]);
  const stale = active.filter((u) => !data.configUsers.includes(u) && !cacheFresh(readCache(u)));
  for (const user of stale) {
    try {
      await syncAccount(user);
      await profilesChanged(data);
    } catch (err) {
      console.warn(`[letterboxd] odświeżenie @${user} nieudane:`, err.message);
    }
  }
}

async function main() {
  initNav();
  initChatPopup();
  initDialogs();

  try {
    const data = await loadAll();
    initRepertoire(data);
    initReco(data);
    initPremieres(data);
    initAssistant(data);
    initSettings(data, { profilesChanged: () => profilesChanged(data) });
    if (data.needsOnboarding) showOnboarding(data);
    else backgroundRefresh(data);
  } catch (err) {
    console.error(err);
    const grid = $('film-grid');
    grid.replaceChildren(
      el('p', 'empty-note',
        'Nie udało się wczytać danych repertuaru. Jeśli to świeże wdrożenie — uruchom ' +
        'workflow „Aktualizacja danych” w zakładce Actions na GitHubie i odśwież stronę.'),
    );
    grid.firstChild.hidden = false;
  }
}

main();
