// server.js — JSON API + Server-Sent Events. Read-only, CORS open (it only serves public news metadata).
import http from 'node:http';
import { matchCoin } from './match.js';

export function createServer({ engine, collector, cfg, posts = null, startedAt = Date.now() }) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const sse = new Set();
  const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  const handler = (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'content-type' }); return res.end(); }
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    const u = new URL(req.url, 'http://x'), q = u.searchParams, p = u.pathname;
    const common = { topic: q.get('topic') || undefined, region: q.get('region') || undefined };

    if (p === '/api/health') return json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), stories: engine.stories.size, items: engine.itemCount, sourcesOk: Object.values(collector.status).filter(s => s.ok).length, sourcesTotal: Object.keys(collector.status).length });
    if (p === '/api/sources') return json(res, 200, collector.status);
    if (p === '/api/top') return json(res, 200, { ts: Date.now(), stories: engine.top({ limit: int(q.get('limit'), 50, 1, 200), hours: int(q.get('hours'), 24, 1, 72), q: q.get('q') || undefined, ...common }) });
    if (p === '/api/breaking') return json(res, 200, { ts: Date.now(), stories: engine.breaking({ limit: int(q.get('limit'), 30, 1, 100), ...common }) });
    if (p === '/api/daily') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : undefined;
      return json(res, 200, { date: date || new Date().toISOString().slice(0, 10), stories: engine.daily(date, int(q.get('limit'), 10, 1, 50)) });
    }
    if (p.startsWith('/api/story/')) { const s = engine.get(decodeURIComponent(p.slice(11))); return s ? json(res, 200, s) : json(res, 404, { error: 'story not found (it may have aged out)' }); }
    if (p === '/api/posts') {
      if (!posts) return json(res, 200, { window: 'day', posts: [] });
      const window = ['day', 'week', 'month', 'all'].includes(q.get('window')) ? q.get('window') : 'day';
      return json(res, 200, { ts: Date.now(), window, posts: posts.rank({ window, platform: q.get('platform') || undefined, category: q.get('category') || undefined, community: q.get('community') || undefined, q: q.get('q') || undefined, limit: int(q.get('limit'), 50, 1, 200) }) });
    }
    if (p === '/api/posts/meta') return json(res, 200, posts ? { platforms: posts.summary(), categories: posts.categories(), windows: ['day', 'week', 'month', 'all'] } : { platforms: {}, categories: [], windows: [] });
    if (p === '/api/trends') return json(res, 200, { ts: Date.now(), trends: collector.trends || {} });
    if (p === '/api/keywords') return json(res, 200, { ts: Date.now(), keywords: engine.keywords(int(q.get('limit'), 40, 1, 200)) });
    if (p === '/api/match') {
      const name = q.get('name') || '', symbol = q.get('symbol') || '';
      if (!name && !symbol) return json(res, 400, { error: 'name or symbol required' });
      return json(res, 200, { name, symbol, matches: matchCoin({ name, symbol }, engine.rank(), engine) });
    }
    if (p === '/api/stream') {
      if (sse.size >= cfg.maxConnections) return json(res, 503, { error: 'too many streams' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(': connected\n\n'); sse.add(res); req.on('close', () => sse.delete(res));
      send(res);
      return;
    }
    return json(res, 404, { routes: ['/api/health', '/api/sources', '/api/top', '/api/breaking', '/api/daily', '/api/story/:id', '/api/posts', '/api/posts/meta', '/api/trends', '/api/keywords', '/api/match', '/api/stream'] });
  };

  const send = (res) => { try { res.write(`event: breaking\ndata: ${JSON.stringify({ ts: Date.now(), stories: engine.breaking({ limit: 15 }) })}\n\n`); } catch { sse.delete(res); } };
  const timer = setInterval(() => { for (const r of sse) send(r); }, 15000);
  timer.unref();
  return { handler, close: () => { clearInterval(timer); for (const r of sse) r.end(); sse.clear(); }, sseCount: () => sse.size };
}
