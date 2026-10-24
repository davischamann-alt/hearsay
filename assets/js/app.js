import { MOODS, parseCraving } from './mood.js';
import { coverage, currentPosition, geocode, milesBetween, nearbyPlaces, reverseGeocode, wordOfMouth } from './places.js';
import { rank } from './rank.js';

// Where people can ask for their city to be covered.
const REPO_URL = 'https://github.com/davischamann-alt/hearsay';
const SHOW_FIRST = 12;

const $ = (sel) => document.querySelector(sel);
const form = $('#search');
const cravingInput = $('#craving');
const locationInput = $('#location');
const radiusSelect = $('#radius');
const statusEl = $('#status');
const resultsEl = $('#results');
const quietEl = $('#quiet');

const picked = new Set();
let origin = load('hearsay:origin'); // { lat, lon, label }
let searchId = 0;

// ------------------------------------------------------------ helpers

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : u ? `https://${u}` : '');

const KIND_LABEL = { local: 'Local', press: 'Press', blog: 'Blog' };
const PLACE_KIND = {
  cafe: 'Café', bar: 'Bar', pub: 'Pub', fast_food: 'Quick bite', ice_cream: 'Ice cream',
  bakery: 'Bakery', pastry: 'Pastry', deli: 'Deli', biergarten: 'Beer garden',
  food_court: 'Food hall', restaurant: 'Restaurant',
};

function cuisineLabel(p) {
  const parts = p.cuisine.split(';').map((c) => c.trim().replace(/_/g, ' ')).filter(Boolean).slice(0, 2);
  if (!parts.length) return PLACE_KIND[p.kind] || 'Restaurant';
  return parts.map((c) => c[0].toUpperCase() + c.slice(1)).join(' · ');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', year: sameYear ? undefined : 'numeric', ...(sameYear ? { day: 'numeric' } : {}), timeZone: 'UTC' });
}

const miles = (m) => (m < 0.1 ? 'right here' : `${m < 10 ? m.toFixed(1) : Math.round(m)} mi`);

function directions(p) {
  const q = p.street ? `${p.name}, ${p.street}` : `${p.name} ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function setStatus(html, loading = false) {
  statusEl.innerHTML = html;
  statusEl.classList.toggle('loading', loading);
}

// ------------------------------------------------------------ rendering

function quoteItem(m) {
  const when = formatDate(m.date);
  return `<li class="quote">
    <blockquote>${esc(m.quote)}</blockquote>
    <cite><span class="kind">${KIND_LABEL[m.kind] || 'Source'}</span><a href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener">${esc(m.outlet)}${when ? ` · ${when}` : ''}</a></cite>
  </li>`;
}

function tally(p) {
  const counts = {};
  for (const m of p.mentions) counts[m.kind] = (counts[m.kind] || 0) + 1;
  const words = { local: ['local', 'locals'], press: ['press', 'press'], blog: ['blog', 'blogs'] };
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${words[k]?.[n === 1 ? 0 : 1] ?? k}`)
    .join(' · ');
}

function spotItem(p, i) {
  const first = p.quotes.slice(0, 2);
  const rest = p.quotes.slice(2);
  const others = p.otherLocations ? `+${p.otherLocations} more ${p.otherLocations === 1 ? 'location' : 'locations'}` : '';
  const meta = [cuisineLabel(p), miles(p.miles), p.street, others].filter(Boolean);
  return `<li class="spot" style="animation-delay:${Math.min(i, 8) * 40}ms">
    <span class="rank">${i + 1}</span>
    <div>
      <h2>${esc(p.name)}</h2>
      <p class="meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</p>
      <ul class="quotes">${first.map(quoteItem).join('')}</ul>
      ${rest.length ? `<details class="more"><summary>${rest.length} more ${rest.length === 1 ? 'mention' : 'mentions'}</summary><ul class="quotes">${rest.map(quoteItem).join('')}</ul></details>` : ''}
      <div class="actions">
        <span class="tally">${tally(p)}</span>
        <a href="${esc(directions(p))}" target="_blank" rel="noopener">Directions ↗</a>
        ${p.website ? `<a href="${esc(safeUrl(p.website))}" target="_blank" rel="noopener">Website ↗</a>` : ''}
      </div>
    </div>
  </li>`;
}

function renderResults(talked, quiet) {
  resultsEl.innerHTML = talked.slice(0, SHOW_FIRST).map(spotItem).join('');
  if (talked.length > SHOW_FIRST) {
    const more = document.createElement('li');
    more.className = 'empty';
    more.innerHTML = `<button type="button" class="mood">Show ${talked.length - SHOW_FIRST} more</button>`;
    more.querySelector('button').addEventListener('click', () => {
      more.remove();
      resultsEl.insertAdjacentHTML('beforeend', talked.slice(SHOW_FIRST).map((p, i) => spotItem(p, i + SHOW_FIRST)).join(''));
    });
    resultsEl.append(more);
  }

  const q = quiet.slice(0, 16);
  quietEl.innerHTML = q.length
    ? `<details ${talked.length ? '' : 'open'}><summary>${talked.length ? `${quiet.length} more nearby that fit, nobody’s talking about yet` : 'Nearby spots that fit'}</summary>
        <ul>${q.map((p) => `<li><a href="${esc(directions(p))}" target="_blank" rel="noopener">${esc(p.name)}</a><span>${esc(cuisineLabel(p))} · ${miles(p.miles)}</span></li>`).join('')}</ul>
      </details>`
    : '';
}

// ------------------------------------------------------------ search

async function resolveOrigin() {
  const typed = locationInput.value.trim();
  if (origin && (!typed || typed === origin.label)) return origin;
  if (typed) {
    const hit = await geocode(typed);
    if (!hit) throw new Error(`Couldn’t find “${typed}”. Try a city, neighborhood or zip code.`);
    return hit;
  }
  const pos = await currentPosition();
  return { ...pos, label: await reverseGeocode(pos) };
}

function cravingText() {
  return [cravingInput.value.trim(), ...picked].filter(Boolean).join(' ');
}

async function search() {
  const id = ++searchId;
  const craving = cravingText();
  const radius = +radiusSelect.value;
  resultsEl.innerHTML = '';
  quietEl.innerHTML = '';
  setStatus('Asking around', true);

  try {
    origin = await resolveOrigin();
    save('hearsay:origin', origin);
    locationInput.value = origin.label;
    syncUrl(craving);

    // Covered cities ship every spot with the collected quotes; anywhere
    // else we ask OpenStreetMap live and can only rank on fit and distance.
    const buzz = await wordOfMouth(origin).catch(() => null);
    let pool;
    if (buzz) {
      pool = [...buzz.places, ...buzz.quiet]
        .map((p) => ({ cuisine: '', street: '', website: '', mentions: [], ...p }))
        .filter((p) => milesBetween(origin, p) <= radius);
    } else {
      const slow = setTimeout(() => {
        if (id === searchId) setStatus('Still asking: the public map service is slow right now', true);
      }, 8000);
      pool = await nearbyPlaces(origin, radius).catch(() => null);
      clearTimeout(slow);
      if (!pool) throw new Error('The map service is busy right now. Give it a few seconds and try again.');
    }
    if (id !== searchId) return;

    const groups = parseCraving(craving);
    const { talked, quiet, fewFullMatches } = rank(pool, groups, origin);
    renderResults(talked, quiet);

    const what = craving ? `for <strong>${esc(craving)}</strong>` : 'people are talking about';
    const where = `near <strong>${esc(origin.label)}</strong>`;
    let line;
    if (talked.length) line = `${talked.length} ${talked.length === 1 ? 'spot' : 'spots'} ${what} ${where}`;
    else if (quiet.length) line = `No word of mouth ${craving ? `for <strong>${esc(craving)}</strong> ` : ''}${where} yet`;
    else line = `Nothing ${what} ${where}. Try a wider radius or a different craving.`;

    let note = '';
    if (buzz) {
      const s = buzz.scanned;
      const read = (s.local || 0) + (s.press || 0) + (s.blog || 0);
      note = `Ranked from ${read.toLocaleString()} local threads, reviews and articles · updated ${formatDate(buzz.updated)}`;
    } else {
      const ask = `${REPO_URL}/issues/new?title=${encodeURIComponent(`Add a city: ${origin.label}`)}`;
      note = `We haven’t gathered word of mouth around here yet, so these are just nearby independent spots. <a href="${ask}" target="_blank" rel="noopener">Ask for your city</a>.`;
    }
    const wider = [...radiusSelect.options].find((o) => +o.value > radius);
    if (fewFullMatches && wider) {
      note += `<br>Few spots nearby match all of that. <a href="#" id="widen">Look within ${wider.textContent}</a>.`;
    }
    setStatus(`${line}<span class="note">${note}</span>`);
    $('#widen')?.addEventListener('click', (e) => {
      e.preventDefault();
      radiusSelect.value = wider.value;
      search();
    });
  } catch (err) {
    if (id === searchId) setStatus(esc(err.message));
  }
}

function syncUrl(craving) {
  const params = new URLSearchParams();
  if (craving) params.set('q', craving);
  if (origin?.label) params.set('near', origin.label);
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}

// ------------------------------------------------------------ wiring

function init() {
  const moods = $('#moods');
  moods.innerHTML = MOODS.map((m) => `<button type="button" class="mood" aria-pressed="false">${esc(m)}</button>`).join('');
  moods.addEventListener('click', (e) => {
    const btn = e.target.closest('.mood');
    if (!btn) return;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', on);
    on ? picked.add(btn.textContent.toLowerCase()) : picked.delete(btn.textContent.toLowerCase());
    if (origin || locationInput.value.trim()) search();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });
  radiusSelect.addEventListener('change', () => { if (origin) search(); });

  $('#locate').addEventListener('click', async () => {
    const btn = $('#locate');
    btn.classList.add('on');
    setStatus('Finding you', true);
    try {
      const pos = await currentPosition();
      origin = { ...pos, label: await reverseGeocode(pos) };
      locationInput.value = origin.label;
      search();
    } catch (err) {
      setStatus(esc(err.message));
    } finally {
      btn.classList.remove('on');
    }
  });

  // Shared links: ?q=ramen&near=East Austin
  const params = new URLSearchParams(location.search);
  if (params.get('q')) cravingInput.value = params.get('q');
  if (params.get('near')) {
    locationInput.value = params.get('near');
    if (origin?.label !== params.get('near')) origin = null;
  } else if (origin) {
    locationInput.value = origin.label;
  }

  coverage().then((cities) => {
    if (!cities.length) return;
    const names = cities.map((c) => c.name.split(',')[0]);
    $('#coverage').textContent = `Word of mouth collected for ${names.join(', ')} so far.`;
    if (!locationInput.value) locationInput.placeholder = `city or neighborhood, e.g. ${names[0]}`;
  });

  if (params.get('q') || params.get('near')) search();
}

init();
