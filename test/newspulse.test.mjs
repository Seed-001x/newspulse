import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { parseFeed, parseGdelt, parseReddit, parseWikiTop } from '../src/parse.js';
import { tokens, entities, similarity } from '../src/text.js';
import { Engine } from '../src/engine.js';
import { Collector } from '../src/collector.js';
import { createServer } from '../src/server.js';
import { matchCoin } from '../src/match.js';

const cfg = loadConfig({});
let T = Date.UTC(2026, 9, 10, 12, 0, 0);
const mk = () => { const clock = { t: T }; const e = new Engine(cfg, { now: () => clock.t }); return { e, clock }; };
const it = (source, title, url, minAgo = 0, extra = {}) => ({ source, kind: 'rss', region: 'world', title, url, ts: T - minAgo * 60000, points: 0, ...extra });

// ---------------- parsing ----------------
test('parseFeed: RSS 2.0 with CDATA + entities, RDF and Atom', () => {
  const rss = `<rss><channel><item><title><![CDATA[Tiger escapes &amp; roams Texas town]]></title><link>https://a.test/1</link><pubDate>Sat, 10 Oct 2026 11:50:00 GMT</pubDate><description>&lt;p&gt;Hello&lt;/p&gt;</description></item></channel></rss>`;
  const r = parseFeed(rss, { name: 'A', region: 'us' });
  assert.equal(r.length, 1); assert.equal(r[0].title, 'Tiger escapes & roams Texas town'); assert.equal(r[0].summary, 'Hello'); assert.equal(r[0].ts, Date.UTC(2026, 9, 10, 11, 50));
  const atom = `<feed><entry><title>Atom story here</title><link href="https://b.test/2"/><updated>2026-10-10T11:00:00Z</updated></entry></feed>`;
  assert.equal(parseFeed(atom, { name: 'B' })[0].url, 'https://b.test/2');
  const rdf = `<rdf:RDF><item rdf:about="x"><title>RDF headline</title><link>https://c.test/3</link><dc:date>2026-10-10T10:00:00Z</dc:date></item></rdf:RDF>`;
  assert.equal(parseFeed(rdf, { name: 'C' }).length, 1);
  assert.deepEqual(parseFeed('<html>blocked</html>', { name: 'D' }), []); assert.deepEqual(parseFeed(null, { name: 'D' }), []);
  assert.equal(parseFeed('<item><title>No link</title></item>', { name: 'E' }).length, 0);
});
test('parseGdelt / parseReddit / parseWikiTop', () => {
  const g = parseGdelt({ articles: [{ url: 'https://www.x.com/a', title: 'GD title', seendate: '20261010T113000Z', domain: 'www.x.com', sourcecountry: 'US' }, { url: 'bad', title: 'x' }] });
  assert.equal(g.length, 1); assert.equal(g[0].ts, Date.UTC(2026, 9, 10, 11, 30)); assert.equal(g[0].source, 'x.com');
  const r = parseReddit({ data: { children: [{ data: { title: 'Wild tiger', permalink: '/r/news/c/1/', score: 5000, num_comments: 300, created_utc: 1791633600, url_overridden_by_dest: 'https://news.test/t' } }, { data: { title: 'sticky', stickied: true, permalink: '/x' } }] } }, 'news');
  assert.equal(r.length, 1); assert.equal(r[0].points, 5000); assert.equal(r[0].source, 'r/news'); assert.equal(r[0].url, 'https://news.test/t');
  const w = parseWikiTop({ items: [{ articles: [{ article: 'Main_Page', views: 9, rank: 1 }, { article: 'Special:Search', views: 8, rank: 2 }, { article: 'Tiger_King', views: 7, rank: 3 }] }] });
  assert.deepEqual(w.map(x => x.title), ['Tiger King']);
  assert.deepEqual(parseGdelt(null), []); assert.deepEqual(parseReddit(null, 'x'), []); assert.deepEqual(parseWikiTop({}), []);
});
test('text: tokens drop stopwords, entities find proper nouns, similarity', () => {
  assert.ok(tokens('The Tiger escapes from zoo').has('tiger') && !tokens('The Tiger escapes').has('the'));
  assert.ok(entities('Police chase Tschuna Tiger through Dallas').includes('Tschuna Tiger'));
  assert.ok(similarity(tokens('Tiger escapes Texas zoo'), tokens('Texas zoo tiger escapes, police say')).jaccard > 0.5);
});

// ---------------- clustering + scoring ----------------
test('same event from different outlets merges into ONE story; unrelated stays separate', () => {
  const { e } = mk();
  e.addItem(it('BBC', 'Tiger escapes from Texas zoo, police issue warning', 'https://bbc/1', 20));
  e.addItem(it('CNN', 'Police warn residents after tiger escapes Texas zoo', 'https://cnn/1', 15));
  e.addItem(it('NPR', 'Texas zoo tiger escapes; residents told to stay indoors', 'https://npr/1', 10));
  e.addItem(it('FT', 'Bank of England holds interest rates at 4.5%', 'https://ft/1', 5));
  assert.equal(e.stories.size, 2);
  const tiger = [...e.stories.values()].find(s => s.tokens.has('tiger'));
  assert.equal(tiger.sources.size, 3); assert.equal(tiger.firstSource, 'BBC');
});
test('same URL twice is not double counted', () => {
  const { e } = mk();
  e.addItem(it('BBC', 'Tiger escapes Texas zoo overnight', 'https://bbc/1', 5)); e.addItem(it('BBC', 'Tiger escapes Texas zoo overnight', 'https://bbc/1', 4));
  assert.equal(e.itemCount, 2); assert.equal([...e.stories.values()][0].items.length, 1);
});
test('old entries are ignored', () => { const { e } = mk(); assert.equal(e.addItem(it('BBC', 'Ancient story about nothing much', 'https://x/1', 60 * 40)), null); });
test('ranking: wide + fast + social beats single-source and beats stale', () => {
  const { e, clock } = mk();
  for (const [s, m] of [['BBC', 25], ['CNN', 20], ['NPR', 12], ['Sky', 8], ['r/news', 6]]) e.addItem(it(s, 'Tiger escapes Texas zoo, police warn residents', 'https://' + s + '/t', m, s.startsWith('r/') ? { kind: 'reddit', points: 4000, comments: 400, region: 'viral' } : {}));
  e.addItem(it('DW', 'Parliament debates new fishing quota regulation', 'https://dw/f', 10));
  // stale but wide: 10 sources 20h ago
  for (let i = 0; i < 10; i++) e.addItem(it('S' + i, 'Central bank signals gradual easing policy path', 'https://s' + i + '/b', 60 * 20 + i));
  const top = e.top({ limit: 5 });
  assert.match(top[0].headline, /Tiger/); assert.ok(top[0].score > top[1].score);
  const stale = top.find(s => /bank/i.test(s.headline)); const single = top.find(s => /fishing/i.test(s.headline));
  assert.ok(top[0].score > stale.score && top[0].score > single.score);
  assert.match(e.breaking({ limit: 3 })[0].headline, /Tiger/);
  // decay over time
  const before = top[0].score; clock.t += 12 * 3600000;
  assert.ok(e.top({ limit: 5, hours: 72 }).find(s => /Tiger/.test(s.headline)).score < before * 0.6);
});
test('reddit-only viral post can still rank (the "tiger meme" case)', () => {
  const { e } = mk();
  e.addItem(it('r/interestingasfuck', 'Tiger in a raccoon costume stuns crowd', 'https://reddit.test/1', 20, { kind: 'reddit', points: 9000, comments: 800, region: 'viral' }));
  e.addItem(it('DW', 'Parliament debates new fishing quota regulation', 'https://dw/f', 10));
  assert.match(e.top({ limit: 1 })[0].headline, /Tiger/);
});
test('daily: best score each story reached today, survives decay', () => {
  const { e, clock } = mk();
  for (const [s, m] of [['BBC', 25], ['CNN', 20], ['NPR', 12]]) e.addItem(it(s, 'Tiger escapes Texas zoo, police warn residents', 'https://' + s + '/t', m));
  e.rank(); clock.t += 3 * 3600000;
  const d = e.daily(new Date(clock.t).toISOString().slice(0, 10), 5);
  assert.equal(d.length, 1); assert.ok(d[0].bestScore >= d[0].score);
});
test('topics and filters', () => {
  const { e } = mk();
  e.addItem(it('BBC', 'Tiger escapes Texas zoo, police warn residents', 'https://bbc/1', 5, { region: 'uk' }));
  e.addItem(it('CNBC', 'Stocks fall as inflation worries hit bank shares', 'https://cnbc/1', 5, { region: 'business' }));
  assert.equal(e.top({ topic: 'animals' }).length, 1); assert.equal(e.top({ topic: 'business' })[0].headline.startsWith('Stocks'), true);
  assert.equal(e.top({ region: 'uk' }).length, 1); assert.equal(e.top({ q: 'tiger zoo' }).length, 1); assert.equal(e.top({ q: 'tiger zoo' })[0].headline.includes('Tiger'), true);
});

// ---------------- coin matching ----------------
test('coin matcher: tiger coin matches the tiger story, not the bank story; generic-only names match nothing', () => {
  const { e } = mk();
  for (const [s, m] of [['BBC', 25], ['CNN', 20], ['NPR', 12]]) e.addItem(it(s, 'Tschuna the Tiger escapes Texas zoo, police warn residents', 'https://' + s + '/t', m));
  e.addItem(it('FT', 'Bank of England holds interest rates at 4.5%', 'https://ft/1', 5));
  const m = matchCoin({ name: 'Tschuna the Tiger', symbol: 'Tschuna' }, e.rank(), e);
  assert.equal(m.length, 1); assert.match(m[0].story.headline, /Tiger/); assert.ok(m[0].confidence > 0.3);
  assert.deepEqual(matchCoin({ name: 'Bank Coin', symbol: 'BNK' }, e.rank(), e).map(x => x.story.headline).filter(h => /Tiger/.test(h)), []);
  assert.deepEqual(matchCoin({ name: 'Coin Token', symbol: 'INU' }, e.rank(), e), []);
});

// ---------------- persistence ----------------
test('save/load round-trips stories', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  const { e, clock } = mk();
  e.addItem(it('BBC', 'Tiger escapes Texas zoo, police warn residents', 'https://bbc/1', 5)); e.rank(); e.save(dir);
  const e2 = new Engine(cfg, { now: () => clock.t }); assert.equal(e2.load(dir), 1);
  assert.equal(e2.top()[0].headline.startsWith('Tiger'), true);
  assert.equal(new Engine(cfg).load(path.join(dir, 'nope')), 0);
});

// ---------------- collector ----------------
test('collector: records per-source health, handles http errors / garbage / throws', async () => {
  const { e } = mk();
  const rss = `<rss><channel><item><title>Tiger escapes Texas zoo overnight</title><link>https://good/1</link><pubDate>Sat, 10 Oct 2026 11:55:00 GMT</pubDate></item></channel></rss>`;
  const fakeFetch = async (url) => {
    if (url.includes('good')) return { ok: true, status: 200, text: async () => rss, json: async () => ({}) };
    if (url.includes('blocked')) return { ok: false, status: 403 };
    if (url.includes('garbage')) return { ok: true, status: 200, text: async () => '<html>captcha</html>' };
    if (url.includes('reddit')) return { ok: false, status: 429 };
    throw new Error('boom');
  };
  const c = new Collector(e, cfg, { fetchImpl: fakeFetch });
  assert.equal(await c.pollFeed({ name: 'Good', url: 'https://good/rss', region: 'us' }), 1);
  await c.pollFeed({ name: 'Blocked', url: 'https://blocked/rss' }); await c.pollFeed({ name: 'Garbage', url: 'https://garbage/rss' }); await c.pollFeed({ name: 'Boom', url: 'https://boom/rss' });
  await c.pollReddit('news');
  assert.equal(c.status.Good.ok, true); assert.equal(c.status.Blocked.err, 'http 403'); assert.match(c.status.Garbage.err, /parsed 0/); assert.equal(c.status.Boom.err, 'boom'); assert.match(c.status['r/news'].err, /reddit refused/);
});

// ---------------- HTTP API ----------------
test('API endpoints', async () => {
  const { e } = mk();
  for (const [s, m] of [['BBC', 25], ['CNN', 20], ['NPR', 12]]) e.addItem(it(s, 'Tiger escapes Texas zoo, police warn residents', 'https://' + s + '/t', m));
  const c = new Collector(e, cfg, { fetchImpl: async () => { throw new Error('x'); } });
  const app = createServer({ engine: e, collector: c, cfg });
  const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const j = async (p) => (await fetch(base + p)).json();
  try {
    assert.equal((await j('/api/health')).ok, true);
    const top = await j('/api/top?limit=5'); assert.equal(top.stories.length, 1); assert.equal(top.stories[0].nSources, 3);
    assert.equal((await j('/api/breaking')).stories.length, 1);
    assert.equal((await j('/api/daily')).stories.length, 1);
    const id = top.stories[0].id; assert.equal((await j('/api/story/' + id)).id, id); assert.equal((await fetch(base + '/api/story/nope')).status, 404);
    assert.ok((await j('/api/keywords')).keywords.length >= 0);
    assert.equal((await j('/api/match?name=' + encodeURIComponent('Tiger Zoo') + '&symbol=TZ')).matches.length, 1);
    assert.equal((await fetch(base + '/api/match')).status, 400);
    assert.equal((await fetch(base + '/api/top', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/top', { method: 'OPTIONS' })).status, 204);
    // SSE sends an initial event
    const ctrl = new AbortController(); const r = await fetch(base + '/api/stream', { signal: ctrl.signal });
    const reader = r.body.getReader(); let buf = ''; while (!buf.includes('event: breaking')) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); }
    assert.match(buf, /Tiger/); ctrl.abort();
  } finally { app.close(); srv.closeAllConnections?.(); srv.close(); }
});
