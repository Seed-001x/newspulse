// posts.js — viral POSTS store (Reddit, Mastodon, Bluesky, YouTube, ...) with daily / weekly / monthly / all-time ranking.
//
//   engagement  = platform-weighted interactions     reddit: score + 2*comments | mastodon: likes + 2*reposts + comments
//                                                    bluesky: likes + 2*reposts + comments | youtube: views/100 + likes + 3*comments
//   velocity    = engagement gained per hour (between sightings when we have them, else lifetime average)
//   viral       = 100 * (0.6 * engagementPercentile + 0.4 * velocityPercentile)   — percentiles are WITHIN each platform and window,
//                 because 300 likes on Mastodon and 30,000 points on Reddit are not comparable raw numbers.
import fs from 'node:fs';
import path from 'node:path';
import { tokens } from './text.js';
import { topicsOf } from './score.js';

const WINDOWS = { day: 24, week: 24 * 7, month: 24 * 30, all: Infinity };
const SUB_CATEGORY = {
  aww: 'animals', animals: 'animals', natureisfuckinglit: 'animals', memes: 'meme', dankmemes: 'meme', me_irl: 'meme', funny: 'meme',
  gaming: 'gaming', pcgaming: 'gaming', sports: 'sports', nba: 'sports', soccer: 'sports', nfl: 'sports', technology: 'tech', gadgets: 'tech',
  science: 'science', space: 'science', movies: 'entertainment', television: 'entertainment', popculturechat: 'entertainment', music: 'entertainment',
  worldnews: 'news', news: 'news', politics: 'politics', interestingasfuck: 'viral', nextfuckinglevel: 'viral', damnthatsinteresting: 'viral', nottheonion: 'viral',
  cryptocurrency: 'crypto', solana: 'crypto', wallstreetbets: 'business', finance: 'business', food: 'lifestyle', pics: 'viral', videos: 'viral',
};

export function engagementOf(p) {
  const m = p.metrics || {};
  switch (p.platform) {
    case 'reddit': return (m.score || 0) + 2 * (m.comments || 0);
    case 'mastodon': case 'bluesky': return (m.likes || 0) + 2 * (m.reposts || 0) + (m.comments || 0);
    case 'youtube': return (m.views || 0) / 100 + (m.likes || 0) + 3 * (m.comments || 0);
    default: return Object.values(m).reduce((a, b) => a + (Number(b) || 0), 0);
  }
}
export function categoriesOf(p) {
  const out = new Set();
  const sub = p.community && p.community.startsWith('r/') ? p.community.slice(2).toLowerCase() : null;
  if (sub && SUB_CATEGORY[sub]) out.add(SUB_CATEGORY[sub]);
  for (const t of topicsOf(tokens(p.text))) out.add(t);
  if (p.kind === 'video') out.add('video');
  if (!out.size) out.add('general');
  return [...out];
}

export class PostStore {
  constructor(cfg, { now = Date.now } = {}) { this.cfg = cfg; this.now = now; this.posts = new Map(); }

  add(p) {
    if (!p || !p.platform || !p.nid || !p.url || !p.text) return false;
    const now = this.now();
    const ts = p.ts && p.ts <= now + 5 * 60000 ? p.ts : now;
    const id = p.platform + ':' + p.nid;
    const eng = engagementOf(p);
    const prev = this.posts.get(id);
    if (!prev) {
      this.posts.set(id, { id, platform: p.platform, author: p.author || null, text: p.text.slice(0, 400), url: p.url, thumb: p.thumb || null, ts, community: p.community || null, kind: p.kind || 'text',
        metrics: { ...p.metrics }, engagement: eng, firstSeen: now, lastSeen: now, samples: [{ t: now, e: eng }], categories: categoriesOf(p) });
      return true;
    }
    prev.lastSeen = now;
    for (const [k, v] of Object.entries(p.metrics || {})) prev.metrics[k] = Math.max(prev.metrics[k] || 0, v);
    prev.engagement = Math.max(prev.engagement, eng);
    const last = prev.samples[prev.samples.length - 1];
    if (now - last.t >= 10 * 60000) { prev.samples.push({ t: now, e: prev.engagement }); if (prev.samples.length > 6) prev.samples.shift(); }
    return false;
  }

  velocity(p) {
    const now = this.now();
    const s = p.samples;
    if (s.length >= 2) { const a = s[s.length - 2], b = s[s.length - 1]; const h = (b.t - a.t) / 3600000; if (h >= 1 / 6) return Math.max(0, (b.e - a.e) / h); }
    return p.engagement / Math.max(0.5, (now - p.ts) / 3600000);
  }

  prune() {
    const cut = this.now() - this.cfg.postKeepDays * 86400000;
    for (const [id, p] of this.posts) if (p.ts < cut && p.lastSeen < cut) this.posts.delete(id);
    if (this.posts.size > this.cfg.postMax) {
      const keep = [...this.posts.values()].sort((a, b) => b.engagement - a.engagement).slice(0, this.cfg.postMax);
      this.posts = new Map(keep.map(p => [p.id, p]));
    }
  }

  /** window: day | week | month | all. Percentiles use max(n, 20) so a platform with 2 posts cannot take the top by default. */
  rank({ window = 'day', platform, category, community, q, limit = 50 } = {}) {
    const now = this.now(), hrs = WINDOWS[window] ?? WINDOWS.day;
    let list = [...this.posts.values()].filter(p => (hrs === Infinity || now - p.ts <= hrs * 3600000) && (!platform || p.platform === platform));
    const byPlat = new Map();
    for (const p of list) (byPlat.get(p.platform) || byPlat.set(p.platform, []).get(p.platform)).push(p);
    const scored = [];
    for (const arr of byPlat.values()) {
      const N = Math.max(arr.length, 20);
      const vel = new Map(arr.map(p => [p.id, this.velocity(p)]));
      const rankPct = (key) => { const sorted = [...arr].sort((a, b) => key(a) - key(b)); const m = new Map(); sorted.forEach((p, i) => m.set(p.id, (i + 1) / N)); return m; };
      const pe = rankPct(p => p.engagement), pv = rankPct(p => vel.get(p.id));
      for (const p of arr) scored.push({ p, viral: Math.round(100 * (0.6 * pe.get(p.id) + 0.4 * pv.get(p.id)) * 10) / 10, velocity: vel.get(p.id) });
    }
    let out = scored;
    if (category) out = out.filter(x => x.p.categories.includes(category));
    if (community) out = out.filter(x => (x.p.community || '').toLowerCase() === community.toLowerCase());
    if (q) { const qt = tokens(q); out = out.filter(x => { const t = tokens(x.p.text); for (const w of qt) if (!t.has(w)) return false; return qt.size > 0; }); }
    return out.sort((a, b) => b.viral - a.viral || b.p.engagement - a.p.engagement).slice(0, limit).map(({ p, viral, velocity }) => ({
      id: p.id, platform: p.platform, author: p.author, text: p.text, url: p.url, thumb: p.thumb, community: p.community, kind: p.kind, categories: p.categories,
      ts: p.ts, ageMin: Math.round((now - p.ts) / 60000), metrics: p.metrics, engagement: Math.round(p.engagement), velocityPerHour: Math.round(velocity), viral }));
  }

  summary() {
    const out = {};
    for (const p of this.posts.values()) { const o = out[p.platform] ||= { posts: 0, categories: {} }; o.posts++; for (const c of p.categories) o.categories[c] = (o.categories[c] || 0) + 1; }
    return out;
  }
  categories() { const c = {}; for (const p of this.posts.values()) for (const k of p.categories) c[k] = (c[k] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })); }

  save(dir) { try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'posts.json'); fs.writeFileSync(f + '.tmp', JSON.stringify([...this.posts.values()])); fs.renameSync(f + '.tmp', f); } catch { /* never crash */ } }
  load(dir) { try { for (const p of JSON.parse(fs.readFileSync(path.join(dir, 'posts.json'), 'utf8'))) this.posts.set(p.id, p); this.prune(); return this.posts.size; } catch { return 0; } }
}
