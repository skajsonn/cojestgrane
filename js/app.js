// Punkt wejścia: ładuje dane, inicjalizuje widoki, obsługuje nawigację.

import { loadAll, saveAccount } from './data.js';
import { initRepertoire } from './ui.js';
import { initAssistant } from './assistant.js';
import { initSettings } from './settings.js';
import { initReco } from './reco.js';
import { el } from './utils.js';

const $ = (id) => document.getElementById(id);

function initNav() {
  const buttons = document.querySelectorAll('.nav-btn[data-view]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.toggle('is-active', b === btn));
      $('view-repertoire').hidden = btn.dataset.view !== 'repertoire';
      $('view-assistant').hidden = btn.dataset.view !== 'assistant';
      if (btn.dataset.view === 'assistant') $('chat-input').focus();
    });
  });
}

function initDialogs() {
  for (const dialog of document.querySelectorAll('dialog')) {
    // klik w tło zamyka
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });
}

/** Pierwsze wejście: wybór profilu Letterboxd (zapis w localStorage). */
function showAccountChoice(data) {
  const dialog = $('account-dialog');
  const list = $('account-list');
  list.replaceChildren();

  for (const user of data.users) {
    const btn = el('button', 'account-option');
    btn.type = 'button';
    btn.append(el('span', 'ao-avatar', user[0]));
    const label = el('span');
    label.append(el('span', null, `@${user}`));
    if (user === data.account && data.letterboxd) {
      label.append(el('div', 'ao-meta',
        `${data.letterboxd.counts.watched} obejrzanych · ${data.letterboxd.counts.watchlist} na watchliście`));
    }
    btn.append(label);
    btn.addEventListener('click', () => {
      saveAccount(user);
      dialog.close();
      if (user !== data.account) location.reload(); // inne konto → przeliczenie dopasowań
    });
    list.append(btn);
  }
  dialog.showModal();
}

async function main() {
  initNav();
  initDialogs();

  try {
    const data = await loadAll();
    initRepertoire(data);
    initReco(data);
    initAssistant(data);
    initSettings(data);
    if (data.needsAccountChoice) showAccountChoice(data);
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
