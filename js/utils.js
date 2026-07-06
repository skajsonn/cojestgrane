// Narzędzia wspólne frontendu. Wszystkie dane dynamiczne przechodzą
// przez escapeHtml/textContent — nic z API nie trafia surowo do DOM.

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Tworzy element z klasą i (bezpiecznie, przez textContent) tekstem. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Ta sama normalizacja co w skryptach backendowych — musi być identyczna. */
export function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const DOW = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
const DOW_FULL = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

export function dateInfo(iso, todayIso) {
  const d = new Date(iso + 'T12:00:00');
  return {
    iso,
    dow: DOW[d.getDay()],
    dowFull: DOW_FULL[d.getDay()],
    dayMonth: `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`,
    isToday: iso === todayIso,
    label: iso === todayIso ? 'dziś' : DOW[d.getDay()],
  };
}

export function todayIso() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

/** Aktualna godzina w Warszawie jako "HH:MM" (porównywalna leksykalnie). */
export function nowWarsawHM() {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

/** Czy seans o danej dacie/godzinie już się rozpoczął. */
export function isPastShowing(dateIso, timeHM, today = todayIso(), now = nowWarsawHM()) {
  return dateIso < today || (dateIso === today && timeHM <= now);
}

/**
 * Minimalny, bezpieczny renderer odpowiedzi asystenta:
 * najpierw pełny escaping, dopiero potem **pogrubienie**, *kursywa*,
 * listy "- " i akapity. Żadnego surowego HTML z modelu.
 */
export function renderMarkdownSafe(text) {
  const esc = escapeHtml(text);
  const blocks = esc.split(/\n{2,}/);
  const html = blocks.map((block) => {
    const lines = block.split('\n');
    const isList = lines.every((l) => /^\s*[-*•]\s+/.test(l) || l.trim() === '');
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
    if (isList) {
      const items = lines.filter((l) => l.trim()).map((l) => `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`);
      return `<ul>${items.join('')}</ul>`;
    }
    return `<p>${inline(block).replace(/\n/g, '<br>')}</p>`;
  });
  return html.join('');
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
