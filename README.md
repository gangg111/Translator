# Tłumacz — cała strona po polsku, jednym kliknięciem

Wchodzisz na zagraniczną stronę, klikasz ikonę — i strona jest po polsku. Wygląda tak samo
jak wcześniej, tylko tekst jest przetłumaczony. Żadnych okienek obok, żadnego kopiowania
i wklejania do tłumacza.

Jedno kliknięcie wystarcza na **cały serwis**. Jeśli włączysz tłumaczenie na stronie
głównej, każda kolejna podstrona tego serwisu też przetłumaczy się sama.

Działa w przeglądarkach **Microsoft Edge** i **Google Chrome**.

---

## Zanim zaczniesz — potrzebujesz klucza OpenAI

Tłumaczy sztuczna inteligencja od OpenAI (ta sama firma, co ChatGPT). Żeby wtyczka mogła
z niej korzystać, potrzebuje Twojego **klucza** — to taki długi ciąg znaków, który mówi
OpenAI, kto płaci za tłumaczenie.

To płatna usługa, ale rozliczana za faktyczne użycie — nie ma abonamentu. Jak zdobyć klucz:

1. Wejdź na **[platform.openai.com](https://platform.openai.com)** i załóż konto
   (albo zaloguj się kontem ChatGPT, jeśli już je masz).
2. Doładuj konto dowolną kwotą w zakładce **Billing** — bez tego klucz nie zadziała.
3. Wejdź na **[stronę z kluczami](https://platform.openai.com/api-keys)** i kliknij
   **Create new secret key**.
4. Skopiuj klucz i zachowaj go na chwilę — wkleisz go po instalacji.

> Klucz pokazuje się **tylko raz**. Jeśli go zgubisz, po prostu utwórz nowy.

---

## Instalacja

1. Na górze tej strony kliknij zielony przycisk **Code**, a potem **Download ZIP**.
2. Znajdź pobrany plik i rozpakuj go (prawy klik → **Wyodrębnij wszystkie**).
3. Otwórz przeglądarkę i wpisz w pasku adresu:
   - Edge: `edge://extensions`
   - Chrome: `chrome://extensions`
4. W lewym dolnym rogu (Chrome: w prawym górnym) przestaw suwak **Tryb programisty** na
   włączony.
5. Kliknij **Załaduj nierozpakowane**, wejdź do rozpakowanego folderu i zaznacz folder
   **`tlumacz-pl`**, po czym potwierdź.

Gotowe — na liście pojawi się „Tłumacz". Kliknij ikonę układanki obok paska adresu
i przypnij go pinezką, żeby mieć zawsze pod ręką.

> Przy starcie przeglądarki może wyskakiwać pasek z ostrzeżeniem o trybie programisty.
> Można go zamknąć — wtyczka działa normalnie.

---

## Pierwsze uruchomienie — wklej klucz

1. Kliknij ikonę wtyczki **prawym** przyciskiem myszy i wybierz **Opcje**.
2. W polu **Klucz OpenAI API** wklej skopiowany wcześniej klucz.
3. Kliknij **Zapisz**.
4. Kliknij **Testuj połączenie** — wtyczka przetłumaczy jedno słowo i napisze, czy wszystko
   gra.

To wszystko. Klucz wpisujesz raz.

**Model** (czyli to, która wersja sztucznej inteligencji tłumaczy) możesz zostawić bez
zmian — ustawienie domyślne jest dobre. Jeśli kiedyś zechcesz go zmienić, kliknij
**Odśwież listę z OpenAI** i wybierz z listy.

---

## Jak tłumaczyć

**Kliknij ikonę wtyczki** na stronie, którą chcesz przeczytać po polsku.

- Strona przetłumaczy się w ciągu kilku sekund. Na ikonie widać postęp w procentach.
- Od tej chwili **cały ten serwis** tłumaczy się automatycznie — wchodzisz na kolejną
  podstronę i już jest po polsku.
- Żeby wyłączyć, kliknij ikonę ponownie i odśwież stronę (klawisz **F5**).

W **Opcjach** widzisz listę serwisów, które tłumaczą się automatycznie. Każdy możesz stamtąd
usunąć przyciskiem **Usuń**.

Wtyczka tłumaczy też rzeczy, które nie są jeszcze widoczne — rozwijane menu, zakładki,
okienka. Dzięki temu po ich otwarciu od razu są po polsku. Ceny w dolarach, euro, funtach
i jenach przelicza na złotówki po aktualnym kursie.

---

## Ile to kosztuje

Płacisz OpenAI za ilość przetłumaczonego tekstu — aktualne stawki znajdziesz
[w cenniku OpenAI](https://openai.com/api/pricing/). Wtyczka jest zrobiona tak, żeby wysyłać
jak najmniej:

- **Zapamiętuje tłumaczenia.** Menu, stopka i powtarzające się zwroty są tłumaczone raz,
  a potem brane z pamięci. Na kolejnych podstronach tego samego serwisu zwykle **większość
  tekstu nie jest już nigdzie wysyłana** — przy testach na dokumentacji technicznej
  na trzeciej podstronie z pamięci pochodziło 8 na 10 fragmentów.
- Powtórzony tekst na jednej stronie liczy się raz.

W **Opcjach**, w sekcji **Statystyki**, na bieżąco widzisz ile fragmentów przyszło z pamięci,
a ile trzeba było wysłać.

---

## Co warto wiedzieć o prywatności

- Tekst tłumaczonych stron **jest wysyłany do OpenAI** — inaczej nie dałoby się go
  przetłumaczyć. Dlatego **nie używaj wtyczki na stronach z wrażliwymi treściami**:
  w banku, w poczcie, w dokumentach firmowych czy medycznych.
- Twój klucz i zapamiętane tłumaczenia zostają **na Twoim komputerze**.
- Wtyczka nie ma własnego serwera i nie zbiera o Tobie żadnych danych.

---

## Czego wtyczka nie przetłumaczy

- **Napisów na obrazkach i w filmach** — to grafika, nie tekst, więc nie da się jej podmienić.
- **Stron wewnętrznych przeglądarki** (ustawienia, lista rozszerzeń, podgląd plików PDF) —
  tam żadne rozszerzenie nie ma wstępu.
- Czasem zdanie porozdzielane linkami wyjdzie trochę sztywno — treść będzie zrozumiała,
  ale szyk może nie być idealny.

---

## Gdy coś nie działa

**Kliknąłem ikonę i nic się nie dzieje.**
Sprawdź w **Opcjach**, czy klucz jest wpisany, i kliknij **Testuj połączenie** — komunikat
powie, co jest nie tak.

**Na ikonie pojawiło się czerwone kółko z krzyżykiem.**
To znak błędu. Najedź na ikonę myszką — w dymku pojawi się przyczyna. Najczęściej to
niepoprawny klucz albo brak środków na koncie OpenAI.

**Tłumaczenie idzie wolno.**
Pierwsze wejście na stronę zawsze trwa najdłużej, bo cały tekst jest nowy. Kolejne podstrony
tego samego serwisu są wyraźnie szybsze, bo spora część tekstu jest już zapamiętana.

**Chcę zobaczyć oryginał.**
Kliknij ikonę (wyłączy tłumaczenie dla tego serwisu) i odśwież stronę klawiszem **F5**.

**Chcę zacząć od zera.**
W **Opcjach** są przyciski **Wyczyść pamięć** (kasuje zapamiętane tłumaczenia)
i **Wyzeruj statystyki**.

---

## Instalacja z pliku `.crx` (opcjonalnie)

W repozytorium jest też plik `tlumacz-pl.crx` — wtyczka spakowana w jedną paczkę. Ta droga
wymaga uprawnień administratora i **działa tylko w Edge**, więc jeśli instalacja opisana
wyżej Ci wystarcza, możesz ten fragment pominąć.

Przeglądarka domyślnie nie ufa rozszerzeniom spoza swojego sklepu — zainstaluje taki plik,
ale zostawi go wyłączonego. Żeby to zmienić:

1. Uruchom plik **`Dodanie wtyczki to whitelist.cmd`** (podwójne kliknięcie) i potwierdź
   pytanie systemu Windows o uprawnienia.
2. Zamknij **wszystkie** okna Edge i uruchom przeglądarkę ponownie.
3. Przeciągnij plik `tlumacz-pl.crx` na stronę `edge://extensions` — teraz da się włączyć.

Po tej operacji na liście rozszerzeń pojawi się napis „Zarządzane przez organizację",
a przy ikonie wtyczki żółty znak zapytania. To normalne — oznacza tylko, że wtyczka nie
pochodzi ze sklepu, i niczego nie ogranicza.

---

## Licencja

[MIT](LICENSE) — możesz używać, zmieniać i udostępniać za darmo.
