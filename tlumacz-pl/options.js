// options.js — ustawienia rozszerzenia.
// Klucz OpenAI i model trzymamy w chrome.storage.LOCAL (na urządzeniu, nie synchronizują się
// do chmury profilu). Tłumaczenie idzie wprost do OpenAI z background — bez własnego serwera.
const LOCAL_DEFAULTS = {
  apiKey: '',
  model: '',
};

// Musi zgadzać się z DEFAULT_MODEL w background.js — pusty model w storage = ten model.
const DEFAULT_MODEL = 'gpt-5.4';
// Listę modeli z konta trzymamy w storage, żeby lista otwierała się od razu po wejściu.
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// Ostatnio zapisany stan — "Zapisz" jest aktywny tylko wtedy, gdy pola się od niego różnią.
let saved = { apiKey: '', model: '' };
// Modele pobrane z konta (puste = jeszcze nie pobrano; wtedy lista pokazuje sam domyślny).
let models = [];
let modelsFetched = false;
let activeIndex = -1;

function setStatus(text, isError = false) {
  const status = $('status');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function setNote(text, isError = false) {
  const note = $('models-note');
  note.textContent = text;
  note.classList.toggle('error', isError);
}

function currentValues() {
  return { apiKey: $('apiKey').value.trim(), model: $('model').value.trim() };
}

function refreshSaveState() {
  const now = currentValues();
  $('save').disabled = now.apiKey === saved.apiKey && now.model === saved.model;
}

// ---- wybór modelu klikiem ----

// Co pokazujemy na liście: modele z konta (jeśli pobrane) albo sam domyślny,
// plus aktualnie zapisany model, gdyby go w tej liście nie było.
function menuModels() {
  const list = modelsFetched && models.length ? [...models] : [DEFAULT_MODEL];
  const current = $('model').value.trim();
  if (current && !list.includes(current)) list.unshift(current);
  if (!list.includes(DEFAULT_MODEL)) list.push(DEFAULT_MODEL);
  return list;
}

function effectiveModel() {
  return $('model').value.trim() || DEFAULT_MODEL;
}

function renderModelButton() {
  const value = $('model').value.trim();
  const current = $('model-current');
  current.textContent = value || DEFAULT_MODEL;
  if (!value) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'domyślny';
    current.append(tag);
  }
}

function checkIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'check');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 8.5 6.5 12 13 4.5');
  svg.append(path);
  return svg;
}

function renderMenu() {
  const menu = $('model-menu');
  const selected = effectiveModel();
  menu.textContent = '';
  for (const id of menuModels()) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.value = id;
    li.setAttribute('aria-selected', String(id === selected));
    li.append(checkIcon());
    const name = document.createElement('span');
    name.textContent = id;
    li.append(name);
    if (id === DEFAULT_MODEL) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'domyślny';
      li.append(tag);
    }
    li.addEventListener('click', () => selectModel(id));
    menu.append(li);
  }
  // Ostatnia pozycja: własny identyfikator (np. przypięty snapshot z datą).
  const custom = document.createElement('li');
  custom.className = 'custom';
  custom.setAttribute('role', 'option');
  custom.setAttribute('aria-selected', 'false');
  custom.dataset.custom = '1';
  custom.append(checkIcon());
  const label = document.createElement('span');
  label.textContent = 'Inny model — wpisz ręcznie…';
  custom.append(label);
  custom.addEventListener('click', () => {
    closeMenu();
    $('model-custom').hidden = false;
    $('model-custom').value = $('model').value.trim();
    $('model-custom').focus();
  });
  menu.append(custom);
}

function menuItems() {
  return [...$('model-menu').children];
}

function setActive(index) {
  const items = menuItems();
  if (!items.length) return;
  activeIndex = (index + items.length) % items.length;
  items.forEach((li, i) => li.classList.toggle('active', i === activeIndex));
  items[activeIndex].scrollIntoView({ block: 'nearest' });
}

function openMenu() {
  renderMenu();
  $('model-menu').hidden = false;
  $('model-button').setAttribute('aria-expanded', 'true');
  const selectedIndex = menuItems().findIndex((li) => li.getAttribute('aria-selected') === 'true');
  setActive(selectedIndex < 0 ? 0 : selectedIndex);
}

function closeMenu() {
  $('model-menu').hidden = true;
  $('model-button').setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function isMenuOpen() {
  return !$('model-menu').hidden;
}

function selectModel(id) {
  $('model').value = id === DEFAULT_MODEL && !$('model').value.trim() ? '' : id;
  $('model-custom').hidden = true;
  renderModelButton();
  refreshSaveState();
  closeMenu();
  $('model-button').focus();
}

// ---- pobranie listy modeli z konta (GET /v1/models przez background) ----

async function loadCachedModels() {
  const { modelsCache } = await chrome.storage.local.get({ modelsCache: null });
  if (modelsCache && Array.isArray(modelsCache.models) && modelsCache.models.length) {
    models = modelsCache.models;
    modelsFetched = true;
    const age = Date.now() - (modelsCache.ts || 0);
    setNote(`${models.length} modeli z Twojego konta${age > MODELS_TTL_MS ? ' (lista może być nieaktualna)' : ''}.`);
    return modelsCache.ts || 0;
  }
  setNote('Wpisz klucz poniżej i kliknij „Odśwież listę", żeby wybierać spośród modeli swojego konta.');
  return 0;
}

async function refreshModels(silent = false) {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    if (!silent) setNote('Najpierw wpisz klucz OpenAI API poniżej.', true);
    return;
  }
  $('refresh-models').disabled = true;
  if (!silent) setNote('Pobieram listę modeli…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', apiKey });
    if (result?.ok && Array.isArray(result.models) && result.models.length) {
      models = result.models;
      modelsFetched = true;
      await chrome.storage.local.set({ modelsCache: { ts: Date.now(), models } });
      setNote(`${models.length} modeli z Twojego konta.`);
      if (isMenuOpen()) openMenu();
    } else if (!silent) {
      setNote('Nie udało się pobrać listy: ' + (result?.error ?? 'nieznany błąd'), true);
    }
  } catch (err) {
    if (!silent) setNote('Nie udało się pobrać listy: ' + (err?.message ?? err), true);
  } finally {
    $('refresh-models').disabled = false;
  }
}

// ---- zapis / odczyt ustawień ----

async function restore() {
  const local = await chrome.storage.local.get(LOCAL_DEFAULTS);
  $('apiKey').value = local.apiKey;
  $('model').value = local.model;
  saved = { apiKey: (local.apiKey || '').trim(), model: (local.model || '').trim() };
  renderModelButton();
  refreshSaveState();

  const cachedAt = await loadCachedModels();
  // Klucz jest, a listy nie ma (albo jest stara) — odśwież w tle, bez krzyczenia o błędach.
  if (saved.apiKey && Date.now() - cachedAt > MODELS_TTL_MS) refreshModels(true);
}

async function save(event) {
  event.preventDefault();
  const values = currentValues();
  await chrome.storage.local.set(values);
  const keyChanged = values.apiKey !== saved.apiKey;
  saved = values;
  // pokaż dokładnie to, co poszło do storage (bez spacji na brzegach)
  $('apiKey').value = values.apiKey;
  refreshSaveState();
  setStatus('Zapisano.');
  setTimeout(() => setStatus(''), 2500);
  if (keyChanged && values.apiKey) refreshModels(true); // nowy klucz = nowa lista modeli
}

// Realny test: przetłumacz jedno słowo podanym kluczem/modelem (przez background → OpenAI).
async function testConnection() {
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  if (!apiKey) {
    setStatus('Wpisz klucz OpenAI API, żeby przetestować tłumaczenie.', true);
    return;
  }
  setStatus('Testuję…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_KEY', apiKey, model });
    if (result?.ok) {
      setStatus('OK — klucz działa ("hello" → "' + result.sample + '").');
    } else {
      setStatus('Błąd: ' + (result?.error ?? 'nieznany'), true);
    }
  } catch (err) {
    setStatus('Nie udało się przetestować: ' + (err?.message ?? err), true);
  }
}

// ---- statystyki użycia ----

const nf = new Intl.NumberFormat('pl-PL');

function statRow(list, label, value, sub = '', good = false) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (good) dd.classList.add('good');
  if (sub) {
    const span = document.createElement('span');
    span.className = 'sub';
    span.textContent = sub;
    dd.append(span);
  }
  list.append(dt, dd);
}

async function renderStats() {
  let data = null;
  try {
    data = await chrome.runtime.sendMessage({ type: 'USAGE_STATS' });
  } catch { /* service worker śpi — pokażemy pustkę */ }
  const list = $('stats-list');
  list.textContent = '';
  const s = data?.stats;
  if (!s || !s.segments) {
    $('stats-since').textContent = 'Brak danych — przetłumacz jakąś stronę.';
    $('reset-stats').disabled = true;
    return;
  }
  const pct = Math.round((s.fromCache / s.segments) * 100);
  const avg = s.apiCalls ? Math.round(s.apiMs / s.apiCalls) : 0;
  statRow(list, 'Przetłumaczone fragmenty', nf.format(s.segments));
  statRow(list, 'Z pamięci (bez sieci)', nf.format(s.fromCache), `${pct}%`, pct >= 50);
  statRow(list, 'Pobrane z OpenAI', nf.format(s.fromApi));
  statRow(list, 'Zapytania do OpenAI', nf.format(s.apiCalls), `śr. ${nf.format(avg)} ms`);
  statRow(list, 'Znaki wysłane do OpenAI', nf.format(s.charsSent));
  statRow(list, 'Znaki zaoszczędzone przez pamięć', nf.format(s.charsSaved), '', s.charsSaved > 0);
  if (s.failed) statRow(list, 'Nieprzetłumaczone fragmenty', nf.format(s.failed));
  statRow(list, 'Tryb rozumowania modelu', data.effort === '__pomin' ? 'parametr pominięty' : data.effort);
  const since = new Date(s.since);
  $('stats-since').textContent = 'Liczone od ' + since.toLocaleString('pl-PL',
    { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    + ` · model ${data.model}`;
  $('reset-stats').disabled = false;
}

async function resetStats() {
  await chrome.runtime.sendMessage({ type: 'RESET_STATS' });
  renderStats();
}

// ---- pamięć tłumaczeń (przyspiesza kolejne podstrony domeny) ----

async function renderCacheInfo() {
  let entries = 0;
  try {
    entries = (await chrome.runtime.sendMessage({ type: 'CACHE_STATS' }))?.entries ?? 0;
  } catch { /* service worker mógł jeszcze nie wstać — pokażemy 0 */ }
  $('cache-info').textContent = entries
    ? `${entries} zapamiętanych fragmentów — kolejne podstrony tej samej domeny nie wysyłają ich ponownie.`
    : 'Pusta — zapełni się w trakcie tłumaczenia i przyspieszy kolejne podstrony.';
  $('clear-cache').disabled = !entries;
}

async function clearCache() {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  renderCacheInfo();
}

// ---- lista domen z automatycznym tłumaczeniem ----

async function renderDomains() {
  const { enabledDomains } = await chrome.storage.local.get({ enabledDomains: {} });
  const domains = Object.keys(enabledDomains || {}).sort();
  const list = $('domains-list');
  list.textContent = '';
  $('domains-empty').style.display = domains.length ? 'none' : '';
  for (const domain of domains) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = domain;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Usuń';
    remove.addEventListener('click', async () => {
      const current = (await chrome.storage.local.get({ enabledDomains: {} })).enabledDomains || {};
      delete current[domain];
      await chrome.storage.local.set({ enabledDomains: current });
      renderDomains();
    });
    li.append(name, remove);
    list.append(li);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  restore();
  renderDomains();
  renderCacheInfo();
  renderStats();
  $('clear-cache').addEventListener('click', clearCache);
  $('reset-stats').addEventListener('click', resetStats);
  $('form').addEventListener('submit', save);
  $('test').addEventListener('click', testConnection);
  $('apiKey').addEventListener('input', refreshSaveState);
  $('refresh-models').addEventListener('click', () => refreshModels(false));

  // rozwijana lista modeli
  $('model-button').addEventListener('click', () => (isMenuOpen() ? closeMenu() : openMenu()));
  $('model-button').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isMenuOpen()) openMenu();
      else setActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (!isMenuOpen()) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menuItems()[activeIndex]?.click();
    } else if (event.key === 'Escape') {
      closeMenu();
    }
  });
  document.addEventListener('click', (event) => {
    if (isMenuOpen() && !event.target.closest('.picker')) closeMenu();
  });

  // własny identyfikator modelu
  $('model-custom').addEventListener('input', () => {
    $('model').value = $('model-custom').value.trim();
    renderModelButton();
    refreshSaveState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabledDomains) renderDomains();
    // tłumaczenie w innej karcie odświeża liczniki na żywo
    if (changes.usageStats) renderStats();
    if (changes.translationCache) renderCacheInfo();
    // zapis z innej karty ustawień — zsynchronizuj wzorzec (i pole, jeśli user w nim nie pisze)
    for (const key of ['apiKey', 'model']) {
      if (!changes[key]) continue;
      const next = (changes[key].newValue ?? '').trim();
      if ($(key).value.trim() === saved[key]) $(key).value = next;
      saved[key] = next;
    }
    if (changes.model) renderModelButton();
    refreshSaveState();
  });
});
