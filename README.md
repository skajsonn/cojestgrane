# 🎬 Co jest grane? — [cojestgrane.me](https://cojestgrane.me)

Osobisty asystent kinowy dla **Cinema City Katowice — Punkt 44 i Silesia**.
Codziennie pobiera aktualny repertuar obu kin, łączy go z Twoim profilem
**Letterboxd** i pozwala rozmawiać z asystentem AI (**Gemini**), który wie,
co już obejrzałeś, co masz na watchliście i jaki masz gust.

**Stack:** czysty HTML/CSS/JS (zero zależności npm) · GitHub Pages · GitHub Actions · Gemini API · TMDB (opcjonalnie)

---

## Jak to działa

```
                     codziennie 03:45 UTC (GitHub Actions)
  ┌──────────────────────────────────────────────────────────────┐
  │  scripts/fetch-repertoire.mjs                                │
  │    Cinema City API (Punkt 44 #1065, Silesia #1079)           │
  │    + TMDB (tytuły oryginalne, opisy, oceny — opcjonalnie)    │
  │  scripts/sync-letterboxd.mjs                                 │
  │    publiczny profil Letterboxd (obejrzane, oceny, watchlista)│
  └───────────────┬──────────────────────────────────────────────┘
                  │ commit data/*.json
                  ▼
   GitHub Pages (statyczny frontend, index.html + js/ + css/)
                  │
                  ▼ w przeglądarce
   Asystent AI → Gemini API (Twój darmowy klucz, tylko w localStorage)
```

- **Repertuar** — publiczne API Cinema City (`cinema-city.pl/pl/data-api-service/...`),
  bez klucza. Pobierane są wszystkie dostępne daty (zwykle ~4 tygodnie do przodu):
  tytuły, godziny, sale, formaty (IMAX, 4DX, 3D, Laser…), wersje językowe
  (napisy/dubbing), linki do kupna biletów i **plakaty** (`posterLink`).
- **Premiera vs powtórka** — klasyfikacja na podstawie `releaseDate`/`releaseYear`
  z API: `premiera` (do 7 dni od premiery), `nowość` (do 21 dni), `zapowiedź`
  (przedpremiera), `powtórka/retro` (filmy sprzed ≥2 lat, np. seanse klasyki).
- **Letterboxd** — profile są publiczne, więc synchronizacja nie wymaga
  logowania ani tokenów: skrypt czyta strony `letterboxd.com/USER/films/`
  (wszystkie obejrzane + oceny), `/watchlist/` i kanał RSS (ostatnia aktywność
  + recenzje). Przez `curl`, bo Cloudflare odrzuca fetch Node'a po fingerprincie TLS.
  Można zsynchronizować **wiele kont** (`letterboxdUsers` w config.json) —
  aktywny profil wybiera się przy pierwszym wejściu na stronę lub w Ustawieniach
  (zapamiętywany w localStorage przeglądarki).
- **Dopasowanie repertuaru do profilu** — Cinema City używa polskich tytułów,
  a Letterboxd oryginalnych, więc skrypt mapuje każdy film przez **wyszukiwarkę
  Letterboxd** (indeksuje tytuły alternatywne, w tym polskie) na kanoniczny slug
  i tytuł oryginalny (cache w `data/lb-map.json`, bez żadnego klucza). Dzięki temu
  oznaczenia „✓ obejrzane” / „☆ watchlista” i filtr „ukryj obejrzane” działają
  po identyfikatorze, nie po kruchym porównywaniu tytułów.
- **Rekomendacje „Warto iść”** — sekcja na górze strony. Bez klucza Gemini:
  lokalny ranking (watchlista > premiery > oceny TMDB > formaty premium).
  Z kluczem: rekomendacje układa AI na tym samym kontekście co asystent
  (repertuar + profil), z uzasadnieniem i konkretnym seansem; wynik jest
  cache'owany w przeglądarce — jedno zapytanie na dzień/aktualizację danych.
- **Baza danych** — pliki JSON w repozytorium (`data/`), wersjonowane gitem:
  `repertoire.json` (aktualny repertuar), `letterboxd/<nick>.json` + `letterboxd/index.json`
  (profile), `history.json` (dzienne archiwum repertuaru), `films-history.json`
  (kiedy film pojawił się pierwszy raz), `lb-map.json` (mapowanie CC↔Letterboxd),
  `tmdb-cache.json` (cache zapytań TMDB).
- **Asystent AI** — frontend wysyła do Gemini kontekst zbudowany lokalnie
  (repertuar na 14 dni + Twoje oceny/watchlista/recenzje) i egzekwuje zasady:
  nie poleca obejrzanych, priorytetyzuje watchlistę, uzasadnia rekomendacje,
  podaje konkretne seanse. Dziennik rozmów zapisuje się w localStorage
  (eksport/kasowanie w Ustawieniach).

---

## Wdrożenie na GitHub (ok. 10 minut)

### 1. Utwórz repozytorium i wypchnij kod

```bash
git init -b main
git add .
git commit -m "Co jest grane? — start"
gh repo create cojestgrane --public --source=. --push
# albo ręcznie: utwórz repo na github.com i git remote add origin … && git push
```

Repozytorium **może być publiczne** — w kodzie nie ma żadnych sekretów
(patrz sekcja Bezpieczeństwo). Uwaga: na darmowym planie GitHub **Pages wymaga
publicznego repo**.

### 2. Włącz GitHub Pages + domena cojestgrane.me

1. Repo → **Settings → Pages** → Source: **Deploy from a branch** →
   Branch: `main`, folder `/ (root)` → Save.
2. Na tej samej stronie w **Custom domain** wpisz `cojestgrane.me` → Save
   (plik [CNAME](CNAME) w repo już to utrwala między deployami).
3. W Namecheap (Domain List → cojestgrane.me → **Advanced DNS**) usuń domyślne
   rekordy parkingowe i dodaj:

   | Type  | Host | Value |
   |-------|------|-------|
   | A     | @    | 185.199.108.153 |
   | A     | @    | 185.199.109.153 |
   | A     | @    | 185.199.110.153 |
   | A     | @    | 185.199.111.153 |
   | CNAME | www  | `TWOJLOGIN.github.io.` |

4. Po propagacji DNS (zwykle minuty, do 24 h) wróć do Settings → Pages,
   poczekaj aż zniknie ostrzeżenie o DNS i zaznacz **Enforce HTTPS**
   (certyfikat wystawia się automatycznie).

### 3. (Opcjonalnie, zalecane) Dodaj klucz TMDB

Bez niego wszystko działa (plakaty są z Cinema City), ale TMDB dodaje
**tytuły oryginalne, opisy, oceny i lepsze dopasowanie do Letterboxd**
(Letterboxd używa tytułów oryginalnych, Cinema City — polskich).

1. Załóż darmowe konto na [themoviedb.org](https://www.themoviedb.org/) →
   Settings → API → skopiuj **API Key (v3 auth)**.
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   nazwa `TMDB_API_KEY`, wartość: Twój klucz.

### 4. Uruchom pierwszą aktualizację danych

Repo → **Actions** → workflow **„Aktualizacja danych”** → **Run workflow**.
(Później uruchamia się sam, codziennie ~05:45 czasu polskiego.)
W repo są już dane startowe z dnia utworzenia projektu, więc strona działa od razu.

### 5. Dodaj klucz Gemini (w przeglądarce, nie w repo!)

1. Wejdź na [aistudio.google.com](https://aistudio.google.com/) → **Get API key**
   → utwórz darmowy klucz.
2. Na stronie aplikacji: **⚙ Ustawienia** → wklej klucz → **Zapisz i przetestuj**.

Klucz zapisuje się **wyłącznie w localStorage Twojej przeglądarki** i jest
wysyłany tylko do API Google. Nigdy nie trafia do repozytorium.

> **Wskazówka:** w [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
> możesz ograniczyć klucz do domeny `https://cojestgrane.me/*`
> (Application restrictions → Websites) — wtedy nawet wyciek klucza jest bezużyteczny.

### Konta Letterboxd / kina

Wszystko w [config.json](config.json): lista kont Letterboxd (`letterboxdUsers`
— każde musi być publiczne; wszystkie synchronizują się codziennie), lista kin
(ID z API Cinema City), horyzont dni. Aktywny profil wybierasz w przeglądarce:
przy pierwszym wejściu lub w Ustawieniach (⚙) — wybór trzymany w localStorage.

---

## Decyzje techniczne (i dlaczego)

### Gemini zamiast OpenAI

| | **Gemini (wybrane)** | OpenAI |
|---|---|---|
| Koszt API | **0 zł** — darmowy poziom w Google AI Studio | brak darmowego poziomu; płatność za tokeny |
| Subskrypcja a API | subskrypcja Gemini Pro nie jest potrzebna do API | ChatGPT Pro **nie zawiera** kredytów API |
| Limity darmowe | dla `gemini-2.5-flash`: setki zapytań dziennie — dużo ponad potrzeby 1 osoby | n/d |
| Okno kontekstu | 1M tokenów — cały repertuar + profil wchodzi bez RAG | 128k+ (wystarczyłoby, ale płatnie) |
| Integracja | czysty REST z przeglądarki, bez SDK | wymaga backendu-proxy lub płatnego klucza w przeglądarce |

Twoje subskrypcje (ChatGPT Pro, Gemini Pro) to produkty konsumenckie — **żadna
nie daje dostępu do API**. Jedyna realnie darmowa droga to klucz z Google AI
Studio, dlatego Gemini. Model domyślny: `gemini-2.5-flash` (szybki, darmowy,
w zupełności wystarcza do rekomendacji); w Ustawieniach można wybrać każdy
model dostępny dla Twojego klucza.

### JSON w repozytorium zamiast Supabase/SQLite

- **Zero dodatkowych kont, tokenów i punktów awarii** — dane żyją tam, gdzie kod.
- **Git = darmowa historia bazy**: każda dzienna aktualizacja to commit; pełny
  audyt zmian repertuaru za darmo. Dodatkowo `history.json` trzyma kompaktowe
  archiwum dzienne do szybkiego odczytu.
- Skala danych (~42 filmy, ~800 seansów, ~300 wpisów Letterboxd) to setki KB —
  relacyjna baza to armata na wróbla.
- Supabase free tier **pauzuje projekty po tygodniu nieaktywności**; SQLite jako
  plik binarny w repo psuje diffy i niczego tu nie daje.
- Frontend czyta JSON-y bezpośrednio — brak API pośredniego = brak powierzchni ataku.

### GitHub Pages + Actions zamiast Next.js/Vercel

Aplikacja nie potrzebuje serwera: dane zmieniają się raz dziennie (cron), a
jedyna dynamiczna rzecz — rozmowa z AI — idzie prosto z przeglądarki do Google.
Statyczny frontend bez kroku budowania i bez zależności npm oznacza: brak
podatności łańcucha dostaw, deploy = `git push`, zero kosztów i konfiguracji.

### Skąd plakaty

1. **Cinema City API** (`posterLink`) — podstawowe źródło, zawsze aktualne;
2. **TMDB** — fallback + grafiki `backdrop` (jeśli skonfigurujesz klucz).

### Integracja Letterboxd — dlaczego scraping publicznego profilu

Letterboxd nie ma otwartego API (oficjalne jest tylko dla partnerów). Do wyboru:
ręczny eksport ZIP (odpada — chcemy automatu), RSS (tylko ostatnie ~50 wpisów)
albo publiczne strony profilu. Skrypt łączy **strony profilu** (pełna historia
i watchlista) z **RSS** (świeża aktywność + recenzje). Bez logowania, bez
tokenów, z szanującym serwis tempem (~2 żądania/s, raz dziennie).
Filmweb celowo pominięty: brak API, scraping wymaga sesji i łamie regulamin.

---

## Bezpieczeństwo

- **Sekrety:** klucz TMDB tylko w GitHub Secrets (nigdy w kodzie); klucz Gemini
  tylko w localStorage użytkownika (nigdy w repo); API Cinema City i Letterboxd
  nie wymagają uwierzytelnienia. W repozytorium nie ma **żadnych** danych wrażliwych.
- **XSS:** wszystkie dane z zewnątrz (tytuły, opisy, odpowiedzi AI) przechodzą
  przez `textContent`/escaping; odpowiedzi asystenta renderuje własny minimalny
  parser Markdown działający **po** escapingu. Do tego restrykcyjny
  **Content-Security-Policy** (skrypty tylko własne, połączenia tylko do API
  Google, obrazy tylko z zaufanych hostów, `object-src 'none'`).
- **CSRF:** brak — aplikacja nie ma sesji, cookies ani formularzy do własnego
  backendu; jedyne żądania uwierzytelnione (Gemini) używają nagłówka z kluczem.
- **Walidacja wejścia:** skrypty Actions walidują kształt odpowiedzi API,
  nick Letterboxd (regex), URL-e (tylko `https:`) i nie nadpisują dobrych danych
  pustymi przy awarii źródła; frontend waliduje identyfikator modelu i klucz API
  przed użyciem, linki zewnętrzne dostają `rel="noopener noreferrer"`.
- **Łańcuch dostaw:** zero zależności npm (skrypty i frontend to czysty
  Node/vanilla JS); jedyne zewnętrzne zasoby frontendu to Google Fonts
  (ograniczone przez CSP).

## Rozwój lokalny

```bash
# dane (Node ≥ 20; opcjonalnie: export TMDB_API_KEY=…)
node scripts/fetch-repertoire.mjs
node scripts/sync-letterboxd.mjs

# frontend — dowolny statyczny serwer, np.:
python -m http.server 8000
# → http://localhost:8000
```

## Struktura

```
index.html            aplikacja (jedna strona)
css/style.css         styl: ambient noir, RWD
js/                   moduły ES: app, data, ui, assistant, settings, labels, utils
scripts/              fetch-repertoire.mjs, sync-letterboxd.mjs, util.mjs (Node, bez npm)
data/                 generowane JSON-y (commitowane przez Actions)
config.json           nick Letterboxd, kina, horyzont dni
.github/workflows/    codzienny cron aktualizacji danych
```

---

*Projekt hobbystyczny; niepowiązany z Cinema City, Letterboxd ani TMDB.
Dane repertuarowe należą do Cinema City i służą wyłącznie do użytku osobistego.*
