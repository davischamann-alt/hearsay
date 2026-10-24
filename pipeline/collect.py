#!/usr/bin/env python3
"""Hearsay collector: gathers word of mouth about local restaurants.

For each city in pipeline/cities.json it:
  1. pulls every named, non-chain food spot from OpenStreetMap,
  2. reads what people say: Reddit threads and comments, newspaper and blog
     headlines (via Google News), and full articles from local food feeds,
  3. matches restaurant names inside that text and keeps the quotes,
  4. writes data/cities/<slug>.json (every spot, with quotes where people
     talked about it) plus the data/cities.json index.

Standard library only, so it runs anywhere (including GitHub Actions).

    python3 pipeline/collect.py                 # every city
    python3 pipeline/collect.py --city austin   # one city
    python3 pipeline/collect.py --quick         # fewer queries, for testing
    python3 pipeline/collect.py --rematch       # re-match last crawl's text, no crawling
"""

import argparse
import html
import json
import re
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "pipeline" / "cities.json"
DATA = ROOT / "data"

USER_AGENT = "Mozilla/5.0 (compatible; Hearsay/0.1; +https://github.com/)"
# Overpass rejects browser-looking agents from scripts; it wants a plain name.
# Reddit allows roughly ten anonymous requests a minute.
REDDIT_DELAY = 7
OVERPASS_AGENT = "Hearsay/0.1 (restaurant word-of-mouth collector)"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

CRAVINGS = [
    "pizza", "tacos", "ramen", "sushi", "bbq", "burgers", "pho", "thai",
    "indian", "korean", "chinese", "dumplings", "italian", "mexican",
    "seafood", "fried chicken", "sandwiches", "brunch", "bakery", "coffee",
    "dessert", "vegan", "mediterranean", "steak", "cocktails", "date night",
    "cheap eats", "hidden gem", "late night",
]
QUICK_CRAVINGS = ["tacos", "ramen", "bbq", "pizza", "brunch", "hidden gem"]

# Words that make a one-word (or all-generic) restaurant name too ambiguous to
# match in free text. "Salt" or "Thai Kitchen" would match half of Reddit.
GENERIC = set("""
a an and the of at on in by to for with &
bar bistro brasserie cafe café cantina canteen counter deli diner eatery grill
grille house kitchen lounge market pub restaurant room shop spot stand table
tavern truck trailer joint place club co company corner garden hall station
food foods coffee tea taco tacos pizza pizzeria burger burgers bbq barbecue
ramen sushi pho thai chinese indian korean mexican italian french greek
japanese vietnamese seafood fish chicken wings bakery bread donut donuts
dessert ice cream sweet sweets juice smoothie wine beer brewery cocktail
cocktails sandwich sandwiches salad noodle noodles dumpling dumplings steak
steakhouse breakfast brunch lunch dinner express original famous best good
great little big old new golden royal happy lucky star sun moon home hot
spicy fresh local central city town street avenue east west north south
austin texas mama papa abuela casa la el los las de del y
olive salt pepper honey sugar butter lemon lime oak elm pearl
asian chinatown pad speakeasy back champion champions cuisine
""".split())

# Ordinary lowercase English words (the system dictionary, when present).
# Names built only from these need stronger evidence before we match them.
_DICT = Path("/usr/share/dict/words")
ENGLISH = {w for w in _DICT.read_text().split() if w.islower()} if _DICT.exists() else set()

# Lowercase words that glue a longer name together: "Pizza di Roma".
CONNECTORS = {"di", "de", "del", "da", "du", "la", "le", "el", "los", "las", "of", "the", "y", "and"}

# National chains that OpenStreetMap doesn't always tag with a brand.
CHAINS = [k.split() for k in json.loads((DATA / "chains.json").read_text())] if (DATA / "chains.json").exists() else []


def is_chain(name):
    words = norm(name).split()
    return any(words[:len(c)] == c for c in CHAINS)


def is_common(word):
    """An everyday word (or number) rather than something only a name would be."""
    return (word in ENGLISH or word in GENERIC or word.isdigit()
            or (word.endswith("s") and word[:-1] in ENGLISH))

# Aggregators and delivery apps: the ad-driven stuff we're avoiding.
SKIP_OUTLETS = ("yelp", "tripadvisor", "opentable", "doordash", "ubereats",
                "grubhub", "restaurantji", "wanderlog", "restaurantguru",
                "postmates", "seamless", "groupon")

PRESS_HINTS = ("eater", "infatuation", "nytimes", "new york times", "timeout",
               "time out", "bon app", "food & wine", "food and wine",
               "michelin", "monthly", "magazine", "chronicle", "statesman",
               "tribune", "post", "times", "herald", "journal", "gazette",
               "observer", "reader", "weekly", "news", "culturemap", "axios",
               "npr", "kxan", "kvue", "abc", "nbc", "cbs", "fox", "thrillist",
               "sfgate", "nymag", "grub street", "washingtonian",
               "the takeout", "serious eats", "conde", "esquire", "usa today")


# ---------------------------------------------------------------- utilities

# python.org installs on macOS ship without CA certificates; borrow the system's.
SSL_CONTEXT = ssl.create_default_context()
if not SSL_CONTEXT.cert_store_stats()["x509_ca"] and Path("/etc/ssl/cert.pem").exists():
    SSL_CONTEXT.load_verify_locations("/etc/ssl/cert.pem")

def log(*args):
    print(*args, file=sys.stderr, flush=True)


def fetch(url, data=None, delay=1.0, tries=3, agent=USER_AGENT):
    """GET (or POST form data) with polite retries. Returns text or None."""
    body = urllib.parse.urlencode(data).encode() if data else None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=body, headers={"User-Agent": agent})
        try:
            with urllib.request.urlopen(req, timeout=60, context=SSL_CONTEXT) as resp:
                text = resp.read().decode("utf-8", "replace")
                remaining = resp.headers.get("x-ratelimit-remaining")
                reset = resp.headers.get("x-ratelimit-reset")
            if remaining is not None and reset and float(remaining) < 2:
                time.sleep(min(120, float(reset) + 1))  # out of quota: wait for the window
            time.sleep(delay)
            return text
        except urllib.error.HTTPError as err:
            wait = 10 * (attempt + 1) if err.code in (502, 503, 504) else 0
            if err.code == 429:  # rate limited: wait as long as the server asks
                hint = err.headers.get("x-ratelimit-reset") or err.headers.get("Retry-After") or 30
                wait = min(120, int(float(hint)) + 2)
            log(f"  ! {err.code} {url[:90]}" + (f" (waiting {wait}s)" if wait else ""))
            if not wait:
                return None
            time.sleep(wait)
        except Exception as err:  # network hiccups, timeouts
            log(f"  ! {type(err).__name__} {url[:90]}")
            time.sleep(3)
    return None


def norm(text):
    """Lowercase, strip accents and punctuation: 'Tatsu-Ya’s' -> 'tatsu ya s'."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("&", " and ").replace("’", "").replace("'", "")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def strip_html(fragment):
    fragment = re.sub(r"(?is)<(script|style|noscript|svg|nav|footer|header)\b.*?</\1>", " ", fragment)
    fragment = re.sub(r"(?s)<!--.*?-->", " ", fragment)
    fragment = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>|</div>", ". ", fragment)
    text = html.unescape(re.sub(r"<[^>]+>", " ", fragment))
    return " ".join(text.split())


def iso_date(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            dt = parsedate_to_datetime(value)
        except Exception:
            return None
    return dt.astimezone(timezone.utc).date().isoformat()


def parse_feed(xml_text):
    """Yield dicts (title, link, date, html, source) from RSS or Atom."""
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text.encode("utf-8"))
    except ET.ParseError:
        return []
    atom = "{http://www.w3.org/2005/Atom}"
    items = []
    for item in root.iter("item"):
        source = item.find("source")
        items.append({
            "title": (item.findtext("title") or "").strip(),
            "link": (item.findtext("link") or "").strip(),
            "date": iso_date(item.findtext("pubDate")),
            "html": item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded")
                    or item.findtext("description") or "",
            "source": source.text.strip() if source is not None and source.text else None,
            "source_url": source.get("url") if source is not None else None,
        })
    for entry in root.iter(atom + "entry"):
        link = entry.find(atom + "link")
        author = entry.find(atom + "author")
        items.append({
            "title": html.unescape((entry.findtext(atom + "title") or "").strip()),
            "link": link.get("href") if link is not None else "",
            "date": iso_date(entry.findtext(atom + "published") or entry.findtext(atom + "updated")),
            "html": entry.findtext(atom + "content") or entry.findtext(atom + "summary") or "",
            "author": author.findtext(atom + "name") if author is not None else None,
            "source": None,
        })
    return items


# ------------------------------------------------------------ OpenStreetMap

def fetch_places(city):
    # Reuse today's map pull while iterating locally; Overpass is slow.
    cache = ROOT / "pipeline" / ".cache" / f"{city['slug']}-osm.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < 86400:
        places = json.loads(cache.read_text())
        log(f"  {len(places)} independent spots from OpenStreetMap (cached)")
        return places
    lat, lon = city["center"]
    radius = int(city.get("radius_km", 20) * 1000)
    query = f"""
    [out:json][timeout:120];
    (
      nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|biergarten)$"]["name"](around:{radius},{lat},{lon});
      nwr["shop"~"^(bakery|pastry|deli)$"]["name"](around:{radius},{lat},{lon});
    );
    out center tags;
    """
    for endpoint in OVERPASS:
        text = fetch(endpoint, data={"data": query}, delay=2, tries=2, agent=OVERPASS_AGENT)
        if text:
            try:
                elements = json.loads(text)["elements"]
                break
            except (ValueError, KeyError):
                continue
    else:
        raise SystemExit("Overpass unavailable; try again later.")

    places = []
    for el in elements:
        tags = el.get("tags", {})
        if tags.get("brand") or tags.get("brand:wikidata"):
            continue  # chains: not what we're here for
        lat_ = el.get("lat") or el.get("center", {}).get("lat")
        lon_ = el.get("lon") or el.get("center", {}).get("lon")
        if lat_ is None:
            continue
        places.append({
            "id": f"{el['type']}/{el['id']}",
            "name": tags["name"],
            "lat": round(lat_, 6),
            "lon": round(lon_, 6),
            "kind": tags.get("amenity") or tags.get("shop"),
            "cuisine": tags.get("cuisine", ""),
            "street": " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")])),
            "website": tags.get("website") or tags.get("contact:website") or "",
        })
    log(f"  {len(places)} independent spots from OpenStreetMap")
    cache.parent.mkdir(exist_ok=True)
    cache.write_text(json.dumps(places))
    return places


class NameIndex:
    """Finds restaurant names inside arbitrary text via n-gram lookup."""

    def __init__(self, places, city_words):
        self.by_name = {}
        generic = GENERIC | city_words
        for place in places:
            for key in self._keys(place["name"]):
                words = key.split()
                if all(w in generic for w in words):
                    continue
                if len(words) == 1 and len(key) < 4:
                    continue
                self.by_name.setdefault(key, []).append(place)
        self.max_n = max((len(k.split()) for k in self.by_name), default=1)

    @staticmethod
    def _keys(name):
        key = norm(name)
        keys = {key}
        if key.startswith("the ") and len(key.split()) > 2:
            keys.add(key[4:])
        # "Ramen Tatsu-Ya - South Lamar" -> also "ramen tatsu ya"
        base = re.split(r"\s[-–|(@]\s?|\s+at\s+", name)[0]
        if base != name:
            keys.add(norm(base))
        return {k for k in keys if k}

    def find(self, text):
        """Return {name_key: [places]} for names mentioned in text."""
        words = norm(text).split()
        hits = {}
        folded = None
        for n in range(self.max_n, 0, -1):
            for i in range(len(words) - n + 1):
                key = " ".join(words[i:i + n])
                if key in self.by_name and not any(f" {key} " in f" {h} " for h in hits):
                    ambiguous = all(is_common(w) for w in key.split())
                    if n == 1 or ambiguous:
                        if folded is None:
                            folded = "".join(c for c in unicodedata.normalize("NFKD", text)
                                             if not unicodedata.combining(c)).replace("’", "").replace("'", "")
                        if not self._proper_noun(key, folded, ambiguous):
                            continue
                    hits[key] = self.by_name[key]
        return hits

    @staticmethod
    def _proper_noun(key, folded, ambiguous):
        """Does key appear in the text the way a restaurant name would?

        "Paperboy" or "Hole in the Wall" are also ordinary words, so they
        must be capitalized mid-sentence ("we loved Paperboy"), which rules
        out headlines in Title Case. Any one-word name must not be the tail
        of a longer capitalized name ("Pizza Di Roma" is not "Roma").
        """
        parts = [r"(?:and|&)" if w == "and" else re.escape(w) for w in key.split()]
        pattern = r"\b" + r"[^A-Za-z0-9&]*".join(parts) + r"\b"
        for m in re.finditer(pattern, folded, re.I):
            found = m.group(0)
            before = folded[:m.start()].rstrip()
            sentence_start = not before or before[-1] in ".!?:;\"“”()[]\n-–—|*#>"
            prev = re.search(r"([A-Za-z0-9]+)\W*$", before)
            prev_lower = bool(prev) and not prev.group(1)[0].isupper()
            glued = re.search(r"([A-Za-z0-9]+)[ \t]+([A-Za-z]+)[ \t]*$", before)
            if glued and glued.group(2).lower() in CONNECTORS and glued.group(1)[0].isupper() \
                    and glued.group(2) != "and":
                continue  # tail of a longer name: "Pizza di Roma"
            if ambiguous:
                letter = next((ch for ch in found if ch.isalpha()), "")
                if not letter.isupper() or (found.isupper() and len(found) > 3):
                    continue  # lowercase phrase, or SHOUTING
                after = folded[m.end():]
                if re.match(r"[ \t]+[A-Z][a-z]", after):
                    continue  # head of a longer name: "Champions League"
                if not sentence_start and prev_lower:
                    return True
                # Multi-word names written fully in Title Case ("Clark's Oyster
                # Bar", "Joe's Bakery & Coffee Shop") are names wherever they
                # sit, as long as they aren't the start of something longer.
                words = found.split()
                if len(words) > 1 and all(w[0].isupper() or w[0].isdigit() or w.lower() in CONNECTORS
                                          or w in ("&", "+") for w in words) \
                        and (sentence_start or prev_lower or before.endswith(",")):
                    return True  # ...nor the end of one: "Madam Mam's Thai Cuisine"
            elif sentence_start or prev_lower or before.endswith(",") or not found[0].isupper():
                return True
        return False


def quote_for(key, text, limit=240):
    """The sentence in text that mentions key, trimmed for display.

    A sentence that is little more than the name ("Franklin Barbecue?") says
    nothing, so it borrows the sentences around it.
    """
    sentences = [x.strip(" -–") for x in re.split(r"(?<=[.!?])\s+|\n+", text) if x.strip(" .-–")]
    for i, sentence in enumerate(sentences):
        if key in norm(sentence):
            lo, hi = i, i
            s = sentence
            while len(norm(s)) - len(key) < 40 and (lo > 0 or hi < len(sentences) - 1):
                if hi < len(sentences) - 1:
                    hi += 1
                else:
                    lo -= 1
                s = " ".join(sentences[lo:hi + 1])
            if len(s) > limit:
                cut = norm(s).find(key.split()[0])
                start = max(0, min(len(s) - limit, cut - limit // 3))
                s = ("…" if start else "") + s[start:start + limit].rsplit(" ", 1)[0] + "…"
            return s.rstrip(".")
    return text[:limit]


# ----------------------------------------------------------------- sources

def outlet_kind(name):
    low = (name or "").lower()
    if any(s in low for s in SKIP_OUTLETS):
        return None
    return "press" if any(h in low for h in PRESS_HINTS) else "blog"


def from_google_news(city, cravings):
    """Headlines from newspapers, magazines and blogs."""
    term = city.get("news_terms") or city["name"]
    queries = [f'"{term}" best {c}' for c in cravings] + [
        f'"{term}" restaurant review', f'"{term}" new restaurants',
        f'"{term}" food truck', f'"{term}" where to eat',
    ]
    for q in queries:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": q, "hl": "en-US", "gl": "US", "ceid": "US:en"})
        for item in parse_feed(fetch(url, delay=1.2)):
            kind = outlet_kind(item["source"])
            if not kind:
                continue
            title = re.sub(r"\s+-\s+[^-]+$", "", item["title"])  # drop " - Outlet"
            yield {
                "kind": kind, "outlet": item["source"] or "News",
                "title": title, "url": item["link"], "date": item["date"],
                "text": title, "topic": q.split(" best ")[-1] if " best " in q else None,
            }


def from_reddit(city, cravings, comment_threads=3):
    """Posts and the comments under them: where locals actually answer."""
    for sub in city.get("subreddits", []):
        for craving in cravings:
            url = f"https://www.reddit.com/r/{sub}/search.rss?" + urllib.parse.urlencode(
                {"q": craving, "restrict_sr": 1, "sort": "relevance", "t": "all", "limit": 25})
            posts = parse_feed(fetch(url, delay=REDDIT_DELAY))
            for post in posts:
                yield {
                    "kind": "local", "outlet": f"r/{sub}", "title": post["title"],
                    "url": post["link"], "date": post["date"],
                    "text": post["title"] + ". " + strip_html(post["html"]), "topic": craving,
                }
            for post in posts[:comment_threads]:
                if not post["link"]:
                    continue
                thread = parse_feed(fetch(post["link"].rstrip("/") + "/.rss", delay=REDDIT_DELAY))
                for comment in thread[1:]:  # first entry is the post itself
                    yield {
                        "kind": "local", "outlet": f"r/{sub}", "title": post["title"],
                        "url": comment["link"] or post["link"], "date": comment["date"],
                        "text": strip_html(comment["html"]), "topic": craving,
                    }


def from_feeds(city, max_articles=25):
    """Local food sections and blogs: read the full article, not just the blurb."""
    for feed_url in city.get("feeds", []):
        items = parse_feed(fetch(feed_url))
        outlet = urllib.parse.urlparse(feed_url).netloc.replace("www.", "")
        outlet = {"austin.eater.com": "Eater Austin"}.get(outlet, outlet)
        for item in items[:max_articles]:
            page = fetch(item["link"], delay=1.5) if item["link"] else None
            body = strip_html(page) if page else strip_html(item["html"])
            yield {
                "kind": "press" if outlet_kind(outlet) == "press" else "blog",
                "outlet": outlet, "title": item["title"], "url": item["link"],
                "date": item["date"], "text": item["title"] + ". " + body, "topic": None,
            }


# ------------------------------------------------------------------- build

def match(places, docs, city):
    """Find who each document talks about. Returns (mentions by place id, scanned counts)."""
    city_words = set(norm(city["name"] + " " + city.get("news_terms", "")).split())
    index = NameIndex(places, city_words)
    mentions = {}  # place id -> {url: mention}
    scanned = {"press": 0, "blog": 0, "local": 0}
    for doc in docs:
        scanned[doc["kind"]] += 1
        for key, matched in index.find(doc["text"]).items():
            quote = re.sub(r"https?://\S+", "", quote_for(key, doc["text"])).strip(" .-–")
            if len(quote) - len(key) < 15:
                quote = doc["title"]  # a bare link or a lone name says nothing
            topics = {c for c in CRAVINGS if f" {norm(c)} " in f" {norm(quote)} "}
            if doc["topic"]:
                topics.add(doc["topic"])
            topics.update(doc.get("topics", []))
            for place in matched:
                bucket = mentions.setdefault(place["id"], {})
                if doc["url"] in bucket:
                    bucket[doc["url"]]["topics"] = sorted(set(bucket[doc["url"]]["topics"]) | topics)
                    continue
                bucket[doc["url"]] = {
                    "kind": doc["kind"], "outlet": doc["outlet"], "title": doc["title"][:160],
                    "url": doc["url"], "date": doc["date"], "quote": quote,
                    "topics": sorted(topics),
                }
    return mentions, scanned


def docs_cache(city):
    return ROOT / "pipeline" / ".cache" / f"{city['slug']}-docs.json"


def collect(city, quick=False, rematch=False):
    log(f"\n== {city['name']}")
    places = [p for p in fetch_places(city) if not is_chain(p["name"])]

    if rematch:
        # Re-run matching on the text read last time: no crawling.
        if docs_cache(city).exists():
            docs = json.loads(docs_cache(city).read_text())
        else:  # older crawls only kept the quotes; those still contain the names
            old = json.loads((DATA / "cities" / f"{city['slug']}.json").read_text())
            docs = list({(m["url"], m["quote"]): {**m, "text": m["quote"], "topic": None}
                         for p in old["places"] for m in p["mentions"]}.values())
        log(f"  re-matching {len(docs)} cached documents")
    else:
        cravings = QUICK_CRAVINGS if quick else CRAVINGS
        docs = []
        for label, source in [
            ("news", from_google_news(city, cravings)),
            ("reddit", from_reddit(city, cravings, 2 if quick else 3)),
            ("feeds", from_feeds(city, 8 if quick else 25)),
        ]:
            log(f"  reading {label}…")
            docs.extend(source)
        docs_cache(city).parent.mkdir(exist_ok=True)
        docs_cache(city).write_text(json.dumps(docs, ensure_ascii=False))

    mentions, scanned = match(places, docs, city)
    by_id = {p["id"]: p for p in places}
    out_places = []
    for pid, bucket in mentions.items():
        ms = sorted(bucket.values(), key=lambda m: m["date"] or "", reverse=True)[:25]
        out_places.append({**by_id[pid], "mentions": ms})
    out_places.sort(key=lambda p: -len(p["mentions"]))
    # Everything else too, trimmed, so covered cities never wait on Overpass.
    quiet = [{k: v for k, v in p.items() if v} for p in places if p["id"] not in mentions]

    log(f"  {len(out_places)} spots with word of mouth "
        f"(scanned {scanned['press']} press, {scanned['blog']} blog, {scanned['local']} local)")
    return {
        "slug": city["slug"], "name": city["name"], "center": city["center"],
        "radius_km": city.get("radius_km", 20),
        "updated": datetime.now(timezone.utc).date().isoformat(),
        "scanned": scanned, "places": out_places, "quiet": quiet,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--city", help="slug of one city to refresh")
    parser.add_argument("--quick", action="store_true", help="fewer queries (for testing)")
    parser.add_argument("--rematch", action="store_true",
                        help="re-run name matching on the last crawl's cached text (no crawling)")
    args = parser.parse_args()

    cities = json.loads(CONFIG.read_text())
    targets = [c for c in cities if not args.city or c["slug"] == args.city]
    if not targets:
        raise SystemExit(f"No city with slug {args.city!r} in {CONFIG}")

    (DATA / "cities").mkdir(parents=True, exist_ok=True)
    for city in targets:
        result = collect(city, quick=args.quick, rematch=args.rematch)
        path = DATA / "cities" / f"{city['slug']}.json"
        path.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        log(f"  wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")

    index = []
    for city in cities:
        path = DATA / "cities" / f"{city['slug']}.json"
        if path.exists():
            d = json.loads(path.read_text())
            index.append({k: d[k] for k in ("slug", "name", "center", "radius_km", "updated", "scanned")}
                         | {"spots": len(d["places"])})
    (DATA / "cities.json").write_text(json.dumps(index, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
