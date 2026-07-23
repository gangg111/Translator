// content.js — zbiera widoczne teksty strony, tłumaczy je przez serwer (za pośrednictwem
// background service workera) i podmienia W MIEJSCU. Nie zmienia struktury DOM — modyfikuje
// wyłącznie wartości węzłów tekstowych i tłumaczalnych atrybutów, dzięki czemu układ, style
// i skrypty strony (w tym React/Vue) zostają nietknięte.
(() => {
  'use strict';

  // Ponowne wstrzyknięcie (kolejny klik ikony) nie może zdublować stanu ani obserwatorów.
  // Po reload/aktualizacji rozszerzenia stary kontekst jest martwy (chrome.runtime
  // unieważniony), ale flaga w isolated world zostaje — dlatego sprawdzamy żywotność,
  // a nie samą obecność flagi; po martwym poprzedniku sprzątamy jego obserwatora.
  {
    const prev = window.__plTranslatorState;
    if (prev) {
      if (prev.isAlive?.()) return;
      try { prev.observer?.disconnect(); } catch { /* martwy kontekst */ }
      try { clearTimeout(prev.rescanTimer); } catch { /* jw. */ }
    }
  }

  const CONFIG = {
    BATCH_MAX_CHARS: 4000,    // budżet znaków jednej paczki wysyłanej do serwera
    // Pomiar na żywym koncie (log service workera): czas odpowiedzi NIE zależy od rozmiaru
    // paczki — 232 znaki = 7137 ms, 700 znaków = 2576 ms, minimum ~2,6 s. Koszt jest STAŁY
    // per wywołanie (TTFT modelu rozumującego), więc drobne paczki to czysta strata: każda
    // płaci pełne 3 s. Dlatego podłoga jest wysoka — lepiej mniej, większych wywołań.
    BATCH_MIN_CHARS: 2000,
    // Limit segmentów to tylko bezpiecznik przed absurdalnie długą tablicą w odpowiedzi
    // (background i tak ponawia oraz dzieli przy rozjeździe długości). Przy 80 to ON,
    // a nie budżet znaków, decydował o podziale stron z krótkimi etykietami — czyli
    // dokładał wywołań po ~3 s każde. Realnym kosztem są znaki, nie liczba pozycji.
    BATCH_MAX_ITEMS: 150,
    MAX_PARALLEL: 8,          // ile paczek leci równolegle (twardy limit i tak trzyma background)
    // Z tego samego powodu dłużej zbieramy mutacje: sklejenie trzech doszukań w jedno
    // oszczędza dwa pełne wywołania (~7 s), a kosztuje pół sekundy zwłoki.
    RESCAN_DEBOUNCE_MS: 1200,
    SEND_RETRIES: 2,          // ponowienia gdy service worker padnie w trakcie ("port closed")
    SEND_RETRY_DELAY_MS: 500,
  };

  // Elementy pomijane zawsze (treść i atrybuty): nie-treść oraz jawne "nie tłumacz".
  // [hidden] respektuje jawne ukrycie; aria-hidden/translate=no/.notranslate to intencja.
  const SKIP_COMMON = [
    'script', 'style', 'noscript', 'template', 'iframe', 'object',
    '[translate="no"]', '.notranslate', '[aria-hidden="true"]', '[hidden]',
  ];
  // Elementy, których TREŚĆ pomijamy, ale atrybuty (placeholder itd.) wciąż tłumaczymy:
  // kod (także podświetlacze składni bez <code>: GitHub, Pygments, CodeMirror, Monaco,
  // highlight.js) i pola edycji użytkownika.
  const SKIP_TEXT_EXTRA = [
    'code', 'kbd', 'samp', 'var', 'pre', 'textarea',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '.hljs', '[class*="language-"]', '.blob-code', '.cm-editor', '.cm-content', '.monaco-editor',
  ];
  const SKIP_TEXT_SELECTOR = [...SKIP_COMMON, ...SKIP_TEXT_EXTRA].join(',');
  const SKIP_ATTR_SELECTOR = SKIP_COMMON.join(',');

  const TRANSLATABLE_ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const BUTTON_INPUT_SELECTOR = 'input[type="button"],input[type="submit"],input[type="reset"]';
  const LABELED_SELECTOR = 'option[label],optgroup[label],track[label]';
  const HAS_LETTER = /\p{L}/u;
  const PURE_URL = /^https?:\/\/\S+$/i;
  const PURE_EMAIL = /^\S+@\S+\.\S+$/;

  // Przeliczanie cen na PLN po aktualnym kursie (ECB, z background). Symbol -> kod ISO.
  const CURRENCY_SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  const CURRENCY_CHARS = /[$€£¥]/;
  // Kwota: symbol + liczba (z opcjonalnymi separatorami tysięcy i częścią dziesiętną).
  const CURRENCY_RE = /([$€£¥])\s?(\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  const PLN_FORMAT = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });

  // Kontrolki o zwykle sztywnym rozmiarze (przyciski, linki-przyciski, menu, zakładki),
  // w których dłuższe polskie tłumaczenie potrafi rozjechać layout. Dla nich, jeśli po
  // tłumaczeniu kontrolka urośnie, zmniejszamy nieco czcionkę, by wróciła do rozmiaru.
  const CONTROL_SELECTOR = 'button,summary,label,[role="button"],[role="tab"],[role="menuitem"],'
    + 'a,input[type="button"],input[type="submit"],input[type="reset"]';
  const FIT_FONT_FLOOR = 0.65; // dolna granica skalowania czcionki kontrolki (nav bywa ciasny)
  const FIT_FONT_MIN_PX = 11;  // ale nigdy poniżej czytelności
  const FIT_TOLERANCE_PX = 2;

  const OBSERVER_OPTIONS = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    // class/style/hidden/open/aria-hidden mogą odsłonić wcześniej niewidoczny tekst
    // (menu, <details>, modale); reszta to atrybuty, które sami tłumaczymy.
    attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden', ...TRANSLATABLE_ATTRS],
  };

  const state = {
    running: false,
    rerunQueued: false,
    observer: null,
    rescanTimer: 0,
    done: 0,
    total: 0,
    failed: 0,
    appliedTitle: '',
    // Żywotność tego kontekstu — domknięcie trzyma chrome TEGO wstrzyknięcia;
    // po reload rozszerzenia dostęp do chrome.runtime.id rzuca / zwraca undefined.
    isAlive: () => {
      try { return Boolean(chrome.runtime.id); } catch { return false; }
    },
  };
  window.__plTranslatorState = state;

  // Pamięć tłumaczeń tej strony: oryginał -> tłumaczenie. Gdy framework nadpisze nasz
  // tekst oryginałem (re-render), podmiana wraca natychmiast, bez sieci.
  const memory = new Map();

  // Wartości, które sami ustawiliśmy — pozwalają odróżnić własne mutacje od zmian strony.
  const appliedTextValues = new WeakMap(); // Text -> string
  const appliedAttrValues = new WeakMap(); // Element -> Map(attr|'value' -> string)
  const convertedPriceNodes = new WeakMap(); // Text -> string (już przeliczone na PLN)
  let ratesPromise = null; // kursy walut pobierane raz na przebieg strony

  // Shadow rooty już objęte obserwacją mutacji (observer.observe nie przekracza ich granicy).
  const observedShadowRoots = new WeakSet();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'START_TRANSLATION') {
      translatePage(true);
      sendResponse({ ok: true });
    }
  });

  // ---------------------------------------------------------------- zbieranie tekstów

  // Segment nadaje się do tłumaczenia: ma litery i nie jest czystym URL-em/adresem e-mail.
  function isTranslatable(text) {
    if (!text || !HAS_LETTER.test(text)) return false;
    const trimmed = text.trim();
    return !PURE_URL.test(trimmed) && !PURE_EMAIL.test(trimmed);
  }

  function collectItems() {
    const items = [];
    // Widoczność liczona per przebieg — strona mogła się zmienić między przebiegami.
    const visCache = new WeakMap();

    const isVisible = (el) => {
      if (!el || el === document.documentElement || el === document.body) return true;
      const cached = visCache.get(el);
      if (cached !== undefined) return cached;
      let visible;
      if (el.tagName === 'OPTION' || el.tagName === 'OPTGROUP') {
        // Opcje zamkniętego selecta nie mają boxu, ale są "widoczne" dla użytkownika.
        const select = el.closest('select,datalist');
        visible = select?.tagName === 'SELECT' ? isVisible(select) : false;
      } else if (typeof el.checkVisibility === 'function') {
        visible = el.checkVisibility({ visibilityProperty: true });
        if (!visible) {
          // checkVisibility zwraca false dla elementów bez boxu — ale display:contents
          // renderuje dzieci normalnie; oceniamy wtedy po rodzicu.
          const view = el.ownerDocument?.defaultView;
          if (view && view.getComputedStyle(el).display === 'contents') {
            visible = el.parentElement ? isVisible(el.parentElement) : true;
          }
        }
      } else {
        const view = el.ownerDocument?.defaultView;
        const cs = view ? view.getComputedStyle(el) : null;
        visible = !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
        if (visible && el.parentElement) visible = isVisible(el.parentElement);
      }
      visCache.set(el, visible);
      return visible;
    };

    for (const root of allRoots(document.body)) {
      collectTextItems(root, items, isVisible);
      collectAttrItems(root, items, isVisible);
    }

    if (window === window.top) {
      const title = document.title;
      if (title && title.trim() && isTranslatable(title) && state.appliedTitle !== title) {
        items.push({ kind: 'title', source: title.trim(), lead: '', trail: '', raw: title });
      }
    }
    return items;
  }

  // document.body + wszystkie otwarte shadow rooty (rekurencyjnie).
  // Nowo odkryte shadow rooty od razu obejmujemy obserwacją mutacji.
  function* allRoots(base) {
    yield base;
    for (const el of base.querySelectorAll('*')) {
      if (el.shadowRoot) {
        observeShadowRoot(el.shadowRoot);
        yield* allRoots(el.shadowRoot);
      }
    }
  }

  function collectTextItems(root, items, isVisible) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue;
        if (!raw || !raw.trim() || !isTranslatable(raw)) return NodeFilter.FILTER_REJECT;
        // Tekst wprost w shadow root nie ma parentElement — oceniamy go po hoście.
        const el = node.parentElement
          ?? (node.parentNode && node.parentNode.host ? node.parentNode.host : null);
        if (!el || el.closest(SKIP_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (appliedTextValues.get(node) === raw) return NodeFilter.FILTER_REJECT; // już nasze
        // Celowo NIE odrzucamy treści ukrytej przez CSS (display:none/visibility) — to
        // zwykle rozwijane menu / zakładki / modale, które mają być gotowe po polsku,
        // zanim użytkownik je otworzy. Jawne ukrycie ([hidden]/aria-hidden/translate=no)
        // jest już wykluczone przez SKIP_TEXT_SELECTOR.
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.nodeValue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.slice(lead.length).match(/\s*$/)[0];
      const source = raw.slice(lead.length, raw.length - trail.length);
      if (!source) continue;
      const el = node.parentElement
        ?? (node.parentNode && node.parentNode.host ? node.parentNode.host : null);
      const item = { kind: 'text', node, el, source, lead, trail, raw };
      // Dla KRÓTKICH etykiet (przyciski, menu, linki-CTA) zapamiętaj kontrolkę — po
      // podmianie zabezpieczymy ją przed łamaniem wyraz-pod-wyrazem. Dłuższe teksty
      // (zdania) mają się zawijać normalnie, więc je pomijamy.
      if (source.length <= 40) {
        const control = el?.closest?.(CONTROL_SELECTOR);
        if (control) {
          const disp = control.ownerDocument.defaultView?.getComputedStyle(control).display;
          if (disp && disp !== 'inline' && disp !== 'contents') item.control = control;
        }
      }
      items.push(item);
    }
  }

  function collectAttrItems(root, items, isVisible) {
    const selector = TRANSLATABLE_ATTRS.map((a) => `[${a}]`).join(',')
      + ',' + BUTTON_INPUT_SELECTOR + ',' + LABELED_SELECTOR;
    for (const el of root.querySelectorAll(selector)) {
      if (el.closest(SKIP_ATTR_SELECTOR) || !isVisible(el)) continue;
      const attrs = [...TRANSLATABLE_ATTRS];
      if (el.matches(LABELED_SELECTOR)) attrs.push('label');
      for (const attr of attrs) {
        const raw = el.getAttribute(attr);
        if (!raw || !raw.trim() || !isTranslatable(raw)) continue;
        if (appliedAttrValues.get(el)?.get(attr) === raw) continue;
        items.push({ kind: 'attr', el, attr, source: raw.trim(), lead: '', trail: '', raw });
      }
      if (el.matches(BUTTON_INPUT_SELECTOR)) {
        const raw = el.value;
        if (raw && raw.trim() && isTranslatable(raw)
          && appliedAttrValues.get(el)?.get('value') !== raw) {
          items.push({ kind: 'value', el, source: raw.trim(), lead: '', trail: '', raw });
        }
      }
    }
  }

  // ---------------------------------------------------------------- podmiana w miejscu

  function applyTranslation(item, translated) {
    if (item.kind === 'text') {
      const node = item.node;
      // Strona mogła w międzyczasie podmienić treść — wtedy nasza odpowiedź jest
      // nieaktualna; nowy tekst wyłapie MutationObserver.
      if (!node.isConnected || node.nodeValue !== item.raw) return;
      const value = item.lead + translated + item.trail;
      appliedTextValues.set(node, value);
      node.nodeValue = value;
      // Dopasowanie kontrolek robimy dopiero w finalnym przebiegu (fitControls), gdy
      // wszystkie sąsiednie etykiety są już przetłumaczone i szerokości są ostateczne.
      return;
    }
    if (item.kind === 'attr') {
      if (!item.el.isConnected || item.el.getAttribute(item.attr) !== item.raw) return;
      rememberAttr(item.el, item.attr, translated);
      item.el.setAttribute(item.attr, translated);
      return;
    }
    if (item.kind === 'value') {
      if (!item.el.isConnected || item.el.value !== item.raw) return;
      rememberAttr(item.el, 'value', translated);
      item.el.value = translated;
      return;
    }
    if (item.kind === 'title') {
      if (document.title !== item.raw) return; // SPA zdążyła zmienić tytuł
      state.appliedTitle = translated;
      document.title = translated;
    }
  }

  function rememberAttr(el, key, value) {
    let map = appliedAttrValues.get(el);
    if (!map) appliedAttrValues.set(el, (map = new Map()));
    map.set(key, value);
  }

  // Dłuższe polskie tłumaczenie potrafi rozbić WĄSKĄ kontrolkę na kilka linii „wyraz pod
  // wyrazem" (flexbox ściska ją poniżej szerokości tekstu, min-width:0). Naprawiamy TYLKO
  // kontrolki, które NAPRAWDĘ się zawinęły (są wieloliniowe) — kontrolek jednoliniowych
  // (w tym takich o nieograniczonej szerokości) NIE dotykamy, żeby nie rozpychać strony
  // i nie powodować poziomego suwaka. Naprawa: jedna linia (nowrap) + zmniejszenie czcionki
  // tyle, by tekst zmieścił się w OBECNEJ szerokości boxa (bez powiększania boxa).
  function autoFitControl(el, basePx) {
    if (!el.isConnected) return;
    const view = el.ownerDocument.defaultView;
    const cs = view.getComputedStyle(el);
    if (cs.whiteSpace === 'nowrap') return; // już przez nas (lub stronę) ustawione na 1 linię
    const lineH = cs.lineHeight === 'normal'
      ? basePx * 1.3 : (parseFloat(cs.lineHeight) || basePx * 1.3);
    const vBox = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const oneLine = lineH + vBox;
    if (el.offsetHeight <= oneLine + FIT_TOLERANCE_PX) return; // już jedna linia — nie ruszamy

    // Kontrolka jest wieloliniowa (zawinięta) — wymuś jedną linię i zmieść ją w bieżącej szerokości.
    el.style.setProperty('white-space', 'nowrap', 'important');
    const minPx = Math.max(FIT_FONT_MIN_PX, basePx * FIT_FONT_FLOOR);
    let size = basePx;
    for (let i = 0; i < 16 && size > minPx; i += 1) {
      if (el.scrollWidth <= el.clientWidth + FIT_TOLERANCE_PX) return; // zmieścił się
      size = Math.max(minPx, size * 0.94);
      el.style.setProperty('font-size', size + 'px', 'important');
    }
    // Skrajnie ciasny box — zostaje jedna linia przy najmniejszej czcionce (lepsze niż suwak/stacking).
  }

  // Najbliższy przodek, który przewija się w poziomie (overflow-x auto/scroll i realnie
  // ma nadmiar szerokości). Taki kontener (np. nav <ul> witryny z overflow-x:auto) po
  // dłuższym tłumaczeniu pokazuje własny poziomy pasek i ucina ostatnie pozycje.
  function nearestOverflowingScrollX(el) {
    const doc = el.ownerDocument;
    const view = doc.defaultView;
    let e = el.parentElement;
    while (e && e !== doc.body && e !== doc.documentElement) {
      const ox = view.getComputedStyle(e).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + FIT_TOLERANCE_PX) {
        return e;
      }
      e = e.parentElement;
    }
    return null;
  }

  // Likwiduje poziome przewijanie kontenera: najpierw równomiernie zmniejsza czcionki
  // kontrolek (do granicy), a gdy to nie wystarcza (bo poziomy padding jest stały) —
  // przycina też ich poziomy padding. Dzięki temu przewijanie znika nawet przy zoomie.
  function shrinkUntilFits(container, ctrls, baseFont) {
    const view = container.ownerDocument.defaultView;
    let guard = 0;
    while (container.scrollWidth > container.clientWidth + FIT_TOLERANCE_PX && guard < 80) {
      guard += 1;
      let changed = false;
      for (const el of ctrls) {
        const base = baseFont.get(el) || 16;
        const floor = Math.max(FIT_FONT_MIN_PX, base * FIT_FONT_FLOOR);
        const cs = view.getComputedStyle(el);
        const cur = parseFloat(cs.fontSize) || base;
        if (cur > floor + 0.1) {
          el.style.setProperty('font-size', Math.max(floor, cur * 0.94) + 'px', 'important');
          changed = true;
        } else {
          // czcionka na granicy — przytnij poziomy padding, by odzyskać resztę szerokości
          const pl = parseFloat(cs.paddingLeft) || 0;
          const pr = parseFloat(cs.paddingRight) || 0;
          if (pl > 3 || pr > 3) {
            el.style.setProperty('padding-left', Math.max(3, pl * 0.85) + 'px', 'important');
            el.style.setProperty('padding-right', Math.max(3, pr * 0.85) + 'px', 'important');
            changed = true;
          }
        }
      }
      if (!changed) break; // czcionki i padding na granicy — dalej się nie da
    }
  }

  // Gdy tłumaczenie przepełniło poziomo-przewijalny kontener (nav <ul> strony) albo całą
  // stronę — zmniejsz czcionki kontrolek w środku, aż przewijanie zniknie.
  function relieveOverflow(controls, baseFont) {
    const groups = new Map(); // kontener -> [kontrolki]
    for (const el of controls) {
      const sc = nearestOverflowingScrollX(el);
      if (!sc) continue;
      let g = groups.get(sc);
      if (!g) groups.set(sc, (g = []));
      g.push(el);
    }
    // Ostateczność: sama strona przewija się w poziomie — potraktuj jako jeden kontener.
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + FIT_TOLERANCE_PX) groups.set(de, controls.slice());
    for (const [container, ctrls] of groups) {
      try { shrinkUntilFits(container, ctrls, baseFont); } catch { /* jeden kontener nie blokuje reszty */ }
    }
  }

  // Finalny przebieg dopasowania (raz, po podmianie tekstu): najpierw rozwiń kontrolki
  // zawinięte „wyraz pod wyrazem", potem zlikwiduj poziome przewijanie kontenerów.
  function fitControls(items) {
    const controls = [];
    const seen = new Set();
    const baseFont = new Map();
    for (const item of items) {
      if (item.control && !seen.has(item.control)) {
        seen.add(item.control);
        controls.push(item.control);
        const view = item.control.ownerDocument.defaultView;
        baseFont.set(item.control, parseFloat(view.getComputedStyle(item.control).fontSize) || 16);
      }
    }
    for (const el of controls) {
      try { autoFitControl(el, baseFont.get(el)); } catch { /* pojedyncza kontrolka nie blokuje reszty */ }
    }
    relieveOverflow(controls, baseFont);
  }

  // ---------------------------------------------------------------- ceny w PLN

  // Kursy z background (raz na przebieg). null => brak kursu, cen nie przeliczamy.
  function getRates() {
    if (!ratesPromise) {
      ratesPromise = new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'GET_RATES' }, (resp) => {
            if (chrome.runtime.lastError || !resp || resp.error || !resp.rates) resolve(null);
            else resolve(resp.rates);
          });
        } catch {
          resolve(null); // kontekst rozszerzenia unieważniony
        }
      });
    }
    return ratesPromise;
  }

  // Podmienia kwoty w obcej walucie ($/€/£/¥) na złotówki po aktualnym kursie ECB.
  // rates[X] = ile X za 1 PLN, więc kwota_pln = kwota_X / rates[X].
  async function convertCurrencies() {
    const rates = await getRates();
    if (!rates) return; // brak kursu — zostawiamy oryginalną walutę (nie zgadujemy)

    for (const root of allRoots(document.body)) {
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const raw = node.nodeValue;
          if (!raw || !CURRENCY_CHARS.test(raw)) return NodeFilter.FILTER_REJECT;
          if (convertedPriceNodes.get(node) === raw) return NodeFilter.FILTER_REJECT; // już nasze
          const el = node.parentElement
            ?? (node.parentNode && node.parentNode.host ? node.parentNode.host : null);
          if (!el || el.closest(SKIP_TEXT_SELECTOR)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const changes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const raw = node.nodeValue;
        CURRENCY_RE.lastIndex = 0;
        const next = raw.replace(CURRENCY_RE, (match, symbol, numeric) => {
          const code = CURRENCY_SYMBOLS[symbol];
          const rate = rates[code];
          if (!rate) return match; // nieznana waluta — bez zmian
          const amount = Number.parseFloat(numeric.replace(/[,\s]/g, ''));
          if (!Number.isFinite(amount)) return match;
          return PLN_FORMAT.format(amount / rate);
        });
        if (next !== raw) changes.push([node, next]);
      }
      for (const [node, value] of changes) {
        if (!node.isConnected) continue;
        convertedPriceNodes.set(node, value);
        appliedTextValues.set(node, value); // observer ma to traktować jak naszą zmianę
        node.nodeValue = value;
      }
    }
  }

  // ---------------------------------------------------------------- przebieg tłumaczenia

  async function translatePage(fromClick = false) {
    if (!document.body) return; // dokumenty XML (RSS/sitemap) — nie ma czego tłumaczyć
    if (state.running) {
      state.rerunQueued = true;
      return;
    }
    state.running = true;
    // Observer startuje PRZED pierwszym przebiegiem — mutacje w trakcie tłumaczenia
    // (hydratacja SPA, lazy-load) też mają trafić do doszukania.
    ensureObserver();
    try {
      const items = collectItems();
      if (items.length) {
        state.total += items.length;
        const pending = [];
        for (const item of items) {
          const known = memory.get(item.source);
          if (known !== undefined) {
            applyTranslation(item, known); // trafienie z pamięci — zero sieci
            state.done += 1;
          } else {
            pending.push(item);
          }
        }
        reportProgress();
        if (pending.length) await translatePending(pending);
      } else if (fromClick && state.total === 0) {
        reportProgress(); // jawny klik bez tekstów — badge pokaże "brak pracy"
      }
      // Ceny w obcej walucie -> PLN po aktualnym kursie (także gdy zmieniła się tylko cena,
      // bez nowego tekstu). Przed dopasowaniem kontrolek — zmiana kwoty zmienia szerokość.
      await convertCurrencies();
      // Finalny przebieg: dopasuj kontrolki, które się zawinęły (raz, po wszystkim).
      if (items.length) fitControls(items);
    } catch (err) {
      console.warn('[Tlumacz PL]', err);
    } finally {
      state.running = false;
    }
    if (state.rerunQueued) {
      state.rerunQueued = false;
      scheduleRescan();
    }
  }

  async function translatePending(pending) {
    // Najpierw to, co użytkownik widzi na ekranie — reszta strony dociąga się w tle.
    prioritizeViewport(pending);

    // Deduplikacja: identyczny tekst tłumaczymy raz, podmieniamy we wszystkich miejscach.
    const itemsBySource = new Map();
    for (const item of pending) {
      const list = itemsBySource.get(item.source);
      if (list) list.push(item);
      else itemsBySource.set(item.source, [item]);
    }

    const batches = packBatches([...itemsBySource.keys()]);
    await runPool(batches, CONFIG.MAX_PARALLEL, async (batch) => {
      let translations;
      try {
        translations = await requestTranslations(batch);
      } catch (err) {
        console.warn('[Tlumacz PL] paczka nieprzetłumaczona:', err.message);
        for (const source of batch) {
          const count = itemsBySource.get(source).length;
          state.done += count;
          state.failed += count; // oryginał zostaje na stronie, węzły zbieralne ponownie
        }
        reportProgress();
        return;
      }
      batch.forEach((source, i) => {
        const candidate = translations[i];
        const list = itemsBySource.get(source);
        if (typeof candidate !== 'string' || !candidate.trim()) {
          // Brak tłumaczenia segmentu: NIE zapisujemy do pamięci i NIE oznaczamy węzłów
          // jako obsłużone — następny przebieg/klik spróbuje ponownie.
          state.done += list.length;
          state.failed += list.length;
          return;
        }
        memory.set(source, candidate);
        for (const item of list) applyTranslation(item, candidate);
        state.done += list.length;
      });
      reportProgress();
    });
  }

  function prioritizeViewport(items) {
    const viewportCache = new WeakMap();
    const inViewport = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const cached = viewportCache.get(el);
      if (cached !== undefined) return cached;
      const r = el.getBoundingClientRect();
      const result = r.bottom > 0 && r.right > 0
        && r.top < window.innerHeight && r.left < window.innerWidth;
      viewportCache.set(el, result);
      return result;
    };
    // Sort stabilny: wewnątrz grup zostaje kolejność dokumentu (kontekst dla modelu).
    items.sort((a, b) => {
      const pa = a.kind === 'title' || inViewport(a.el) ? 0 : 1;
      const pb = b.kind === 'title' || inViewport(b.el) ? 0 : 1;
      return pa - pb;
    });
  }

  // Czas odpowiedzi modelu rośnie z długością TŁUMACZENIA, a paczki lecą równolegle —
  // więc zamiast pakować pod sam limit 4000 znaków, celujemy w tyle paczek, ile zmieści
  // się w jednej fali (MAX_PARALLEL). Mała strona schodzi wtedy w kilku krótkich
  // wywołaniach naraz zamiast w jednym długim; duża i tak dobija do limitu paczki.
  function batchCharBudget(sources) {
    let total = 0;
    for (const source of sources) total += source.length;
    return Math.min(
      CONFIG.BATCH_MAX_CHARS,
      Math.max(CONFIG.BATCH_MIN_CHARS, Math.ceil(total / CONFIG.MAX_PARALLEL)),
    );
  }

  function packBatches(sources) {
    const budget = batchCharBudget(sources);
    const batches = [];
    let current = [];
    let chars = 0;
    for (const source of sources) {
      if (current.length
        && (chars + source.length > budget
          || current.length >= CONFIG.BATCH_MAX_ITEMS)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(source);
      chars += source.length;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async function runPool(jobs, limit, worker) {
    const queue = [...jobs];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) await worker(queue.shift());
    });
    await Promise.all(runners);
  }

  // ---------------------------------------------------------------- komunikacja

  async function requestTranslations(texts) {
    let lastError;
    for (let attempt = 0; attempt <= CONFIG.SEND_RETRIES; attempt += 1) {
      try {
        return await sendBatch(texts);
      } catch (err) {
        lastError = err;
        // "message port closed" = service worker zginął w trakcie — ponowienie go wskrzesi.
        if (!/port closed|receiving end does not exist|brak odpowiedzi/i.test(err.message)) break;
        await new Promise((r) => setTimeout(r, CONFIG.SEND_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function sendBatch(texts) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'TRANSLATE_BATCH', texts }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response) return reject(new Error('brak odpowiedzi z background'));
          if (response.error) return reject(new Error(response.error));
          if (!Array.isArray(response.translations)
            || response.translations.length !== texts.length) {
            return reject(new Error('niepoprawna odpowiedź serwera'));
          }
          resolve(response.translations);
        });
      } catch (err) {
        reject(err); // kontekst rozszerzenia unieważniony (np. reload rozszerzenia)
      }
    });
  }

  function reportProgress() {
    try {
      chrome.runtime.sendMessage(
        { type: 'PROGRESS', done: state.done, total: state.total, failed: state.failed },
        () => void chrome.runtime.lastError,
      );
    } catch {
      // kontekst rozszerzenia mógł zniknąć — postęp jest tylko kosmetyką, nie przerywamy
    }
  }

  // ------------------------------------------------- treści doładowywane dynamicznie (SPA)

  function ensureObserver() {
    if (state.observer) return;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'characterData') {
          if (appliedTextValues.get(m.target) === m.target.nodeValue) continue; // nasza zmiana
          return scheduleRescan();
        }
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          return scheduleRescan();
        }
        if (m.type === 'attributes') {
          // Zmiana class/style/hidden/open może odsłonić wcześniej niewidoczny tekst;
          // własne setAttribute też tu trafia, ale rescan jest wtedy pusty i tani.
          return scheduleRescan();
        }
      }
    });
    // documentElement zamiast body: Turbo/PJAX podmieniają cały <body>, a obserwacja
    // powiązana ze starym body ślepnie po takiej nawigacji.
    observer.observe(document.documentElement, OBSERVER_OPTIONS);
    state.observer = observer;
  }

  // Obserwacja subtree NIE przekracza granicy shadow DOM — każdy odkryty shadow root
  // musi zostać objęty osobno, inaczej re-render web-componentów cichnie na zawsze.
  function observeShadowRoot(shadowRoot) {
    if (!state.observer || observedShadowRoots.has(shadowRoot)) return;
    state.observer.observe(shadowRoot, OBSERVER_OPTIONS);
    observedShadowRoots.add(shadowRoot);
  }

  function scheduleRescan() {
    clearTimeout(state.rescanTimer);
    state.rescanTimer = setTimeout(() => translatePage(), CONFIG.RESCAN_DEBOUNCE_MS);
  }
})();
