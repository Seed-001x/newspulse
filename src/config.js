// All tunables in one place. Everything can be overridden by env vars (no code change needed).
const num = (e, k, d) => { const v = Number(e[k]); return Number.isFinite(v) && e[k] !== '' && e[k] != null ? v : d; };

// Region tags: world | us | uk | europe | mideast | asia | oceania | business | entertainment | viral
// NONE of these URLs could be verified from the build sandbox (outbound web was blocked). /api/sources shows live health per source.
export const DEFAULT_FEEDS = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', region: 'uk' },
  { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss', region: 'uk' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', region: 'mideast' },
  { name: 'NYT World', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', region: 'us' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', region: 'us' },
  { name: 'CBS World', url: 'https://www.cbsnews.com/latest/rss/world', region: 'us' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all', region: 'europe' },
  { name: 'France 24', url: 'https://www.france24.com/en/rss', region: 'europe' },
  { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/world.xml', region: 'uk' },
  { name: 'ABC Australia', url: 'https://www.abc.net.au/news/feed/51120/rss.xml', region: 'oceania' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', region: 'business' },
  { name: 'Google News', url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', region: 'world' },
  { name: 'TMZ', url: 'https://www.tmz.com/rss.xml', region: 'entertainment' },
];

export function loadConfig(env = process.env) {
  let feeds = DEFAULT_FEEDS;
  if (env.FEEDS) { try { const f = JSON.parse(env.FEEDS); if (Array.isArray(f)) feeds = f; } catch { /* keep defaults */ } }
  return {
    port: num(env, 'PORT', 8790),
    dataDir: env.DATA_DIR || './data',
    feeds,
    feedPollSec: num(env, 'FEED_POLL_SEC', 60),
    gdeltEnabled: env.GDELT !== '0',
    gdeltPollSec: num(env, 'GDELT_POLL_SEC', 120),       // GDELT asks for <= 1 request / 5 s
    redditEnabled: env.REDDIT !== '0',
    redditSubs: (env.REDDIT_SUBS || 'worldnews,news,nottheonion,interestingasfuck,popculturechat').split(',').map(s => s.trim()).filter(Boolean),
    redditPollSec: num(env, 'REDDIT_POLL_SEC', 90),
    wikiEnabled: env.WIKI !== '0',
    // ---- viral POSTS (separate from news stories) ----
    postsEnabled: env.POSTS !== '0',
    postSubs: (env.POST_SUBS || 'all,popular,memes,funny,aww,gaming,worldnews,news,technology,sports,movies,interestingasfuck,nextfuckinglevel,science,cryptocurrency,wallstreetbets,popculturechat,nottheonion,pics,videos').split(',').map(x => x.trim()).filter(Boolean),
    postPollSec: num(env, 'POST_POLL_SEC', 600),            // reddit top?t=day for every sub, one request every ~3 s
    mastodonInstances: (env.MASTODON_INSTANCES || 'mastodon.social').split(',').map(x => x.trim()).filter(Boolean),
    bskyFeeds: (env.BSKY_FEEDS || 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot').split(',').map(x => x.trim()).filter(Boolean),
    youtubeKey: env.YOUTUBE_API_KEY || '',                  // optional (free key from Google Cloud); enables YouTube "most popular"
    xBearer: env.X_BEARER_TOKEN || '',                      // optional (paid X API); enables X trending topics
    trendsGeo: env.TRENDS_GEO || 'US',
    postKeepDays: num(env, 'POST_KEEP_DAYS', 30),
    postMax: num(env, 'POST_MAX', 6000),
    userAgent: env.USER_AGENT || 'newspulse/1.0 (news aggregator; contact: set USER_AGENT env)',
    // clustering
    simJaccard: num(env, 'SIM_JACCARD', 0.4),
    simOverlap: num(env, 'SIM_OVERLAP', 0.6),
    simMinShared: num(env, 'SIM_MIN_SHARED', 3),
    keepHours: num(env, 'KEEP_HOURS', 72),
    maxItemAgeHours: num(env, 'MAX_ITEM_AGE_HOURS', 36),   // ignore feed entries older than this
    // scoring
    topHalfLifeH: num(env, 'TOP_HALF_LIFE_H', 12),
    breakingWindowMin: num(env, 'BREAKING_WINDOW_MIN', 60),
    velocityWindowMin: num(env, 'VELOCITY_WINDOW_MIN', 30),
    maxConnections: num(env, 'MAX_SSE', 100),
  };
}
