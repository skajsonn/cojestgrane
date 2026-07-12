# 🎬 Co jest grane? — [cojestgrane.me](https://cojestgrane.me)

Osobisty asystent kinowy dla kin **Cinema City** (Katowice Punkt 44 i Silesia,
Częstochowa Jurajska i Wolność, Warszawa Janki). Wchodzisz, widzisz co fajnego
leci, bookujesz miejsca.

## Co potrafi

- **Repertuar na żywo** — wszystkie seanse wybranych kin na ~4 tygodnie do
  przodu: godziny, sale, formaty (IMAX, 4DX, Laser…), wersje językowe,
  plakaty; godziny klikają się prosto do zakupu biletów w Twojej sesji
  cinema-city.pl. Minione seanse wygasają, premiery i powtórki są oznaczone,
  świeżo dodane bilety dostają znacznik 🆕.
- **Integracja z Letterboxd** — obejrzane filmy, oceny i watchlisty (także
  kilku kont naraz — dane paczki znajomych się sumują). Filmy z watchlist są
  oznaczone i zawsze lądują na górze rekomendacji; to, co ktoś z paczki już
  widział, dostaje adnotację z jego oceną.
- **„Warto iść”** — sekcja rekomendacji: najpierw wszystko z Waszych
  watchlist (też przedsprzedaże), potem codzienny **rekonesans AI** — filmy
  spoza watchlist dobrane pod gusty profili na bazie ocen i recenzji
  z Letterboxd, z uzasadnieniem przy każdym tytule. Tylko filmy z dobrą,
  wiarygodną średnią Letterboxd.
- **Kalendarz premier** — widok miesiąca z najciekawszymi premierami roku
  w Polsce + lista „Klasyka na dużym ekranie” (retro-seanse w CC). Filtr
  „śmietanka” zostawia watchlisty, hity i wszystko, co ma już bilety.
- **Oceny z Letterboxd** — wszędzie w serwisie pokazywana jest średnia
  społeczności Letterboxd, nie TMDB.

## Jak to działa

Strona jest w pełni statyczna (GitHub Pages, czysty HTML/CSS/JS bez
zależności). Dane odświeża co 6 godzin GitHub Actions: repertuar z API
Cinema City, profile z publicznych stron Letterboxd, metadane i kalendarz
premier z TMDB. Rekonesans AI (Google Gemini) działa przez lekki
Cloudflare Worker — bez żadnej konfiguracji po stronie odwiedzających.
Preferencje (kina, aktywne konta) żyją wyłącznie w localStorage przeglądarki.

---

*Projekt hobbystyczny; niepowiązany z Cinema City, Letterboxd ani TMDB.
Dane repertuarowe należą do Cinema City i służą wyłącznie do użytku osobistego.*
