# newspulse — world news ranked by virality (backend)

A small always-on service. It polls news RSS feeds, GDELT, Reddit and Wikipedia, merges articles about the same event into one **story**, scores each story for virality, and serves it all as JSON (+ a live stream). **There is no front end here** — build one against the API below.

```
RSS feeds ─┐
GDELT ─────┤→ collector → engine (cluster + score) → /api/*  (JSON)  and  /api/stream (SSE)
Reddit ────┤                                                 ↘ /api/match  (coin name → trending story)
Wikipedia ─┘
```

## Run
```
node src/index.js            # Node >= 20, zero dependencies. PORT (default 8790), DATA_DIR (default ./data)
node --test                  # 14 tests, no network needed
```
Needs a process that stays up (Render/Fly/VPS). A static host (GitHub Pages) cannot run it, but a static front end can call it (CORS is open).

## API (all GET, JSON, CORS `*`)
| endpoint | returns |
|---|---|
| `/api/top?hours=24&limit=50&topic=&region=&q=` | stories ranked by `score` (overall virality, decays with a 12 h half-life) |
| `/api/breaking?limit=30&topic=&region=` | stories ranked by `breakingScore` (how fast new outlets/communities are joining right now) |
| `/api/daily?date=YYYY-MM-DD&limit=10` | **Top stories of the day** — best score each story reached that UTC date (default today) |
| `/api/story/:id` | one story with every article link |
| `/api/stream` | Server-Sent Events. Event `breaking`, data `{ts, stories[15]}`, sent on connect and every 15 s. Use `new EventSource(url)` |
| `/api/posts?window=day\|week\|month\|all&platform=&category=&community=&q=&limit=50` | **viral posts** across platforms, ranked by `viral` (0-100). `day`/`week`/`month` = posts *created* in that window, `all` = everything stored (30 days + Reddit's all-time top) |
| `/api/posts/meta` | `{platforms:{reddit:{posts,categories}}, categories:[{name,count}], windows}` — use it to build the filter UI |
| `/api/trends` | `{trends:{google:[{term,traffic,headline,url}], x:[…]}}` — what people are searching / what is trending (Google Trends RSS; X only if you add a token) |
| `/api/keywords?limit=40` | trending names/terms `[{term, score, stories}]` |
| `/api/match?name=Tschuna the Tiger&symbol=Tschuna` | stories matching a coin's name: `[{confidence, matchedWords, story}]` |
| `/api/sources` | per-source health: `{ok, items, added, err, httpStatus, ms, ts}` — show this in an admin view |
| `/api/health` | `{ok, uptimeSec, stories, items, sourcesOk, sourcesTotal}` |

`topic` ∈ conflict politics business tech crypto sports entertainment science disaster crime health animals.
`region` ∈ world us uk europe mideast asia oceania business entertainment viral.

### Story object
```json
{ "id":"a1b2c3d4e5", "headline":"Tiger escapes Texas zoo…", "url":"https://…(best link)",
  "score":48.7, "breakingScore":50, "parts":{"reach":0.63,"velocity":0.8,"social":0,"wiki":0},
  "nSources":4, "newSources":3, "redditPoints":0, "ageMin":25, "firstSeen":1791…, "lastSeen":1791…,
  "firstSource":"BBC", "topics":["animals"], "regions":["world"], "entities":["Texas"],
  "sources":[{"name":"BBC","kind":"rss|gdelt|reddit","url":"…","title":"…","ts":1791…,"points":4000}] }
```
Times are epoch milliseconds. `parts` are 0–1 and explain the score — a good UI shows them (e.g. a "why is this hot" bar).

## Virality score (see `src/score.js`)
`score = 100 × (0.40·reach + 0.30·velocity + 0.22·social + 0.08·wiki) × 0.5^(hours since last update / 12)`
* **reach** – distinct outlets/communities carrying it (log scale, saturates at 12)
* **velocity** – how many of them joined in the last 30 min (saturates at 5)
* **social** – hottest Reddit post's (points + 2·comments) per minute (log scale)
* **wiki** – a named entity is in Wikipedia's daily most-viewed list (weak; that list is daily, not live)

`breakingScore = 100 × (0.55·velocity + 0.25·social + 0.20·reach) × 0.5^(minutes since last update / 45)`

## Config (env; all optional)
`FEEDS` (JSON array of `{name,url,region}` — replaces the default feed list), `FEED_POLL_SEC` 60, `GDELT=0` / `REDDIT=0` / `WIKI=0` to disable a source, `REDDIT_SUBS`, `USER_AGENT` (set a real contact!), `SIM_JACCARD`/`SIM_OVERLAP`/`SIM_MIN_SHARED` (how aggressively articles merge), `KEEP_HOURS` 72, `TOP_HALF_LIFE_H` 12.

## Hooking it to the trading bot (optional, not wired)
Poll `/api/match?name=<coin name>&symbol=<ticker>` for each new coin the bot sees. A match with `confidence` ≥ ~0.3 means "this coin's name is in a story that is trending right now". Treat it as one more input, never as a buy signal on its own — copycat coins launched off a trending story are mostly rigged; run them through the normal gates.

## What is NOT verified (read before trusting it)
* **No feed URL was tested against the live internet** (outbound web was blocked while building). Open `/api/sources` after the first minute: any source with `ok:false` shows why (`http 403/404`, `parsed 0 items`, …). Fix by editing `FEEDS`.
* **Reddit often returns 403/429 to cloud IPs.** If so, set `REDDIT=0`, or route the Reddit calls through a proxy.
* **GDELT** is rate limited (~1 request / 5 s) and sometimes slow; its articles add outlet diversity but not social signal.
* **Speed**: RSS/GDELT lag real events by minutes. Memes usually start on X/TikTok first, and neither is included (X's API is paid, TikTok has none). Reddit is the fastest free social signal here. A Bluesky live feed would be a good next addition.
* Clustering is word-overlap based (no AI embeddings): it can occasionally merge two different stories or split one. Tune the `SIM_*` values with real data.
* Everything is in memory with a JSON snapshot every minute; a restart keeps the last 72 h.


## Viral posts (v1.1)
Sources and what each one really gives you:

| platform | how | key needed | status |
|---|---|---|---|
| **Reddit** | public `top.json?t=day/week/month/all` for 20 subreddits (`POST_SUBS`), NSFW skipped | none | works from many hosts, but Reddit often 403s cloud IPs — check `/api/sources` |
| **Mastodon** | `/api/v1/trends/statuses` on each instance in `MASTODON_INSTANCES` | none | public API |
| **Bluesky** | public "What's Hot" feed (`BSKY_FEEDS`, AT-URI of any feed generator) | none | public API; feed id not verified |
| **YouTube** | Data API `videos.list chart=mostPopular` | `YOUTUBE_API_KEY` (free) | off until you set the key |
| **X (Twitter)** | trending *topics* only (`/2/trends/by/woeid/1`), shown under `/api/trends` | `X_BEARER_TOKEN` (paid plan) | off until you set the token; endpoint/plan access not verified |
| **Google Trends** | public "trending now" RSS (`TRENDS_GEO`) | none | search interest, a good proxy for what is going viral everywhere |
| **Facebook** | **not available** | — | no public API: CrowdTangle was shut down (Aug 2024); Meta Content Library is limited to approved researchers; scraping is blocked and against their terms |
| **Instagram** | **not available** | — | same as Facebook |
| TikTok | not available | — | no public API |

**Scoring** (`src/posts.js`): `engagement` is platform-weighted interactions (Reddit: score + 2·comments; Mastodon/Bluesky: likes + 2·reposts + comments; YouTube: views/100 + likes + 3·comments). `velocity` is engagement gained per hour between our sightings (lifetime average if seen once). `viral = 100 × (0.6·engagement percentile + 0.4·velocity percentile)`, with percentiles **within each platform and window** (300 likes on Mastodon vs 30,000 Reddit points are not comparable). Percentiles divide by `max(n, 20)` so a platform with two posts cannot take #1 by default.

**Categories**: from the subreddit (`r/aww` → animals, `r/memes` → meme, …) plus keyword topics on the text: conflict politics business tech crypto sports entertainment science disaster crime health animals gaming meme, plus `video` and `news`/`viral`/`lifestyle`/`general`.

Config: `POSTS=0` disables all of it, `POST_SUBS`, `POST_POLL_SEC` (600), `MASTODON_INSTANCES`, `BSKY_FEEDS`, `POST_KEEP_DAYS` (30), `POST_MAX` (6000).
Unverified (same as the rest): none of these endpoints were reached from the build sandbox. Open `/api/sources`; rows named `posts …` show per-source health.
