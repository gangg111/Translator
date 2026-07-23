# Tłumacz — tłumaczenie całych domen jednym kliknięciem

Wtyczka do przeglądarek opartych na Chromium (Edge, Chrome), która **tłumaczy widoczny tekst
strony na polski i podmienia go w miejscu**. Bez paneli, bez ramek obok, bez otwierania
tłumacza w nowej karcie — czytasz tę samą stronę, tylko po polsku.

Jedno kliknięcie ikony włącza tłumaczenie **całej domeny**: bieżąca strona tłumaczy się od
razu, a każda kolejna podstrona tego serwisu robi to sama, gdy tylko na nią wejdziesz.

- **Brak serwera pośredniczącego** — wtyczka woła OpenAI wprost z przeglądarki. Nic nie
  przechodzi przez cudzy backend.
- **Własny klucz OpenAI** — płacisz tylko za to, co faktycznie przetłumaczysz.
- **Pamięć tłumaczeń** — powtarzające się fragmenty (nawigacja, stopka, terminologia) nie są
  wysyłane po raz drugi.

Wersja **2.9.0** · manifest V3 · testowane na Microsoft Edge.

---

## Instalacja

### Sposób 1 — katalog rozpakowany (bez uprawnień administratora)

1. Pobierz repozytorium (**Code → Download ZIP**) i rozpakuj.
2. Wejdź na `edge://extensions` (w Chrome: `chrome://extensions`).
3. Włącz **Tryb programisty**.
4. Kliknij **Załaduj nierozpakowane** i wskaż katalog **`tlumacz-pl`**.

Gotowe. To najprostsza droga i nie wymaga niczego więcej.

> Przy każdym starcie przeglądarka może pokazywać pasek „Wyłącz rozszerzenia w trybie
> dewelopera" — można go zamknąć, wtyczka działa dalej.

### Sposób 2 — plik `.crx` (wymaga uprawnień administratora, tylko Edge)

Przeciągnięcie `.crx` na stronę rozszerzeń **zainstaluje** wtyczkę, ale Edge zostawi ją
**wyłączoną** z komunikatem „to rozszerzenie nie pochodzi ze znanego źródła". To blokada
rozszerzeń spoza sklepu, nie błąd paczki — zdejmuje ją wyłącznie zasada systemowa.

1. Uruchom **`Dodanie wtyczki to whitelist.cmd`** (dwuklik) i potwierdź monit UAC. Skrypt
   dopisuje identyfikator wtyczki do `ExtensionInstallAllowlist` w zasadach Edge.
2. Zamknij **całkowicie** Edge (wszystkie okna) i uruchom go ponownie.
3. Przeciągnij **`tlumacz-pl.crx`** na `edge://extensions` — teraz przełącznik zadziała.

Cofnięcie zmiany w rejestrze:

```
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallAllowlist" /f
```

Po dodaniu zasady na stronie rozszerzeń pojawia się „Zarządzane przez organizację" — to
normalny skutek uboczny. Żółty znak zapytania przy ikonie oznacza tylko „rozszerzenie spoza
sklepu" i nie ogranicza działania.

Obie drogi dają **tę samą wtyczkę** o identyfikatorze
`gobplihcimfopmpkkmfaohagoddeaoen` (jest on przypięty kluczem podpisu w manifeście), więc
klucz API, lista domen i pamięć tłumaczeń nie znikają przy zmianie sposobu instalacji.

---

## Konfiguracja

Prawy klik na ikonę wtyczki → **Opcje** (otwierają się w pełnej karcie).

1. **Klucz OpenAI API** — wklej klucz z [platform.openai.com](https://platform.openai.com/api-keys)
   i kliknij **Zapisz**.
2. **Testuj połączenie** — przetłumaczy jedno słowo i potwierdzi, że klucz działa.
3. **Model** — wybierasz klikiem z listy. Przycisk **Odśwież listę z OpenAI** pobiera modele
   dostępne na Twoim koncie (`GET /v1/models`); lista jest odsiewana z modeli
   nietekstowych i zapamiętywana na dobę. Domyślnie `gpt-5.4`. Pozycja **Inny model**
   pozwala wpisać dowolny identyfikator, np. przypiętą wersję z datą.

Klucz trafia do `chrome.storage.local` — zostaje na tym urządzeniu i nie synchronizuje się
z profilem w chmurze.

## Użycie

- **Klik w ikonę** — włącza automatyczne tłumaczenie całej domeny (razem z subdomenami).
  Kolejny klik wyłącza; żeby zobaczyć oryginał, odśwież stronę.
- **Znaczek na ikonie** pokazuje postęp w procentach, `OK` po zakończeniu, a przy błędzie —
  czerwone kółko z krzyżykiem; przyczyna jest w dymku po najechaniu.
- **Opcje** zawierają listę włączonych domen (można je usuwać), statystyki użycia oraz
  licznik i czyszczenie pamięci tłumaczeń.

## Co dokładnie robi

| | |
|---|---|
| **Podmiana w miejscu** | Zmieniane są wyłącznie węzły tekstowe i tłumaczalne atrybuty (`title`, `alt`, `placeholder`, `aria-label`). Struktura DOM zostaje nietknięta, więc strony na React/Vue się nie psują. |
| **Treść ukryta** | Rozwijane menu, zakładki i okna modalne są tłumaczone z góry, żeby były gotowe po polsku, zanim je otworzysz. Pomijane są elementy jawnie oznaczone jako nietłumaczalne (`translate="no"`, `.notranslate`, `aria-hidden`) oraz kod (`<code>`, `<pre>`, edytory). |
| **Strony dynamiczne** | `MutationObserver` dotłumacza treści doładowane później (lazy-load, przewijanie, zmiana widoku w SPA), także wewnątrz Shadow DOM i ramek. |
| **Ceny w PLN** | Kwoty w `$`, `€`, `£`, `¥` są przeliczane na złotówki po aktualnym kursie EBC z [frankfurter.dev](https://frankfurter.dev) (bez klucza, kurs odświeżany co 6 h). |
| **Dopasowanie układu** | Dłuższe polskie napisy potrafią rozbić wąskie przyciski i paski nawigacji — wtyczka zmniejsza wtedy czcionkę i odstępy tylko w tych kontrolkach, zamiast rozpychać stronę. |
| **Spójność** | Model dostaje sąsiadujące fragmenty jako kontekst i instrukcję, by różne pojęcia miały różne polskie odpowiedniki (np. *crop* → kadruj, *trim* → przytnij). |

## Koszty i wydajność

Płacisz OpenAI za przetłumaczony tekst — wtyczka stara się wysyłać go jak najmniej:

- **Pamięć tłumaczeń** (do 5000 fragmentów, wspólna dla wszystkich kart i ramek) sprawia,
  że powtarzalne elementy serwisu lecą do modelu raz. W pomiarach na dokumentacji MDN już
  **na trzeciej podstronie 81 %** fragmentów pochodziło z pamięci; przy odświeżeniu strony
  i cofaniu się — komplet.
- **Deduplikacja** w obrębie strony: identyczny tekst w wielu miejscach = jedno tłumaczenie.
- **Paczki** ok. 2000 znaków, do 8 równolegle, z twardym limitem jednoczesnych zapytań
  po stronie wtyczki.
- **Tryb rozumowania** modelu jest wykrywany automatycznie i ustawiany na najtańszy, jaki
  konto akceptuje. Bez tego modele rozumujące potrafią mielić ponad 100 s na jedną paczkę.

Zakładka **Statystyki** w opcjach pokazuje, ile fragmentów przyszło z pamięci, ile znaków
poszło do OpenAI, a ile udało się zaoszczędzić.

## Prywatność

- Tekst tłumaczonych stron jest wysyłany **do OpenAI** — nie używaj wtyczki na stronach
  z treściami, których nie chcesz tam wysyłać (bankowość, dokumentacja wewnętrzna, poczta).
- Klucz API i pamięć tłumaczeń leżą **lokalnie** w `chrome.storage.local`.
- Nie ma żadnego serwera pośredniczącego, telemetrii ani analityki.
- Jedyne dodatkowe połączenie to `frankfurter.dev` po kursy walut (bez danych ze strony).

Uprawnienia: `activeTab`, `scripting`, `storage` oraz dostęp do stron `http`/`https` —
niezbędny, bo wtyczka musi czytać i podmieniać tekst na dowolnej stronie, którą wskażesz.

## Ograniczenia

- **Tekst na obrazkach, w `canvas`/WebGL i generowany przez CSS** (`::before`, `::after`)
  nie istnieje jako węzeł tekstowy — pozostaje nieprzetłumaczony.
- **Zdanie rozcięte znacznikami** (`Kliknij <a>tutaj</a>, aby…`) tłumaczy się fragmentami;
  model dostaje sąsiedztwo jako kontekst, ale szyk bywa nieidealny. Scalanie bloków HTML
  byłoby ryzykowne dla stron reaktywnych i zostało świadomie odpuszczone.
- **Zmiana modelu unieważnia pamięć** — różne modele dają różne tłumaczenia, więc materiał
  jest tłumaczony od nowa.
- **Strony systemowe** (`edge://`, `chrome://`, sklep z rozszerzeniami, podgląd PDF) są poza
  zasięgiem wtyczek — tam nic się nie wydarzy.
- Skrypt dodający wpis do listy dozwolonych rozszerzeń dotyczy **tylko Edge**. W Chrome
  odpowiednikiem jest gałąź `HKLM\SOFTWARE\Policies\Google\Chrome`; prościej użyć
  instalacji z katalogu rozpakowanego.

## Zawartość repozytorium

```
tlumacz-pl/                        gotowa wtyczka — to wskazujesz w „Załaduj nierozpakowane"
tlumacz-pl.crx                     ta sama wtyczka spakowana i podpisana
Dodanie wtyczki to whitelist.cmd   dopisuje ID wtyczki do zasad Edge (wymaga administratora)
```

## Licencja

[MIT](LICENSE)
