// Where things are: geocoding, nearby spots from OpenStreetMap, and the
// word-of-mouth files the collector writes to data/.

import { normalize } from './mood.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const MILE = 1609.34;

export function milesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return (2 * 6371000 * Math.asin(Math.sqrt(h))) / MILE;
}

async function getJSON(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const signal = options.signal ? AbortSignal.any([ctrl.signal, options.signal]) : ctrl.signal;
    const res = await fetch(url, { ...options, signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, fn) {
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return Promise.resolve(JSON.parse(hit));
  } catch { /* storage unavailable */ }
  return fn().then((value) => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked */ }
    return value;
  });
}

export function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  return cached(`geo:${query.toLowerCase()}`, async () => {
    const [hit] = await getJSON(url, { headers: { 'Accept-Language': 'en' } });
    if (!hit) return null;
    return { lat: +hit.lat, lon: +hit.lon, label: hit.name || hit.display_name.split(',')[0] };
  });
}

export async function reverseGeocode({ lat, lon }) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lon}`;
    const r = await getJSON(url, { headers: { 'Accept-Language': 'en' } }, 8000);
    const a = r.address || {};
    return a.neighbourhood || a.suburb || a.city_district || a.city || a.town || a.village || 'you';
  } catch {
    return 'you';
  }
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available in this browser.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('Couldn’t get your location. Type a city or neighborhood instead.')),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  });
}

function toPlace(el) {
  const t = el.tags || {};
  if (t.brand || t['brand:wikidata'] || !t.name) return null; // skip chains
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null) return null;
  return {
    id: `${el.type}/${el.id}`,
    name: t.name,
    lat, lon,
    kind: t.amenity || t.shop,
    cuisine: t.cuisine || '',
    street: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
    website: t.website || t['contact:website'] || '',
    mentions: [],
  };
}

// National chains OpenStreetMap doesn't always tag with a brand.
let chainList;
async function isChain() {
  chainList ??= getJSON('data/chains.json').then((keys) => keys.map((k) => k.split(' '))).catch(() => []);
  const chains = await chainList;
  return (name) => {
    const words = normalize(name).split(' ');
    return chains.some((c) => c.every((w, i) => words[i] === w));
  };
}

export async function nearbyPlaces({ lat, lon }, miles) {
  const r = Math.round(miles * MILE);
  const q = `[out:json][timeout:60];(
    nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|biergarten)$"]["name"](around:${r},${lat},${lon});
    nwr["shop"~"^(bakery|pastry|deli)$"]["name"](around:${r},${lat},${lon});
  );out center tags;`;
  const key = `osm:${lat.toFixed(3)},${lon.toFixed(3)},${miles}`;
  const chain = await isChain();
  const places = await cached(key, async () => {
    // Public Overpass servers are often slow; ask them all and take the first.
    const ctrl = new AbortController();
    const data = await Promise.any(OVERPASS.map((endpoint) =>
      getJSON(endpoint, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrl.signal }, 65000)));
    ctrl.abort();
    return data.elements.map(toPlace).filter(Boolean);
  });
  return places.filter((p) => !chain(p.name));
}

let coverageIndex;
export async function coverage() {
  coverageIndex ??= getJSON('data/cities.json').catch(() => []);
  return coverageIndex;
}

// The collected word of mouth for whichever city covers this point, if any.
export async function wordOfMouth(origin) {
  const cities = await coverage();
  const city = cities.find((c) => milesBetween(origin, { lat: c.center[0], lon: c.center[1] }) <= c.radius_km / 1.609 + 5);
  if (!city) return null;
  const data = await getJSON(`data/cities/${city.slug}.json`);
  return data;
}
