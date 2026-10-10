// engine.js — in-memory story store: clusters items into stories, ranks them, keeps a per-day "best score" log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tokens, entities, similarity } from './text.js';
import { scoreStory, topicsOf } from './score.js';

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

export class Engine {
  constructor(cfg, { now = Date.now } = {}) {
    this.cfg = cfg; this.now = now;
    this.stories = new Map();   // id -> story
    this.urlToStory = new Map();
    this.wiki = new Map();      // lowercased title -> { rank, views }
    this.dailyBest = {};        // 'YYYY-MM-DD' -> { storyId: { score, headline } }
    this.itemCount = 0;
  }

  setWiki(list) { this.wiki = new Map(list.map(a => [a.title.toLowerCase(), a])); }

  /** Returns the story the item was added to, or null if ignored. */
  addItem(item) {
    const now = this.now();
    const ts = item.ts && item.ts <= now + 5 * 60000 ? item.ts : now;
    if (now - ts > this.cfg.maxItemAgeHours * 3600000) return null;
    if (!item.title || !item.url) return null;
    const known = this.urlToStory.get(item.url);
    const toks = tokens(item.title);
    if (toks.size < 2) return null;

    let story = known ? this.stories.get(known) : null;
    if (!story) {
      let best = null, bestSim = null;
      for (const s of this.stories.values()) {
        const sim = similarity(toks, s.tokens);
        const ok = sim.jaccard >= this.cfg.simJaccard || (sim.overlap >= this.cfg.simOverlap && sim.shared >= this.cfg.simMinShared);
        if (ok && (!bestSim || sim.jaccard > bestSim.jaccard || (sim.jaccard === bestSim.jaccard && sim.shared > bestSim.shared))) { best = s; bestSim = sim; }
      }
      story = best || this.#newStory(item, ts);
    }
    this.#attach(story, item, ts, toks);
    return story;
  }

  #newStory(item, ts) {
    const id = crypto.createHash('sha1').update(item.url + '|' + item.title).digest('hex').slice(0, 10);
    const s = { id, headline: item.title, headlineKind: item.kind, firstSeen: ts, lastSeen: ts, tokens: new Set(), tokenCounts: new Map(), entities: new Map(), sources: new Map(), items: [], firstSource: item.source, regions: new Set() };
    this.stories.set(id, s);
    return s;
  }

  #attach(story, item, ts, toks) {
    this.urlToStory.set(item.url, story.id);
    this.itemCount++;
    story.lastSeen = Math.max(story.lastSeen, ts);
    if (ts < story.firstSeen) { story.firstSeen = ts; story.firstSource = item.source; }
    const prev = story.sources.get(item.source);
    if (!prev) story.sources.set(item.source, { name: item.source, kind: item.kind, firstTs: ts, url: item.url, title: item.title, points: item.points || 0, comments: item.comments || 0 });
    else { prev.firstTs = Math.min(prev.firstTs, ts); prev.points = Math.max(prev.points, item.points || 0); prev.comments = Math.max(prev.comments, item.comments || 0); if (item.points > 0) prev.url = item.permalink || prev.url; }
    if (item.region) story.regions.add(item.region);
    if (!story.items.some(i => i.url === item.url)) { story.items.push({ source: item.source, title: item.title, url: item.url, ts }); if (story.items.length > 60) story.items.shift(); }
    for (const t of toks) story.tokenCounts.set(t, (story.tokenCounts.get(t) || 0) + 1);
    story.tokens = new Set([...story.tokenCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([t]) => t));
    for (const e of entities(item.title)) story.entities.set(e, (story.entities.get(e) || 0) + 1);
    // headline: prefer a news outlet's wording over a reddit title, earliest wins
    if (story.headlineKind === 'reddit' && item.kind !== 'reddit') { story.headline = item.title; story.headlineKind = item.kind; }
  }

  prune() {
    const cut = this.now() - this.cfg.keepHours * 3600000;
    for (const [id, s] of this.stories) if (s.lastSeen < cut) { this.stories.delete(id); for (const i of s.items) this.urlToStory.delete(i.url); }
  }

  /** Score everything, update the per-day best-score log, return the scored list (unsorted). */
  rank() {
    const now = this.now(), day = dayKey(now);
    const log = this.dailyBest[day] ||= {};
    const out = [];
    for (const s of this.stories.values()) {
      const sc = scoreStory(s, now, this.cfg, this.wiki);
      const topTok = [...s.tokens];
      const rec = { story: s, ...sc, topics: topicsOf(s.tokens.size ? s.tokens : new Set(topTok)) };
      out.push(rec);
      if (sc.score > 0 && (!log[s.id] || sc.score > log[s.id].score)) log[s.id] = { score: sc.score, headline: s.headline, firstSeen: s.firstSeen };
    }
    for (const k of Object.keys(this.dailyBest)) if (k < dayKey(now - 14 * 86400000)) delete this.dailyBest[k];
    return out;
  }

  publicStory(rec, { full = false } = {}) {
    const s = rec.story, now = this.now();
    const srcs = [...s.sources.values()].sort((a, b) => a.firstTs - b.firstTs);
    const best = srcs.find(x => x.kind !== 'reddit') || srcs[0];
    const o = {
      id: s.id, headline: s.headline, url: best ? best.url : null,
      score: rec.score, breakingScore: rec.breakingScore, parts: rec.parts,
      nSources: rec.nSources, newSources: rec.newSources, redditPoints: rec.redditPoints,
      firstSeen: s.firstSeen, lastSeen: s.lastSeen, ageMin: Math.round((now - s.firstSeen) / 60000),
      firstSource: s.firstSource, topics: rec.topics, regions: [...s.regions],
      entities: [...s.entities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e),
      sources: srcs.slice(0, 12).map(x => ({ name: x.name, kind: x.kind, url: x.url, title: x.title, ts: x.firstTs, points: x.points || undefined })),
    };
    if (full) o.items = s.items;
    return o;
  }

  filtered(recs, { topic, region, q, hours }) {
    const now = this.now();
    const qt = q ? tokens(q) : null;
    return recs.filter(r => {
      if (hours && now - r.story.lastSeen > hours * 3600000) return false;
      if (topic && !r.topics.includes(topic)) return false;
      if (region && !r.story.regions.has(region)) return false;
      if (qt && qt.size) { let hit = 0; for (const t of qt) if (r.story.tokens.has(t) || [...r.story.entities.keys()].some(e => e.toLowerCase().includes(t))) hit++; if (hit < Math.min(qt.size, 2) ) return false; }
      return true;
    });
  }

  top({ limit = 50, hours = 24, topic, region, q } = {}) {
    return this.filtered(this.rank(), { topic, region, q, hours }).sort((a, b) => b.score - a.score).slice(0, limit).map(r => this.publicStory(r));
  }
  breaking({ limit = 30, topic, region } = {}) {
    const cut = this.now() - this.cfg.breakingWindowMin * 60000 * 3;
    return this.filtered(this.rank(), { topic, region }).filter(r => r.story.lastSeen >= cut && r.breakingScore > 0).sort((a, b) => b.breakingScore - a.breakingScore).slice(0, limit).map(r => this.publicStory(r));
  }
  /** "Top stories of the day": best score each story reached on that UTC date. */
  daily(date = dayKey(this.now()), limit = 10) {
    const recs = new Map(this.rank().map(r => [r.story.id, r]));
    const log = this.dailyBest[date] || {};
    return Object.entries(log).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.score - a.score).slice(0, limit).map(v => {
      const s = this.stories.get(v.id);
      if (!s) return { id: v.id, headline: v.headline, bestScore: v.score, gone: true };
      return { ...this.publicStory(recs.get(v.id)), bestScore: v.score };
    });
  }
  get(id) { const s = this.stories.get(id); if (!s) return null; return this.publicStory({ story: s, ...scoreStory(s, this.now(), this.cfg, this.wiki), topics: topicsOf(s.tokens) }, { full: true }); }

  keywords(limit = 40) {
    const agg = new Map();
    for (const r of this.rank()) for (const e of r.story.entities.keys()) { const k = e.toLowerCase(); const a = agg.get(k) || { term: e, score: 0, stories: 0 }; a.score += r.score; a.stories++; agg.set(k, a); }
    return [...agg.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(a => ({ term: a.term, score: +a.score.toFixed(1), stories: a.stories }));
  }

  // ---- persistence ----
  save(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const data = { v: 1, savedAt: this.now(), dailyBest: this.dailyBest, stories: [...this.stories.values()].map(s => ({ ...s, tokens: [...s.tokens], tokenCounts: [...s.tokenCounts], entities: [...s.entities], sources: [...s.sources], regions: [...s.regions] })) };
      const f = path.join(dir, 'stories.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify(data)); fs.renameSync(f + '.tmp', f);
    } catch { /* disk problems must never crash the service */ }
  }
  load(dir) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'stories.json'), 'utf8'));
      this.dailyBest = d.dailyBest || {};
      for (const s of d.stories || []) {
        const st = { ...s, tokens: new Set(s.tokens), tokenCounts: new Map(s.tokenCounts), entities: new Map(s.entities), sources: new Map(s.sources), regions: new Set(s.regions) };
        this.stories.set(st.id, st); for (const i of st.items) this.urlToStory.set(i.url, st.id);
      }
      this.prune();
      return this.stories.size;
    } catch { return 0; }
  }
}
