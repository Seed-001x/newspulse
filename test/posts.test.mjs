import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { parseRedditPosts, parseMastodon, parseBluesky, parseYouTube, parseGoogleTrends, parseXTrends } from '../src/parse.js';
import { PostStore, engagementOf, categoriesOf } from '../src/posts.js';
import { Engine } from '../src/engine.js';
import { Collector } from '../src/collector.js';
import { createServer } from '../src/server.js';

const cfg = loadConfig({});
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const clock = { t: NOW };
const store = () => new PostStore(cfg, { now: () => clock.t });
const P = (platform, nid, text, hoursAgo, metrics, extra = {}) => ({ platform, nid, text, url: `https://${platform}.test/${nid}`, ts: NOW - hoursAgo * 3600000, metrics, community: platform === 'reddit' ? 'r/memes' : platform, kind: 'text', ...extra });

test('parsers: reddit (skips NSFW + stickied), mastodon (skips sensitive), bluesky (skips labelled), youtube, trends', () => {
  const r = parseRedditPosts({ data: { children: [
    { data: { id: 'a1', title: 'Tiger in raccoon suit', permalink: '/r/memes/comments/a1/x/', score: 90000, num_comments: 2000, created_utc: 1791633600, subreddit: 'memes', author: 'u1', preview: { images: [{ source: { url: 'https://i.redd.it/a.jpg?x=1&amp;y=2' } }] } } },
    { data: { id: 'a2', title: 'nsfw', permalink: '/x', over_18: true } }, { data: { id: 'a3', title: 'sticky', permalink: '/y', stickied: true } }] } }, 'memes');
  assert.equal(r.length, 1); assert.equal(r[0].thumb, 'https://i.redd.it/a.jpg?x=1&y=2'); assert.equal(r[0].community, 'r/memes'); assert.equal(r[0].kind, 'image');
  const m = parseMastodon([{ id: '1', url: 'https://m.test/1', created_at: '2026-10-10T10:00:00Z', content: '<p>hello <b>world</b></p>', favourites_count: 100, reblogs_count: 20, replies_count: 5, account: { acct: 'a@b' } }, { id: '2', url: 'https://m.test/2', sensitive: true }], 'm.test');
  assert.equal(m.length, 1); assert.equal(m[0].text, 'hello world'); assert.equal(m[0].metrics.reposts, 20);
  const b = parseBluesky({ feed: [{ post: { uri: 'at://did:plc:x/app.bsky.feed.post/3abc', author: { handle: 'u.bsky.social' }, record: { text: 'hot take', createdAt: '2026-10-10T09:00:00Z' }, likeCount: 500, repostCount: 50, replyCount: 10, quoteCount: 5 } }, { post: { uri: 'at://x/y/z', author: { handle: 'n' }, record: { text: 'bad' }, labels: [{ val: 'porn' }] } }] });
  assert.equal(b.length, 1); assert.equal(b[0].url, 'https://bsky.app/profile/u.bsky.social/post/3abc'); assert.equal(b[0].metrics.reposts, 55);
  const y = parseYouTube({ items: [{ id: 'v1', snippet: { title: 'Big video', channelTitle: 'Ch', publishedAt: '2026-10-09T10:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/m.jpg' } } }, statistics: { viewCount: '1200000', likeCount: '50000', commentCount: '900' } }] });
  assert.equal(y[0].metrics.views, 1200000);
  const g = parseGoogleTrends(`<rss><channel><item><title>tiger escape</title><ht:approx_traffic>200K+</ht:approx_traffic><pubDate>Sat, 10 Oct 2026 11:00:00 GMT</pubDate><ht:news_item><ht:news_item_title>Tiger escapes</ht:news_item_title><ht:news_item_url>https://n.test/1</ht:news_item_url></ht:news_item></item></channel></rss>`);
  assert.equal(g[0].traffic, 200000); assert.equal(g[0].url, 'https://n.test/1');
  assert.equal(parseXTrends({ data: [{ trend_name: '#Tiger', tweet_count: 12000 }] })[0].traffic, 12000);
  for (const f of [parseRedditPosts, parseMastodon, parseBluesky, parseYouTube, parseGoogleTrends, parseXTrends]) assert.doesNotThrow(() => f(null, 'x'));
});

test('engagement + categories', () => {
  assert.equal(engagementOf({ platform: 'reddit', metrics: { score: 100, comments: 10 } }), 120);
  assert.equal(engagementOf({ platform: 'bluesky', metrics: { likes: 10, reposts: 5, comments: 1 } }), 21);
  assert.ok(categoriesOf({ text: 'Cute tiger cub at the zoo', community: 'r/aww' }).includes('animals'));
  assert.ok(categoriesOf({ text: 'whatever', community: 'r/gaming', kind: 'video' }).includes('gaming'));
  assert.deepEqual(categoriesOf({ text: 'zzz qqq', community: 'x' }), ['general']);
});

test('windows: day / week / month / all filter by when the post was created', () => {
  const s = store();
  s.add(P('reddit', 'd', 'Daily hit', 3, { score: 5000, comments: 100 }));
  s.add(P('reddit', 'w', 'Weekly hit', 24 * 4, { score: 90000, comments: 3000 }));
  s.add(P('reddit', 'm', 'Monthly hit', 24 * 20, { score: 200000, comments: 9000 }));
  assert.deepEqual(s.rank({ window: 'day' }).map(p => p.text), ['Daily hit']);
  assert.deepEqual(s.rank({ window: 'week' }).map(p => p.text).sort(), ['Daily hit', 'Weekly hit']);
  assert.equal(s.rank({ window: 'month' }).length, 3); assert.equal(s.rank({ window: 'all' })[0].text, 'Monthly hit');
});
test('percentile is per platform: a huge Reddit post and a big Bluesky post can both be on top of their platform; tiny platforms cannot take #1 by default', () => {
  const s = store();
  for (let i = 0; i < 30; i++) s.add(P('reddit', 'r' + i, 'reddit post number ' + i, 5, { score: 100 * (i + 1), comments: 10 }));
  s.add(P('bluesky', 'b1', 'lonely bluesky post', 5, { likes: 3, reposts: 0, comments: 0 }));
  const top = s.rank({ window: 'day', limit: 3 });
  assert.equal(top[0].platform, 'reddit'); assert.equal(s.rank({ platform: 'bluesky' }).length, 1);
  assert.ok(s.rank({ platform: 'bluesky' })[0].viral < 20);
});
test('velocity from repeat sightings beats a slow burner with the same total', () => {
  const s = store();
  for (let i = 0; i < 25; i++) s.add(P('reddit', 'f' + i, 'filler ' + i, 6, { score: 50 + i, comments: 1 }));
  s.add(P('reddit', 'fast', 'Rocketing post', 6, { score: 1000, comments: 50 })); s.add(P('reddit', 'slow', 'Slow burner', 6, { score: 1100, comments: 50 }));
  clock.t = NOW + 30 * 60000;
  s.add(P('reddit', 'fast', 'Rocketing post', 6, { score: 6000, comments: 300 }));      // +5000 in 30 min
  s.add(P('reddit', 'slow', 'Slow burner', 6, { score: 1150, comments: 52 }));
  const r = s.rank({ window: 'day', limit: 5 });
  assert.equal(r[0].text, 'Rocketing post'); assert.ok(r[0].velocityPerHour > 5000);
  clock.t = NOW;
});
test('filters: platform, category, community, text query; dedupe by id; metrics only grow', () => {
  const s = store();
  assert.equal(s.add(P('reddit', 'a', 'Tiger cub plays with ball', 2, { score: 10, comments: 1 }, { community: 'r/aww' })), true);
  assert.equal(s.add(P('reddit', 'a', 'Tiger cub plays with ball', 2, { score: 5, comments: 1 }, { community: 'r/aww' })), false);
  s.add(P('mastodon', 'x', 'Election results tonight', 2, { likes: 50, reposts: 5, comments: 1 }));
  assert.equal(s.rank({ category: 'animals' }).length, 1); assert.equal(s.rank({ platform: 'mastodon' }).length, 1); assert.equal(s.rank({ community: 'r/aww' }).length, 1);
  assert.equal(s.rank({ q: 'tiger ball' }).length, 1); assert.equal(s.rank({ q: 'tiger election' }).length, 0);
  assert.equal(s.posts.get('reddit:a').metrics.score, 10);
  assert.equal(s.add({ platform: 'x', nid: '', text: 't', url: 'u' }), false);
});
test('prune caps size by engagement; save/load round-trips', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const c2 = { ...cfg, postMax: 5 }; const s = new PostStore(c2, { now: () => NOW });
  for (let i = 0; i < 12; i++) s.add(P('reddit', 'p' + i, 'post ' + i, 2, { score: i * 10, comments: 0 }));
  s.prune(); assert.equal(s.posts.size, 5); assert.ok(s.posts.has('reddit:p11') && !s.posts.has('reddit:p0'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-')); s.save(dir);
  const s2 = new PostStore(c2, { now: () => NOW }); assert.equal(s2.load(dir), 5);
});

test('collector: post sources feed the store, not the news engine; errors are explained; trends stored', async () => {
  const e = new Engine(cfg, { now: () => NOW }); const s = store();
  const reddit = { data: { children: [{ data: { id: 'z', title: 'Viral tiger', permalink: '/r/memes/z', score: 777, num_comments: 7, created_utc: NOW / 1000 - 600, subreddit: 'memes' } }] } };
  const f = async (url) => {
    if (url.includes('reddit.com/r/memes')) return { ok: true, status: 200, json: async () => reddit };
    if (url.includes('reddit.com/r/blocked')) return { ok: false, status: 403 };
    if (url.includes('trends.google')) return { ok: true, status: 200, text: async () => '<rss><channel><item><title>tiger</title><ht:approx_traffic>50K+</ht:approx_traffic></item></channel></rss>' };
    if (url.includes('api.x.com')) return { ok: false, status: 403 };
    throw new Error('offline');
  };
  const c = new Collector(e, { ...cfg, xBearer: 'tok', youtubeKey: '' }, { fetchImpl: f, posts: s });
  await c.pollRedditTop('memes', 'day'); await c.pollRedditTop('blocked', 'day'); await c.pollMastodon('m.test'); await c.pollTrends(); await c.pollXTrends();
  assert.equal(s.posts.size, 1); assert.equal(e.itemCount, 0);
  assert.match(c.status['posts r/blocked top/day'].err, /refused \(403\)/); assert.equal(c.status['posts mastodon m.test'].err, 'offline');
  assert.equal(c.trends.google[0].traffic, 50000); assert.match(c.status['trends x'].err, /plan lacks trends access/);
  assert.equal(await c.pollYouTube(), 0);
});

test('API: /api/posts, /api/posts/meta, /api/trends', async () => {
  const e = new Engine(cfg, { now: () => NOW }); const s = store();
  s.add(P('reddit', 'a', 'Tiger cub plays with ball', 2, { score: 900, comments: 10 }, { community: 'r/aww' }));
  const c = new Collector(e, cfg, { fetchImpl: async () => { throw new Error('x'); }, posts: s }); c.trends.google = [{ platform: 'google', term: 'tiger', traffic: 1000 }];
  const app = createServer({ engine: e, collector: c, cfg, posts: s });
  const srv = http.createServer(app.handler); await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port, j = async (p) => (await fetch(base + p)).json();
  try {
    assert.equal((await j('/api/posts?window=week')).posts.length, 1);
    assert.equal((await j('/api/posts?category=animals&platform=reddit')).posts[0].platform, 'reddit');
    assert.equal((await j('/api/posts?window=bogus')).window, 'day');
    const meta = await j('/api/posts/meta'); assert.equal(meta.platforms.reddit.posts, 1); assert.ok(meta.categories.find(x => x.name === 'animals'));
    assert.equal((await j('/api/trends')).trends.google[0].term, 'tiger');
  } finally { app.close(); srv.closeAllConnections?.(); srv.close(); }
});
