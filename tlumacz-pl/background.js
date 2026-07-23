// background.js — service worker rozszerzenia.
// Rola: (1) po kliknięciu ikony wstrzykuje content.js do wszystkich ramek karty,
// (2) tłumaczy paczki tekstu WPROST przez OpenAI API — fetch z service workera korzysta
// z host_permissions i nie podlega CORS strony (żaden własny serwer nie jest potrzebny),
// (3) pobiera kursy walut, (4) pokazuje postęp/błąd na badge'u i w tooltipie ikony.

const LOCAL_DEFAULTS = {
  apiKey: '',
  model: '',
  apiBase: 'https://api.openai.com/v1', // można nadpisać (kompatybilny endpoint / test)
};
const DEFAULT_MODEL = 'gpt-5.4';

const DEFAULT_TITLE = 'Przetłumacz stronę na polski';
const FETCH_TIMEOUT_MS = 120_000;
const BADGE_CLEAR_MS = 5_000;
// Górny limit RÓWNOLEGŁYCH wywołań OpenAI liczony GLOBALNIE (wszystkie karty i ramki razem).
// Limit per-ramka nie wystarcza: strona z kilkoma iframe'ami zwielokrotniłaby go po cichu.
const MAX_CONCURRENT_CALLS = 8;

// Postęp per karta: tabId -> Map(frameId -> {done, total, failed}).
const progressByTab = new Map();
const badgeClearTimers = new Map(); // tabId -> timerId

// MV3 ubija service workera po ~30 s bezczynności, a trwający fetch NIE resetuje licznika.
// Podczas żądań w locie odpalamy co 20 s API rozszerzenia (keepalive), by długa odpowiedź
// LLM nie ubiła portu.
let inflightRequests = 0;
let keepaliveTimer = null;

function trackInflight(delta) {
  inflightRequests += delta;
  if (inflightRequests > 0 && !keepaliveTimer) {
    keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  } else if (inflightRequests <= 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

chrome.action.onClicked.addListener((tab) => handleActionClick(tab));

// Klik ikony PRZEŁĄCZA automatyczne tłumaczenie CAŁEJ DOMENY.
async function handleActionClick(tab) {
  if (!tab?.id) return;
  if (!/^https?:/i.test(tab.url ?? '')) {
    // chrome://, edge://, sklep rozszerzeń, PDF viewer — tam nie da się wstrzyknąć skryptu.
    showBadge(tab.id, 'n/a', '#64748b', 'Tej strony nie da się przetłumaczyć (strona systemowa)');
    scheduleBadgeClear(tab.id);
    return;
  }
  const domain = domainOf(tab.url);
  if (await isDomainEnabled(tab.url)) {
    await setDomainEnabled(domain, false);
    showBadge(tab.id, 'OFF', '#64748b',
      `Tłumacz — automatyczne tłumaczenie „${domain}" wyłączone (odśwież, by zobaczyć oryginał)`);
    scheduleBadgeClear(tab.id);
    return;
  }
  await setDomainEnabled(domain, true);
  await injectAndTranslate(tab.id, domain);
}

// Wstrzykuje content.js do wszystkich ramek karty i startuje tłumaczenie.
async function injectAndTranslate(tabId, domain) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch (err) {
    console.warn('Nie udało się wstrzyknąć content script:', err);
    showErrorIcon(tabId, 'Tłumacz — błąd: ' + (err?.message ?? err));
    return;
  }
  progressByTab.delete(tabId);
  if (domain) {
    chrome.action.setTitle({
      tabId,
      title: `Tłumacz — automatyczne tłumaczenie „${domain}" WŁĄCZONE (kliknij, by wyłączyć)`,
    }).catch(() => {});
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'START_TRANSLATION' });
  } catch (err) {
    console.warn('Nie udało się wystartować tłumaczenia:', err);
  }
}

// ---- domeny z włączonym automatycznym tłumaczeniem (chrome.storage.local) ----

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

async function getEnabledDomains() {
  const { enabledDomains } = await chrome.storage.local.get({ enabledDomains: {} });
  return enabledDomains && typeof enabledDomains === 'object' ? enabledDomains : {};
}

async function isDomainEnabled(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const domains = await getEnabledDomains();
  return Object.keys(domains).some((d) => host === d || host.endsWith('.' + d));
}

async function setDomainEnabled(domain, on) {
  if (!domain) return;
  const domains = await getEnabledDomains();
  if (on) domains[domain] = true;
  else delete domains[domain];
  await chrome.storage.local.set({ enabledDomains: domains });
}

// ---------------------------------------------------------------- wiadomości

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'TRANSLATE_BATCH') {
    translateBatch(message.texts)
      .then((translations) => sendResponse({ translations }))
      .catch((err) => {
        const reason = err?.message || String(err);
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          chrome.action.setTitle({ tabId, title: 'Tłumacz — błąd: ' + reason }).catch(() => {});
        }
        sendResponse({ error: reason });
      });
    return true; // odpowiedź asynchroniczna — port zostaje otwarty
  }

  if (message.type === 'TEST_KEY') {
    // Test z opcji: przetłumacz jedno słowo podanym kluczem/modelem.
    testKey(message.apiKey, message.model)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'USAGE_STATS') {
    (async () => {
      const [stats, map, settings] = await Promise.all([getUsage(), getCache(), getSettings()]);
      const model = (settings.model || '').trim() || DEFAULT_MODEL;
      sendResponse({ stats, entries: map.size, model, effort: await getEffort(model) });
    })().catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'RESET_STATS') {
    (async () => {
      usage = { ...EMPTY_STATS, since: Date.now() };
      usageDirty = false;
      clearTimeout(usageSaveTimer);
      usageSaveTimer = null;
      await chrome.storage.local.set({ [STATS_KEY]: usage });
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'CACHE_STATS') {
    getCache()
      .then((map) => sendResponse({ entries: map.size }))
      .catch(() => sendResponse({ entries: 0 }));
    return true;
  }

  if (message.type === 'CLEAR_CACHE') {
    getCache()
      .then(async (map) => {
        map.clear();
        cacheDirty = false;
        clearTimeout(cacheSaveTimer);
        cacheSaveTimer = null;
        await chrome.storage.local.remove(CACHE_KEY);
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'LIST_MODELS') {
    // Lista modeli do wyboru w opcjach — realne GET /v1/models z konta usera.
    listModels(message.apiKey)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'GET_RATES') {
    getRates()
      .then((rates) => sendResponse({ rates }))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true;
  }

  if (message.type === 'PROGRESS') {
    updateBadge(sender, message);
  }
});

async function getSettings() {
  return chrome.storage.local.get(LOCAL_DEFAULTS);
}

// ---------------------------------------------------------------- tłumaczenie (OpenAI)

const SYSTEM_PROMPT = [
  'Jesteś silnikiem tłumaczenia stron WWW.',
  'Dostaniesz obiekt JSON {"segments": [...]} z tablicą segmentów tekstu wyciętych ze strony',
  '(dowolny język źródłowy). Segmenty następują po sobie w kolejności występowania na stronie —',
  'wykorzystuj sąsiednie segmenty jako kontekst (fragmenty jednego zdania bywają rozcięte',
  'linkami lub wyróżnieniami), ale każdy segment tłumacz osobno.',
  'Przetłumacz każdy segment na język polski i zwróć obiekt {"translations": [...]}.',
  'Zasady bezwzględne:',
  '- zwróć DOKŁADNIE tyle samo elementów, w tym samym porządku (element i-ty = tłumaczenie segmentu i-tego);',
  '- niczego nie scalaj, nie dziel, nie pomijaj i nie dodawaj;',
  '- liczby, adresy, e-maile, fragmenty kodu, symbole, skróty jednostek (MB, GB, px, kbps)',
  '  i oznaczenia formatu (16:9, 1080p) zostawiaj bez zmian — ALE nazwy jednostek zapisane',
  '  słowem ODMIENIAJ po polsku: "48 hours" → "48 godzin", "10 minutes" → "10 minut",',
  '  "90 days" → "90 dni"; angielskie słowo w polskim zdaniu to błąd;',
  '- nazwy własne, marki i nazwy produktów zostawiaj w oryginale, chyba że mają utrwalony polski odpowiednik;',
  '- zachowaj rejestr i styl (nagłówek pozostaje zwięzłym nagłówkiem, CAPS pozostaje CAPS);',
  '- segment będący już poprawną polszczyzną przepisz bez zmian;',
  '- krótkie etykiety interfejsu (przyciski, pozycje menu, linki — kilka słów, bez kropki',
  '  na końcu) tłumacz możliwie NAJZWIĘŹLEJ, bo miejsce w UI jest ograniczone;',
  '- RÓŻNE terminy źródłowe muszą dostać RÓŻNE polskie odpowiedniki — nie zlewaj odrębnych',
  '  pojęć w jedno słowo. Dotyczy zwłaszcza nazw funkcji obok siebie w menu/stopce, np.',
  '  "crop" = kadruj, "trim" = przytnij, "clip" = wytnij fragment, "merge" = scal,',
  '  "compress" = kompresuj; jeśli dwie pozycje wyszłyby identycznie, dobierz precyzyjniejsze',
  '  słowo tak, by użytkownik odróżnił funkcje;',
  '- nie zostawiaj angielskiego słowa, gdy istnieje naturalny polski odpowiednik',
  '  ("workflow" → "przepływ pracy"/"praca", "super clean" → "bardzo przejrzysty" — NIE',
  '  "superczysty"); w oryginale zostają wyłącznie nazwy własne, marki, hashtagi i @nazwy;',
  '- unikaj kalek składniowych — pisz tak, jak napisałby to polski redaktor, a nie',
  '  słowo w słowo za angielskim;',
  '- nie dopisuj wyjaśnień ani komentarzy.',
].join('\n');

const RESPONSE_SCHEMA = {
  name: 'translations',
  strict: true,
  schema: {
    type: 'object',
    properties: { translations: { type: 'array', items: { type: 'string' } } },
    required: ['translations'],
    additionalProperties: false,
  },
};

// Błąd konfiguracji klucza — content.js pokaże go w tooltipie (badge ERR), zamiast cicho
// zostawiać oryginały.
class KeyError extends Error {}

// ---------------------------------------------------------------- reasoning_effort
// Modele rozumujące potrafią mielić po 100+ s na paczkę, więc prosimy o minimalne
// rozumowanie. Problem: każde konto/model przyjmuje inny zestaw wartości, a odrzucenie
// kosztuje PEŁNE żądanie (400) przed ponowieniem — w logu widać było „HTTP 400+200,
// wywołań: 2" przy KAŻDEJ paczce, czyli podwójny ruch bez żadnego zysku.
// Dlatego schodzimy po drabinie raz, a wynik zapamiętujemy per model.
// Kolejność preferencji: im mniej rozumowania, tym szybciej — a tłumaczenie zdaniami
// rozumowania nie potrzebuje. Zmierzone na gpt-5.4: z domyślnym rozumowaniem paczki
// potrafiły mielić 115–130 s (nawet timeout 120 s), z wymuszonym niskim: 2–8 s.
const EFFORT_PREFERENCE = ['none', 'minimal', 'low'];
const EFFORT_SKIP = '__pomin'; // wartownik: nie wysyłaj parametru w ogóle
const EFFORT_KEY = 'modelEffort';
const EFFORT_STRATEGY = 2; // podbij, gdy zmieni się logika doboru — wymusza ponowne wykrycie
let effortByModel = null; // Map(model -> wartość akceptowana przez API)

async function getEffort(model) {
  if (!effortByModel) {
    const stored = (await chrome.storage.local.get({ [EFFORT_KEY]: null }))[EFFORT_KEY];
    const usable = stored && stored.v === EFFORT_STRATEGY ? stored.byModel : {};
    effortByModel = new Map(Object.entries(usable || {}));
  }
  return effortByModel.get(model) ?? EFFORT_PREFERENCE[0];
}

async function rememberEffort(model, value) {
  effortByModel.set(model, value);
  await chrome.storage.local.set({
    [EFFORT_KEY]: { v: EFFORT_STRATEGY, byModel: Object.fromEntries(effortByModel) },
  });
}

// OpenAI w treści błędu WYPISUJE dozwolone wartości ("Supported values are: 'none',
// 'low', 'medium'…"), więc nie zgadujemy — czytamy je i bierzemy najtańszą, której
// jeszcze nie próbowaliśmy. Działa też dla bramek zgodnych z API o innym zestawie.
function pickEffortFromError(body, tried) {
  const listed = new Set([...body.matchAll(/'([a-z]+)'/gi)].map((m) => m[1].toLowerCase()));
  const pick = EFFORT_PREFERENCE.find((v) => listed.has(v) && !tried.has(v));
  if (pick) return pick;
  // Brak listy w błędzie (inna bramka) — spróbuj kolejnej preferencji po kolei.
  return EFFORT_PREFERENCE.find((v) => !tried.has(v)) ?? EFFORT_SKIP;
}

// ---------------------------------------------------------------- pamięć tłumaczeń
// Cache przeżywający przeładowanie strony i wspólny dla WSZYSTKICH kart/ramek. To on
// robi robotę w trybie „tłumacz całą domenę": kolejne podstrony serwisu powtarzają
// nawigację, stopkę i terminologię, a przy powrocie na stronę nie ma już czego wysyłać.
const CACHE_KEY = 'translationCache';
// Podbijaj przy KAŻDEJ zmianie SYSTEM_PROMPT — inaczej stare wpisy (przetłumaczone starą
// instrukcją) przykrywałyby poprawkę i zmiana promptu nie byłaby widoczna na stronach,
// które user już odwiedził. Wersja 2: reguła o nie zlewaniu różnych terminów (crop/trim).
const CACHE_VERSION = 3;
const CACHE_MAX_ENTRIES = 5000;
const CACHE_SAVE_DEBOUNCE_MS = 1500;

let cache = null; // Map(model\0źródło -> tłumaczenie), kolejność wstawiania = kolejność LRU
let cacheDirty = false;
let cacheSaveTimer = null;

const cacheKey = (model, source) => model + '\u0000' + source;

async function getCache() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get({ [CACHE_KEY]: null });
  const raw = stored[CACHE_KEY];
  const usable = raw && raw.v === CACHE_VERSION && Array.isArray(raw.entries) ? raw.entries : [];
  cache = new Map(usable);
  return cache;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (hit === undefined) return undefined;
  map.delete(key); // odśwież pozycję w kolejce LRU
  map.set(key, hit);
  return hit;
}

function cachePut(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX_ENTRIES) map.delete(map.keys().next().value);
  cacheDirty = true;
  if (!cacheSaveTimer) cacheSaveTimer = setTimeout(saveCache, CACHE_SAVE_DEBOUNCE_MS);
}

async function saveCache() {
  cacheSaveTimer = null;
  if (!cacheDirty || !cache) return;
  cacheDirty = false;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: { v: CACHE_VERSION, entries: [...cache] } });
  } catch (err) {
    // Np. przekroczony limit storage — cache dalej działa w pamięci service workera.
    console.warn('[Tlumacz] nie udało się zapisać cache tłumaczeń:', err?.message ?? err);
  }
}

// ---------------------------------------------------------------- statystyki użycia
// Liczone w background, bo tylko on widzi WSZYSTKIE karty i ramki. Zapisywane z opóźnieniem
// (jak cache), żeby seria paczek nie generowała serii zapisów do storage.
const STATS_KEY = 'usageStats';
const STATS_SAVE_DEBOUNCE_MS = 1500;
const EMPTY_STATS = {
  since: 0, segments: 0, fromCache: 0, fromApi: 0,
  charsSent: 0, charsSaved: 0, apiCalls: 0, apiMs: 0, failed: 0,
};
let usage = null;
let usageDirty = false;
let usageSaveTimer = null;

async function getUsage() {
  if (!usage) {
    const stored = (await chrome.storage.local.get({ [STATS_KEY]: null }))[STATS_KEY];
    usage = { ...EMPTY_STATS, ...(stored || {}) };
    if (!usage.since) usage.since = Date.now();
  }
  return usage;
}

function bumpUsage(patch) {
  if (!usage) return;
  for (const [k, v] of Object.entries(patch)) usage[k] += v;
  usageDirty = true;
  if (!usageSaveTimer) {
    usageSaveTimer = setTimeout(async () => {
      usageSaveTimer = null;
      if (!usageDirty) return;
      usageDirty = false;
      try {
        await chrome.storage.local.set({ [STATS_KEY]: usage });
      } catch { /* statystyki są kosmetyką — nie przerywamy tłumaczenia */ }
    }, STATS_SAVE_DEBOUNCE_MS);
  }
}

// ---------------------------------------------------------------- limit równoległości
// Semafor na SAMYM wywołaniu HTTP: ponowienia i rekurencyjne podziały paczek też się
// przez niego przeciskają, więc konta nie zalewamy niezależnie od liczby ramek.
let activeCalls = 0;
const waitingCalls = [];

async function withApiSlot(fn) {
  if (activeCalls >= MAX_CONCURRENT_CALLS) await new Promise((r) => waitingCalls.push(r));
  activeCalls += 1;
  try {
    return await fn();
  } finally {
    activeCalls -= 1;
    waitingCalls.shift()?.();
  }
}

// Tłumaczy jedną paczkę (już pociętą przez content.js). Zwraca tablicę tej samej długości;
// element = string (tłumaczenie) lub null (segment nieprzetłumaczony — content.js oznaczy
// go jako nieudany i zostawi oryginał). Rzuca przy błędzie klucza (401) lub braku klucza.
async function translateBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const { apiKey, model, apiBase } = await getSettings();
  if (!apiKey) throw new KeyError('Brak klucza OpenAI — wpisz go w opcjach wtyczki.');
  const cfg = {
    apiKey,
    model: (model || '').trim() || DEFAULT_MODEL,
    apiBase: (apiBase || LOCAL_DEFAULTS.apiBase).replace(/\/+$/, ''),
  };

  // 1) Co już umiemy — z cache (zero sieci). 2) Reszta idzie do modelu.
  const map = await getCache();
  await getUsage();
  const out = new Array(texts.length).fill(null);
  const missIndexes = [];
  const missTexts = [];
  let charsSaved = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const cached = cacheGet(map, cacheKey(cfg.model, texts[i]));
    if (typeof cached === 'string') {
      out[i] = cached;
      charsSaved += texts[i].length; // znaki, których NIE wysłaliśmy dzięki pamięci
    } else {
      missIndexes.push(i);
      missTexts.push(texts[i]);
    }
  }
  const hits = texts.length - missTexts.length;
  bumpUsage({ segments: texts.length, fromCache: hits, charsSaved });
  if (!missTexts.length) {
    console.debug(`[Tlumacz] paczka ${texts.length} segm.: wszystko z cache, 0 ms sieci`);
    return out;
  }

  trackInflight(1);
  const started = Date.now();
  const stats = { retries: 0, statuses: [], queuedMs: 0, attemptMs: [] };
  try {
    const fresh = await callModel(missTexts, cfg, 0, stats);
    for (let k = 0; k < missIndexes.length; k += 1) {
      const value = fresh[k];
      out[missIndexes[k]] = value;
      // Do cache trafiają tylko udane tłumaczenia — nieudane mają być ponowione.
      if (typeof value === 'string' && value.trim()) {
        cachePut(map, cacheKey(cfg.model, missTexts[k]), value);
      }
    }
    const took = Date.now() - started;
    const charsSent = missTexts.reduce((s, t) => s + t.length, 0);
    bumpUsage({
      fromApi: missTexts.length,
      charsSent,
      apiCalls: stats.statuses.length || 1,
      apiMs: took,
      failed: fresh.filter((v) => typeof v !== 'string' || !v.trim()).length,
    });
    const detail = [
      `${missTexts.reduce((s, t) => s + t.length, 0)} znaków`,
      `${activeCalls} równoległych`,
      `HTTP ${stats.statuses.join('+') || '?'}`,
      stats.attemptMs.length > 1 ? `czasy wywolan: ${stats.attemptMs.join('+')} ms` : null,
      `effort=${await getEffort(cfg.model)}`,
      stats.retries ? `PONOWIENIA: ${stats.retries}` : null,
      stats.queuedMs > 200 ? `czekanie w kolejce ${stats.queuedMs} ms` : null,
      stats.statuses.length > 1 ? `wywołań: ${stats.statuses.length}` : null,
    ].filter(Boolean).join(', ');
    console.debug(`[Tlumacz] paczka ${texts.length} segm.: ${hits} z cache, `
      + `${missTexts.length} z OpenAI w ${took} ms (${detail})`);
    return out;
  } finally {
    trackInflight(-1);
  }
}

async function callModel(texts, cfg, attempt = 0, stats = null) {
  if (!texts.length) return [];

  const isReasoning = /^(gpt-5|o\d)/i.test(cfg.model);
  const request = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ segments: texts }) },
    ],
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
  };
  // Zapamiętana wartość = zero marnowanych żądań przy kolejnych paczkach.
  let effort = isReasoning ? await getEffort(cfg.model) : EFFORT_SKIP;
  const tried = new Set();
  if (effort !== EFFORT_SKIP) request.reasoning_effort = effort;

  let response = await openAiFetch(cfg, request, 0, stats);
  // Odrzucenie wartości kosztuje pełne żądanie, więc wykrycie robimy RAZ na model
  // i zapisujemy wynik — nie raz na paczkę (tak było: „HTTP 400+200" przy każdej).
  while (response.status === 400 && request.reasoning_effort) {
    const body = await response.clone().text().catch(() => '');
    if (!/reasoning_effort/i.test(body)) break; // 400 z innego powodu — nie maskuj go
    tried.add(effort);
    const next = pickEffortFromError(body, tried);
    console.warn(`[Tlumacz] model ${cfg.model} odrzucił reasoning_effort="${effort}" — `
      + `${next === EFFORT_SKIP ? 'pomijam parametr' : `przechodzę na "${next}"`}. `
      + `Odpowiedź API: ${body.slice(0, 200)}`);
    effort = next;
    await rememberEffort(cfg.model, effort);
    if (effort === EFFORT_SKIP) delete request.reasoning_effort;
    else request.reasoning_effort = effort;
    response = await openAiFetch(cfg, request, 0, stats);
  }
  if (response.ok && request.reasoning_effort === effort) await rememberEffort(cfg.model, effort);

  if (response.status === 401) {
    throw new KeyError('Niepoprawny klucz OpenAI (odrzucony przez OpenAI, 401).');
  }
  if (!response.ok) {
    // Przejściowe (429/5xx po ponowieniach w openAiFetch) — segmenty wracają w oryginale.
    console.warn('[Tlumacz] OpenAI HTTP', response.status);
    return texts.map(() => null);
  }

  let data;
  try { data = await response.json(); } catch { return texts.map(() => null); }
  const choice = data.choices?.[0];

  if (choice?.message?.refusal) {
    console.warn('[Tlumacz] model odmówił tłumaczenia:', choice.message.refusal);
    return texts.map(() => null);
  }
  if (choice?.finish_reason === 'length' && texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const [left, right] = await Promise.all([
      callModel(texts.slice(0, mid), cfg, attempt, stats),
      callModel(texts.slice(mid), cfg, attempt, stats),
    ]);
    return [...left, ...right];
  }

  let parsed = null;
  try { parsed = JSON.parse(choice?.message?.content ?? ''); } catch { /* niżej */ }
  const translations = Array.isArray(parsed?.translations) ? parsed.translations : null;

  if (!translations || translations.length !== texts.length) {
    if (attempt < 1) return callModel(texts, cfg, attempt + 1, stats);
    return texts.map((_, i) => cleanItem(translations?.[i]));
  }
  return translations.map((candidate) => cleanItem(candidate));
}

// POST do OpenAI z timeoutem i prostym retry na 429/5xx/sieć (SDK nie ma, więc ręcznie).
// `stats` zbiera przebieg (ponowienia, kody HTTP, czekanie w kolejce) — bez tego nie da się
// odróżnić „model myślał długo" od „dostaliśmy 429 i odczekaliśmy backoff".
async function openAiFetch(cfg, request, retry = 0, stats = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const queuedAt = Date.now();
    let sentAt = queuedAt;
    const response = await withApiSlot(() => {
      sentAt = Date.now();
      if (stats) stats.queuedMs += sentAt - queuedAt;
      return fetch(cfg.apiBase + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    });
    if (stats) {
      stats.statuses.push(response.status);
      stats.attemptMs.push(Date.now() - sentAt); // ile trwało KONKRETNE wywołanie
    }
    if ((response.status === 429 || response.status >= 500) && retry < 2) {
      if (stats) stats.retries += 1;
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      return openAiFetch(cfg, request, retry + 1, stats);
    }
    return response;
  } catch (err) {
    if (stats) {
      stats.statuses.push(err?.name === 'AbortError' ? 'timeout' : 'sieć');
      stats.retries += 1;
    }
    if (retry < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
      return openAiFetch(cfg, request, retry + 1, stats);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function cleanItem(candidate) {
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

// Test klucza z opcji: przetłumacz jedno słowo i zwróć wynik.
async function testKey(apiKey, model) {
  const key = (apiKey || '').trim();
  if (!key) return { ok: false, error: 'Wpisz klucz OpenAI API.' };
  const { apiBase } = await getSettings();
  const cfg = {
    apiKey: key,
    model: (model || '').trim() || DEFAULT_MODEL,
    apiBase: (apiBase || LOCAL_DEFAULTS.apiBase).replace(/\/+$/, ''),
  };
  const out = await callModel(['hello'], cfg);
  const translated = out[0];
  if (typeof translated === 'string' && translated.toLowerCase() !== 'hello') {
    return { ok: true, sample: translated };
  }
  return { ok: false, error: 'Klucz odpowiada, ale nic nie przetłumaczył — sprawdź model.' };
}

// ---------------------------------------------------------------- lista modeli

// Odsiewamy z /v1/models wszystko, co nie jest tekstowym modelem czatu (audio, obrazy,
// embeddingi, moderacja, transkrypcja) — do tłumaczenia i tak nadaje się tylko czat.
const MODEL_EXCLUDE = /(audio|realtime|transcribe|tts|whisper|image|dall|embedding|moderation|instruct|search|computer-use|codex|davinci|babbage)/i;
// Snapshoty datowane (…-2025-04-14, …-0613) chowamy — bazowe id starczy, a pinowanie
// konkretnej daty nadal działa przez „Inny model".
const MODEL_SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

function isChatModel(id) {
  return /^(gpt-|o[1-9]|chatgpt-)/i.test(id) && !MODEL_EXCLUDE.test(id) && !MODEL_SNAPSHOT.test(id);
}

// Sort: najpierw najnowsze gpt-N (malejąco po numerze), potem seria o*, potem reszta;
// w obrębie rodziny krótsze (bazowe) id przed wariantami.
function modelSortKey(id) {
  const gpt = /^gpt-(\d+(?:\.\d+)?)/i.exec(id);
  if (gpt) return [0, -parseFloat(gpt[1]), id.length, id];
  if (/^o\d/i.test(id)) return [1, 0, id.length, id];
  return [2, 0, id.length, id];
}

function sortModels(ids) {
  return ids.sort((a, b) => {
    const ka = modelSortKey(a);
    const kb = modelSortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

async function listModels(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) return { ok: false, error: 'Najpierw wpisz klucz OpenAI API poniżej.' };
  const { apiBase } = await getSettings();
  const base = (apiBase || LOCAL_DEFAULTS.apiBase).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(base + '/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.status === 401) return { ok: false, error: 'Niepoprawny klucz OpenAI (401).' };
    if (!response.ok) return { ok: false, error: `OpenAI odpowiedziało HTTP ${response.status}.` };
    const data = await response.json();
    const all = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter((id) => typeof id === 'string') : [];
    const models = sortModels(all.filter(isChatModel));
    if (!models.length) return { ok: false, error: 'Konto nie udostępnia żadnego modelu czatu.' };
    return { ok: true, models, total: all.length };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- kursy walut

const RATES_TTL_MS = 6 * 60 * 60 * 1000; // 6 h — kursy ECB zmieniają się raz dziennie
let ratesCache = null; // { ts, rates }

async function getRates() {
  if (ratesCache && Date.now() - ratesCache.ts < RATES_TTL_MS) return ratesCache.rates;
  const stored = await chrome.storage.local.get({ ratesCache: null });
  if (stored.ratesCache && Date.now() - stored.ratesCache.ts < RATES_TTL_MS) {
    ratesCache = stored.ratesCache;
    return ratesCache.rates;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Kanoniczny host (api.frankfurter.app przekierowuje tu 301). from=PLN => rates[X]=X/1PLN.
    const response = await fetch('https://api.frankfurter.dev/v1/latest?from=PLN', {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`kursy: HTTP ${response.status}`);
    const data = await response.json();
    if (!data.rates || typeof data.rates !== 'object') throw new Error('kursy: zły format');
    ratesCache = { ts: Date.now(), rates: data.rates };
    chrome.storage.local.set({ ratesCache }).catch(() => {});
    return ratesCache.rates;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- badge / postęp

function updateBadge(sender, { done = 0, total = 0, failed = 0 }) {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  let frames = progressByTab.get(tabId);
  if (!frames) progressByTab.set(tabId, (frames = new Map()));
  frames.set(sender.frameId ?? 0, { done, total, failed });

  let sumDone = 0;
  let sumTotal = 0;
  let sumFailed = 0;
  for (const f of frames.values()) {
    sumDone += f.done;
    sumTotal += f.total;
    sumFailed += f.failed;
  }

  clearTimeout(badgeClearTimers.get(tabId));
  badgeClearTimers.delete(tabId);

  if (!sumTotal) {
    restoreIcon(tabId);
    showBadge(tabId, 'OK', '#0e7490', 'Brak nowych tekstów do tłumaczenia');
    scheduleBadgeClear(tabId);
    return;
  }

  const finished = sumDone >= sumTotal;
  if (!finished) {
    restoreIcon(tabId);
    showBadge(tabId, `${Math.floor((sumDone / sumTotal) * 100)}%`, '#0e7490', DEFAULT_TITLE);
    return;
  }
  if (sumFailed) {
    // Błąd: czerwone kółko z białym X na ikonie (przyczyna w tooltipie ustawionym przy błędzie).
    showErrorIcon(tabId);
  } else {
    restoreIcon(tabId);
    showBadge(tabId, 'OK', '#0e7490', DEFAULT_TITLE);
    scheduleBadgeClear(tabId);
  }
}

// ---- ikona błędu: czerwone kółko z białym X nałożone na ikonę wtyczki ----

const DEFAULT_ICON_PATH = {
  16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png',
};
const errorIconTabs = new Set(); // karty z aktywną ikoną błędu
let errorIconDataPromise = null;

// Renderuje (raz) ImageData ikony błędu dla rozmiarów 16/32/48 — OffscreenCanvas w SW.
function getErrorIconData() {
  if (!errorIconDataPromise) {
    errorIconDataPromise = (async () => {
      const out = {};
      for (const size of [16, 32, 48]) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        try {
          const src = size <= 16 ? 16 : (size <= 32 ? 32 : 48);
          const blob = await (await fetch(chrome.runtime.getURL('icons/icon' + src + '.png'))).blob();
          ctx.drawImage(await createImageBitmap(blob), 0, 0, size, size);
        } catch { /* brak bazy — zostanie samo kółko */ }
        const r = size * 0.34;
        const cx = size - r;
        const cy = size - r;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fillStyle = '#dc2626'; // czerwone kółko
        ctx.fill();
        ctx.lineWidth = Math.max(1, size * 0.04); // biała obwódka dla kontrastu
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.lineCap = 'round'; // biały X
        ctx.lineWidth = Math.max(1.4, size * 0.085);
        const d = r * 0.46;
        ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
        ctx.stroke();
        out[size] = ctx.getImageData(0, 0, size, size);
      }
      return out;
    })();
  }
  return errorIconDataPromise;
}

async function showErrorIcon(tabId, title) {
  self.__lastErrorTab = tabId; // hak dla testu E2E
  clearTimeout(badgeClearTimers.get(tabId));
  badgeClearTimers.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}); // żadnego „ERR" tekstem
  if (title !== undefined) chrome.action.setTitle({ tabId, title }).catch(() => {});
  try {
    await chrome.action.setIcon({ tabId, imageData: await getErrorIconData() });
    errorIconTabs.add(tabId);
    self.__errorIconRendered = tabId; // hak dla testu: renderowana ikona (nie fallback)
  } catch {
    // Gdyby OffscreenCanvas/setIcon zawiódł — nie milcz, pokaż choć znak X.
    self.__errorIconRendered = false;
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: '✕' }).catch(() => {});
  }
}

function restoreIcon(tabId) {
  if (!errorIconTabs.has(tabId)) return;
  errorIconTabs.delete(tabId);
  chrome.action.setIcon({ tabId, path: DEFAULT_ICON_PATH }).catch(() => {});
}

function showBadge(tabId, text, color, title) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (title !== undefined) {
    chrome.action.setTitle({ tabId, title }).catch(() => {});
  }
}

function scheduleBadgeClear(tabId) {
  clearTimeout(badgeClearTimers.get(tabId));
  badgeClearTimers.set(tabId, setTimeout(() => {
    badgeClearTimers.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }, BADGE_CLEAR_MS));
}

function resetTab(tabId) {
  progressByTab.delete(tabId);
  clearTimeout(badgeClearTimers.get(tabId));
  badgeClearTimers.delete(tabId);
  restoreIcon(tabId); // przywróć zwykłą ikonę (skasuj czerwone kółko po błędzie)
}

chrome.tabs.onRemoved.addListener(resetTab);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') {
    resetTab(tabId); // nawigacja = nowy stan strony
    chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => {});
    return;
  }
  // Po pełnym załadowaniu podstrony na włączonej domenie — przetłumacz automatycznie.
  if (info.status === 'complete' && /^https?:/i.test(tab?.url ?? '')) {
    isDomainEnabled(tab.url).then((enabled) => {
      if (enabled) injectAndTranslate(tabId, domainOf(tab.url));
    }).catch(() => {});
  }
});
