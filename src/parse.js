// Parsers for each source shape. All pure, all tolerant: unexpected input -> [] (never throws).
import { decode, stripTags } from './text.js';

const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };
const toTs = (s) => { const t = Date.parse(decode(s).trim()); return Number.isFinite(t) ? t : null; };

/** RSS 2.0, RSS 1.0/RDF and Atom. */
export function parseFeed(xml, source) {
  const out = [];
  if (typeof xml !== 'string' || !xml) return out;
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const title = stripTags(tag(b, 'title'));
    let url = stripTags(tag(b, 'link'));
    if (!url) { const m = b.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i); if (m) url = decode(m[1]); }
    if (!title || !/^https?:\/\//.test(url)) continue;
    const ts = toTs(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    out.push({ source: source.name, kind: 'rss', region: source.region || 'world', title, url, ts: ts || null, summary: stripTags(tag(b, 'description') || tag(b, 'summary')).slice(0, 300), points: 0 });
  }
  return out;
}

/** GDELT DOC 2.0 artlist JSON. seendate looks like 20261010T163000Z. */
export function parseGdelt(json) {
  const arts = json && Array.isArray(json.articles) ? json.articles : [];
  const out = [];
  for (const a of arts) {
    if (!a || !a.title || !/^https?:\/\//.test(a.url || '')) continue;
    const m = String(a.seendate || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    const ts = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
    out.push({ source: (a.domain || 'gdelt').replace(/^www\./, ''), kind: 'gdelt', region: 'world', title: stripTags(a.title), url: a.url, ts, summary: '', points: 0, country: a.sourcecountry || null });
  }
  return out;
}

/** Reddit listing JSON (hot.json). Points + comments are the virality signal. */
export function parseReddit(json, sub) {
  const kids = json && json.data && Array.isArray(json.data.children) ? json.data.children : [];
  const out = [];
  for (const k of kids) {
    const d = k && k.data;
    if (!d || !d.title || d.stickied) continue;
    const url = d.url_overridden_by_dest && /^https?:\/\//.test(d.url_overridden_by_dest) ? d.url_overridden_by_dest : 'https://www.reddit.com' + d.permalink;
    out.push({ source: 'r/' + sub, kind: 'reddit', region: 'viral', title: stripTags(d.title), url, ts: d.created_utc ? d.created_utc * 1000 : null, summary: '', points: Number(d.score) || 0, comments: Number(d.num_comments) || 0, permalink: 'https://www.reddit.com' + (d.permalink || '') });
  }
  return out;
}

/** Wikimedia daily top pages: { items:[{ articles:[{article,views,rank}] }] }. Skips meta pages. */
export function parseWikiTop(json) {
  const arts = json && json.items && json.items[0] && Array.isArray(json.items[0].articles) ? json.items[0].articles : [];
  return arts.filter(a => a && a.article && !/^(Main_Page|Special:|Wikipedia:|Portal:|Help:|File:|Category:|Template:|-)/.test(a.article))
    .map(a => ({ title: String(a.article).replace(/_/g, ' '), views: Number(a.views) || 0, rank: Number(a.rank) || 0 }));
}

// ---------------- viral POSTS ----------------
const NSFW_LABELS = /porn|sexual|nudity|gore|graphic/i;
const decodeUrl = (u) => decode(String(u || ''));

/** Reddit listing (hot/top). Skips NSFW and stickied. */
export function parseRedditPosts(json, sub) {
  const kids = json && json.data && Array.isArray(json.data.children) ? json.data.children : [];
  const out = [];
  for (const k of kids) {
    const d = k && k.data;
    if (!d || !d.title || d.stickied || d.over_18) continue;
    const prev = d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source && d.preview.images[0].source.url;
    const thumb = prev ? decodeUrl(prev) : (/^https?:/.test(d.thumbnail || '') ? d.thumbnail : null);
    out.push({ platform: 'reddit', nid: d.id, author: d.author || null, text: stripTags(d.title), url: 'https://www.reddit.com' + d.permalink, thumb, ts: d.created_utc ? d.created_utc * 1000 : null,
      community: 'r/' + (d.subreddit || sub), kind: d.is_video ? 'video' : (thumb ? 'image' : 'text'), metrics: { score: Number(d.score) || 0, comments: Number(d.num_comments) || 0 } });
  }
  return out;
}

/** Mastodon /api/v1/trends/statuses */
export function parseMastodon(json, instance) {
  const arr = Array.isArray(json) ? json : [];
  const out = [];
  for (const d of arr) {
    if (!d || !d.id || !d.url || d.sensitive) continue;
    const media = (d.media_attachments || [])[0];
    out.push({ platform: 'mastodon', nid: instance + ':' + d.id, author: d.account && d.account.acct ? '@' + d.account.acct : null, text: stripTags(d.content).slice(0, 400), url: d.url, thumb: media ? media.preview_url || null : null,
      ts: Date.parse(d.created_at) || null, community: instance, kind: media ? media.type || 'image' : 'text', metrics: { likes: Number(d.favourites_count) || 0, reposts: Number(d.reblogs_count) || 0, comments: Number(d.replies_count) || 0 } });
  }
  return out;
}

/** Bluesky getFeed (e.g. the public "whats-hot" generator). */
export function parseBluesky(json) {
  const arr = json && Array.isArray(json.feed) ? json.feed : [];
  const out = [];
  for (const f of arr) {
    const p = f && f.post;
    if (!p || !p.uri || !p.author || !p.author.handle) continue;
    if ((p.labels || []).some(l => NSFW_LABELS.test(l && l.val))) continue;
    const rkey = String(p.uri).split('/').pop();
    const emb = p.embed || {};
    const thumb = (emb.images && emb.images[0] && emb.images[0].thumb) || emb.thumbnail || (emb.external && emb.external.thumb) || null;
    out.push({ platform: 'bluesky', nid: p.uri, author: '@' + p.author.handle, text: stripTags(p.record && p.record.text).slice(0, 400), url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`, thumb,
      ts: Date.parse(p.record && p.record.createdAt) || null, community: 'bluesky', kind: thumb ? 'image' : 'text',
      metrics: { likes: Number(p.likeCount) || 0, reposts: (Number(p.repostCount) || 0) + (Number(p.quoteCount) || 0), comments: Number(p.replyCount) || 0 } });
  }
  return out;
}

/** YouTube Data API v3 videos.list?chart=mostPopular */
export function parseYouTube(json) {
  const arr = json && Array.isArray(json.items) ? json.items : [];
  return arr.filter(v => v && v.id && v.snippet).map(v => ({
    platform: 'youtube', nid: v.id, author: v.snippet.channelTitle || null, text: stripTags(v.snippet.title), url: 'https://www.youtube.com/watch?v=' + v.id,
    thumb: (v.snippet.thumbnails && ((v.snippet.thumbnails.medium || {}).url || (v.snippet.thumbnails.default || {}).url)) || null,
    ts: Date.parse(v.snippet.publishedAt) || null, community: 'youtube', kind: 'video',
    metrics: { views: Number(v.statistics && v.statistics.viewCount) || 0, likes: Number(v.statistics && v.statistics.likeCount) || 0, comments: Number(v.statistics && v.statistics.commentCount) || 0 } }));
}

const trafficNum = (s) => { const m = String(s || '').replace(/,/g, '').match(/([\d.]+)\s*([KM]?)/i); if (!m) return 0; return Math.round(parseFloat(m[1]) * (m[2].toUpperCase() === 'M' ? 1e6 : m[2].toUpperCase() === 'K' ? 1e3 : 1)); };
/** Google Trends "trending now" RSS: <ht:approx_traffic>200K+</ht:approx_traffic> */
export function parseGoogleTrends(xml) {
  if (typeof xml !== 'string') return [];
  return (xml.match(/<item>[\s\S]*?<\/item>/gi) || []).map(b => {
    const term = stripTags(tag(b, 'title'));
    const news = stripTags(tag(b, 'ht:news_item_title'));
    return term ? { platform: 'google', term, traffic: trafficNum(tag(b, 'ht:approx_traffic')), headline: news || null, url: stripTags(tag(b, 'ht:news_item_url')) || stripTags(tag(b, 'link')) || null, ts: toTs(tag(b, 'pubDate')) } : null;
  }).filter(Boolean);
}
/** X API v2 trends/by/woeid */
export function parseXTrends(json) {
  const arr = json && Array.isArray(json.data) ? json.data : [];
  return arr.filter(t => t && t.trend_name).map(t => ({ platform: 'x', term: t.trend_name, traffic: Number(t.tweet_count) || 0, headline: null, url: 'https://x.com/search?q=' + encodeURIComponent(t.trend_name), ts: null }));
}
