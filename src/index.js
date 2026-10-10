import http from 'node:http';
import { loadConfig } from './config.js';
import { Engine } from './engine.js';
import { Collector } from './collector.js';
import { createServer } from './server.js';
import { PostStore } from './posts.js';

const cfg = loadConfig();
const engine = new Engine(cfg);
const loaded = engine.load(cfg.dataDir);
const posts = new PostStore(cfg);
posts.load(cfg.dataDir);
const collector = new Collector(engine, cfg, { posts });
const app = createServer({ engine, collector, cfg, posts });
http.createServer(app.handler).listen(cfg.port, () => console.log(`newspulse on :${cfg.port} (restored ${loaded} stories, ${cfg.feeds.length} feeds)`));
collector.start();
setInterval(() => { engine.prune(); engine.rank(); engine.save(cfg.dataDir); posts.prune(); posts.save(cfg.dataDir); }, 60000).unref?.();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { engine.save(cfg.dataDir); posts.save(cfg.dataDir); process.exit(0); });
