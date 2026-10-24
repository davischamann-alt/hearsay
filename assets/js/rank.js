// Scoring. Nothing here can be bought: a spot rises only by fitting what you
// want and by independent people talking about it.

import { normalize } from './mood.js';
import { milesBetween } from './places.js';

const KIND_WEIGHT = { press: 1, blog: 0.8, local: 0.75 };
const HALF_LIFE_DAYS = 540;
const termRe = new Map();

function has(haystack, term) {
  if (!termRe.has(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ _-]?');
    termRe.set(term, new RegExp(`(^|[^a-z])${esc}(s|es)?($|[^a-z])`));
  }
  return termRe.get(term).test(haystack);
}

function recency(date, now) {
  if (!date) return 0.5;
  const days = (now - Date.parse(date)) / 86400000;
  return Math.max(0.25, 0.5 ** (Math.max(0, days) / HALF_LIFE_DAYS));
}

// How strongly people vouch for a place. Repeat mentions from one outlet
// count for less than the same number of different voices.
function chatter(place, now) {
  const perOutlet = new Map();
  for (const m of place.mentions) {
    const w = (KIND_WEIGHT[m.kind] ?? 0.6) * recency(m.date, now);
    const list = perOutlet.get(m.outlet) || [];
    list.push(w);
    perOutlet.set(m.outlet, list);
  }
  let total = 0;
  for (const weights of perOutlet.values()) {
    weights.sort((a, b) => b - a);
    weights.forEach((w, i) => { total += i === 0 ? w : w * 0.3; });
  }
  const kinds = new Set(place.mentions.map((m) => m.kind)).size;
  return Math.log1p(total) * (1 + 0.15 * (kinds - 1));
}

function haystacks(place) {
  return {
    tags: normalize(`${place.cuisine.replace(/[;_]/g, ' ')} ${place.kind || ''}`),
    name: normalize(place.name),
    // What was actually said; the search that surfaced a thread doesn't count.
    talk: place.mentions.map((m) => normalize(`${m.quote} ${m.title}`)),
  };
}

// 0..1: how well a place fits every idea in the craving. Also reports
// whether it missed one entirely ("spicy noodles" at a taco shop).
function fit(place, groups, hay) {
  if (!groups.length) return { fit: 1, missed: false };
  let sum = 0;
  let missed = false;
  for (const g of groups) {
    let best = 0;
    let talkBest = 0;
    for (const [term, weight] of g.terms) {
      if (has(hay.tags, term)) best = Math.max(best, weight);
      else if (has(hay.name, term)) best = Math.max(best, 0.9 * weight);
      else {
        const said = hay.talk.filter((t) => has(t, term)).length;
        if (said) talkBest = Math.max(talkBest, Math.min(0.85, 0.15 + 0.15 * said) * weight);
      }
      if (best >= 1) break;
    }
    // Talk alone is weaker evidence when the map already says the place
    // serves something else (a taco shop named in a list next to a BBQ joint).
    if (!best && place.cuisine) talkBest *= 0.25;
    const score = Math.max(best, talkBest);
    if (score < 0.2) missed = true;
    sum += score;
  }
  return { fit: sum / groups.length, missed };
}

// Which quotes to show first: ones about what you asked for, then a mix of
// voices, then the newest.
function pickQuotes(place, groups) {
  const terms = groups.flatMap((g) => [...g.terms.keys()]);
  const nameLength = normalize(place.name).length;
  const scored = place.mentions.map((m) => {
    const text = normalize(`${m.topics.join(' ')} ${m.quote}`);
    const relevant = terms.some((t) => has(text, t)) ? 1 : 0;
    const substance = normalize(m.quote).length - nameLength > 30 ? 1 : 0;
    return { m, relevant, substance };
  });
  scored.sort((a, b) => b.substance - a.substance || b.relevant - a.relevant
    || (b.m.date || '').localeCompare(a.m.date || ''));
  const ordered = [];
  const seenOutlets = new Set();
  for (const { m } of scored) if (!seenOutlets.has(m.outlet)) { ordered.push(m); seenOutlets.add(m.outlet); }
  for (const { m } of scored) if (!ordered.includes(m)) ordered.push(m);
  return ordered;
}

export function rank(places, groups, origin) {
  const now = Date.now();
  const scored = [];
  for (const place of places) {
    const hay = haystacks(place);
    const { fit: f, missed } = fit(place, groups, hay);
    if (groups.length && f < 0.3) continue;
    scored.push({
      ...place,
      miles: milesBetween(origin, place),
      fit: missed ? f * 0.4 : f,
      missed,
      buzz: chatter(place, now),
    });
  }
  const maxBuzz = Math.max(0.01, ...scored.map((p) => p.buzz));
  for (const p of scored) {
    const buzz = p.buzz / maxBuzz;
    const near = 1 / (1 + p.miles / 2);
    // Fit multiplies everything else: a famous spot can't outrank one that
    // actually serves what you asked for.
    p.score = groups.length ? p.fit * (0.55 + 0.45 * buzz) * (0.85 + 0.15 * near) : 0.8 * buzz + 0.2 * near;
    p.quotes = pickQuotes(p, groups);
  }
  let talked = oneEach(scored.filter((p) => p.mentions.length).sort((a, b) => b.score - a.score));
  // Half-matches ("spicy" but no noodles) only fill in when full matches are scarce.
  const full = talked.filter((p) => !p.missed).length;
  if (full >= 5) talked = talked.filter((p) => !p.missed);
  const quiet = oneEach(scored.filter((p) => !p.mentions.length).sort((a, b) => b.fit - a.fit || a.miles - b.miles));
  return { talked, quiet, fewFullMatches: groups.length > 1 && full < 5 };
}

// A local mini-chain shows once, at its best-ranked location.
function oneEach(list) {
  const seen = new Map();
  const out = [];
  for (const p of list) {
    const key = normalize(p.name);
    if (seen.has(key)) seen.get(key).otherLocations += 1;
    else {
      p.otherLocations = 0;
      seen.set(key, p);
      out.push(p);
    }
  }
  return out;
}
