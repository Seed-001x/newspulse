// collector.js — polls every source on its own timer, feeds the engine, tracks per-source health.
import { parseFeed, parseGdelt, parseReddit, parseWikiTop, parseRedditPosts, parseMastodon, parseBluesky, parseYouTube, parseGoogleTrends, parseXTrends } from './parse.js';

export class Collector {
  constructor(engine, cfg, { fetchImpl = fetch, posts = null } = {}) {
    this.engine = engine; this.cfg = cfg; this.f = fetchImpl; this.posts = posts; this.trends = {};   // platform -> [{term, traffic, ...}]
    this.status = {};   // name -> { ok, items, added, ts, ms, err, httpStatus }
    this.timers = [];
  }

  async #get(url, { json = false } = {}) {
    const r = await this.f(url, { headers: { 'user-agent': this.cfg.userAgent, accept: json ? 'application/json' : 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    return { r, body: r.ok ? (json ? await r.json() : await r.text()) : null };
  }

  async #run(name, fn) {
    const t0 = Date.now();
    const st = this.status[name] = { ...(this.status[name] || {}), ok: false, ts: t0, err: null };
    try {
      const { items, httpStatus, err, _noEngine } = await fn();
      st.httpStatus = httpStatus ?? 200; st.ms = Date.now() - t0;
      if (err) { st.err = err; return 0; }
      let added = 0; if (!_noEngine) for (const it of items) if (this.engine.addItem(it)) added++;
      st.ok = items.length > 0; st.items = items.length; st.added = added;
      if (!items.length) st.err = 'parsed 0 items (wrong URL or unexpected format?)';
      return added;
    } catch (e) { st.err = String(e && (e.cause && e.cause.code || e.message) || e); st.ms = Date.now() - t0; return 0; }
  }

  pollFeed(feed) {
    return this.#run(feed.name, async () => {
      const { r, body } = await this.#get(feed.url);
      if (!r.ok) return { items: [], httpStatus: r.status, err: `http ${r.status}` };
      return { items: parseFeed(body, feed) };
    });
  }
  pollGdelt() {
    return this.#run('GDELT', async () => {
      const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent('sourcelang:english') + '&mode=artlist&maxrecords=100&format=json&sort=datedesc&timespan=30min';
      const { r, body } = await this.#get(url, { json: true });
      if (!r.ok) return { items: [], httpStatus: r.status, err: r.status === 429 ? 'rate limited (GDELT allows ~1 request / 5 s)' : `http ${r.status}` };
      return { items: parseGdelt(body) };
    });
  }
  pollReddit(sub) {
    return this.#run('r/' + sub, async () => {
      const { r, body } = await this.#get(`https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=50&raw_json=1`, { json: true });
      if (!r.ok) return { items: [], httpStatus: r.status, err: r.status === 403 || r.status === 429 ? `reddit refused (${r.status}) — often blocks cloud IPs; set REDDIT=0 or use another host` : `http ${r.status}` };
      return { items: parseReddit(body, sub) };
    });
  }
  // ---------------- viral posts ----------------
  /** Generic: fetch JSON, run `parse`, push into the post store. */
  #postSource(name, url, parse, { headers = {}, hint } = {}) {
    return this.#run(name, async () => {
      const r = await this.f(url, { headers: { 'user-agent': this.cfg.userAgent, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
      if (!r.ok) return { items: [], httpStatus: r.status, err: r.status === 401 || r.status === 403 ? `refused (${r.status})${hint ? ' — ' + hint : ''}` : r.status === 429 ? 'rate limited' : `http ${r.status}` };
      const rows = parse(await r.json());
      let added = 0; for (const p of rows) if (this.posts && this.posts.add(p)) added++;
      return { items: rows.map(x => ({ title: x.text, url: x.url })).slice(0, rows.length), _noEngine: true };
    });
  }
  pollRedditTop(sub, t = 'day') {
    return this.#postSource(`posts r/${sub} top/${t}`, `https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=${t}&limit=${t === 'all' ? 25 : 50}&raw_json=1`, j => parseRedditPosts(j, sub), { hint: 'reddit often blocks cloud IPs; set POSTS=0 or proxy' });
  }
  pollMastodon(instance) { return this.#postSource(`posts mastodon ${instance}`, `https://${instance}/api/v1/trends/statuses?limit=40`, j => parseMastodon(j, instance)); }
  pollBluesky(feed) { return this.#postSource(`posts bluesky ${feed.split('/').pop()}`, `https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feed)}&limit=50`, parseBluesky); }
  pollYouTube() {
    if (!this.cfg.youtubeKey) return Promise.resolve(0);
    return this.#postSource('posts youtube', `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${encodeURIComponent(this.cfg.trendsGeo)}&maxResults=50&key=${encodeURIComponent(this.cfg.youtubeKey)}`, parseYouTube);
  }
  async pollTrends() {
    const name = 'trends google'; const t0 = Date.now(); const st = this.status[name] = { ok: false, ts: t0, err: null };
    try {
      const r = await this.f(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(this.cfg.trendsGeo)}`, { headers: { 'user-agent': this.cfg.userAgent }, signal: AbortSignal.timeout(12000) });
      st.httpStatus = r.status; st.ms = Date.now() - t0;
      if (!r.ok) { st.err = `http ${r.status}`; return; }
      const list = parseGoogleTrends(await r.text()); this.trends.google = list; st.ok = list.length > 0; st.items = list.length; if (!list.length) st.err = 'parsed 0 items';
    } catch (e) { st.err = String(e && e.message || e); }
  }
  async pollXTrends() {
    if (!this.cfg.xBearer) return;
    const name = 'trends x'; const t0 = Date.now(); const st = this.status[name] = { ok: false, ts: t0, err: null };
    try {
      const r = await this.f('https://api.x.com/2/trends/by/woeid/1', { headers: { authorization: 'Bearer ' + this.cfg.xBearer, 'user-agent': this.cfg.userAgent }, signal: AbortSignal.timeout(12000) });
      st.httpStatus = r.status; st.ms = Date.now() - t0;
      if (!r.ok) { st.err = r.status === 401 || r.status === 403 ? `refused (${r.status}) — token invalid or plan lacks trends access` : `http ${r.status}`; return; }
      const list = parseXTrends(await r.json()); this.trends.x = list; st.ok = list.length > 0; st.items = list.length;
    } catch (e) { st.err = String(e && e.message || e); }
  }

  async pollWiki() {
    const d = new Date(Date.now() - 86400000 * 1.5);   // yesterday (UTC); today's list is not published yet
    const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), dd = String(d.getUTCDate()).padStart(2, '0');
    const name = 'Wikipedia top';
    const t0 = Date.now(); const st = this.status[name] = { ok: false, ts: t0, err: null };
    try {
      const { r, body } = await this.#get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${dd}`, { json: true });
      st.httpStatus = r.status; st.ms = Date.now() - t0;
      if (!r.ok) { st.err = `http ${r.status}`; return; }
      const list = parseWikiTop(body);
      this.engine.setWiki(list); st.ok = list.length > 0; st.items = list.length;
    } catch (e) { st.err = String(e && e.message || e); }
  }

  /** Start timers; first poll happens immediately, staggered so we don't hit everything in the same second. */
  start() {
    const every = (ms, fn, delay = 0) => { this.timers.push(setTimeout(() => { fn(); this.timers.push(setInterval(fn, ms)); }, delay)); };
    this.cfg.feeds.forEach((f, i) => every(this.cfg.feedPollSec * 1000, () => this.pollFeed(f), i * 400));
    if (this.cfg.gdeltEnabled) every(this.cfg.gdeltPollSec * 1000, () => this.pollGdelt(), 500);
    if (this.cfg.redditEnabled) this.cfg.redditSubs.forEach((s, i) => every(this.cfg.redditPollSec * 1000, () => this.pollReddit(s), 1500 + i * 2500));
    if (this.cfg.postsEnabled && this.posts) {
      const PS = this.cfg.postPollSec * 1000;
      this.cfg.postSubs.forEach((sub, i) => {
        every(PS, () => this.pollRedditTop(sub, 'day'), 6000 + i * 3000);
        every(2 * 3600000, () => this.pollRedditTop(sub, 'week'), 8000 + i * 3000);
        every(6 * 3600000, () => this.pollRedditTop(sub, 'month'), 10000 + i * 3000);
        every(24 * 3600000, () => this.pollRedditTop(sub, 'all'), 12000 + i * 3000);
      });
      this.cfg.mastodonInstances.forEach((m, i) => every(PS, () => this.pollMastodon(m), 4000 + i * 1000));
      this.cfg.bskyFeeds.forEach((f, i) => every(PS, () => this.pollBluesky(f), 5000 + i * 1000));
      every(3600000, () => this.pollYouTube(), 7000);
      every(15 * 60000, () => this.pollTrends(), 2000);
      every(15 * 60000, () => this.pollXTrends(), 2500);
    }
    if (this.cfg.wikiEnabled) every(6 * 3600 * 1000, () => this.pollWiki(), 3000);
  }
  stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }
}
