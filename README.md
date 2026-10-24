# Hearsay

**Where to eat, by word of mouth.** Type what you're craving ("spicy noodles", "a really good burger", "date night") and Hearsay ranks nearby independent spots by what people actually say about them: local Reddit threads, food blogs and newspaper coverage. No ads, no paid placement, no chains.

## How it works

```
pipeline/collect.py  ──(weekly, GitHub Actions)──▶  data/cities/<city>.json  ──▶  static site (GitHub Pages)
```

1. **Places** come from [OpenStreetMap](https://www.openstreetmap.org). Anything tagged with a brand (chains) is dropped.
2. **Word of mouth** is gathered by `pipeline/collect.py` for each city in `pipeline/cities.json`:
   - **Locals:** Reddit search results for a city's food subreddit, plus the comments under the top threads (that's where recommendations live).
   - **Press and blogs:** Google News headlines for "best ___ in <city>" queries. Yelp, Tripadvisor and delivery apps are skipped on purpose.
   - **Local food sections:** full articles from RSS feeds like Eater, read for the restaurant names inside them.

   Restaurant names are matched inside that text and the surrounding sentence is kept as a quote, with a link back to the source.
3. **The site** (`index.html` plus `assets/`) is plain HTML, CSS and JavaScript with no build step. It reads your craving, expands it ("comfort" → ramen, pho, BBQ, pizza…) and ranks each spot on:
   - **fit:** cuisine, name, and what people said;
   - **word of mouth:** independent voices count more than one outlet repeating itself, and recent talk counts more than old;
   - **distance:** a light nudge toward closer spots.

Outside covered cities the site still works: it asks OpenStreetMap live for nearby spots and ranks them on fit and distance.

## Run it locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Add a city

Add an entry to `pipeline/cities.json`:

```json
{
  "slug": "chicago",
  "name": "Chicago, IL",
  "center": [41.8781, -87.6298],
  "radius_km": 20,
  "news_terms": "Chicago",
  "subreddits": ["chicagofood"],
  "feeds": ["https://chicago.eater.com/rss/index.xml"]
}
```

Then collect it (takes a few minutes, since it's polite to every source):

```bash
python3 pipeline/collect.py --city chicago
```

Commit the new `data/` files. After that, the weekly GitHub Action keeps every city fresh, and you can trigger it by hand from the **Actions** tab.

Changed the matching rules? Re-match the text from the last crawl in seconds, with no new requests:

```bash
python3 pipeline/collect.py --city chicago --rematch
```

National chains live in `data/chains.json`, as normalized names: lowercase, no apostrophes. Local mini-chains (Tacodeli, P. Terry's) are left in on purpose.

## Known limits (v0.1)

- **Reddit may block GitHub's servers.** If the Action's log shows `403` for reddit.com, run the collector from your own machine and commit the data. The proper fix is a free Reddit API app whose keys live in repository secrets.
- **Name matching is heuristic.** One-word names have to be capitalized and not a common word; generic names like "Thai Kitchen" are skipped rather than guessed.
- **Google News links go through Google redirects**, and only headlines are read, not full articles.

## Where this goes next

- A small backend (for example a Cloudflare Worker with a database) so any city can be collected on demand.
- More sources: TikTok and Instagram food creators, local newsletters, Michelin and James Beard lists.
- An LLM pass that reads each quote, judging sentiment ("overrated" isn't praise) and picking out the dishes people rave about.
- Photos of the food, from sources that allow it.
