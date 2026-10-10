// Virality scoring. Pure functions.
//
//   reach     how many DIFFERENT outlets/communities carry the story        (log scale, saturates at 12)
//   velocity  how many of those joined in the last VELOCITY_WINDOW minutes  (saturates at 5)
//   social    Reddit (points + 2*comments) per minute of the hottest post   (log scale, saturates at 60/min)
//   wiki      the story's entity is in Wikipedia's most-viewed list         (weak, daily data)
//
//   score          = 100 * (0.40 reach + 0.30 velocity + 0.22 social + 0.08 wiki) * 0.5^(hoursSinceLastSeen / TOP_HALF_LIFE_H)
//   breakingScore  = 100 * (0.55 velocity + 0.25 social + 0.20 reach) * 0.5^(minutesSinceLastSeen / 45)
const clamp01 = (x) => Math.max(0, Math.min(1, x));

export function features(story, now, cfg, wikiTitles = new Map()) {
  const velCut = now - cfg.velocityWindowMin * 60000;
  let newSrc = 0, redditVel = 0, redditPts = 0;
  for (const s of story.sources.values()) {
    if (s.firstTs >= velCut) newSrc++;
    if (s.kind === 'reddit') {
      redditPts += s.points || 0;
      const ageMin = Math.max(15, (now - s.firstTs) / 60000);
      redditVel = Math.max(redditVel, ((s.points || 0) + 2 * (s.comments || 0)) / ageMin);
    }
  }
  let wiki = 0;
  for (const e of story.entities.keys()) {
    const hit = wikiTitles.get(e.toLowerCase());
    if (hit) wiki = Math.max(wiki, clamp01(1 - (hit.rank - 1) / 100));
  }
  const n = story.sources.size;
  return {
    nSources: n, newSrc, redditPts, redditVel,
    reach: clamp01(Math.log1p(n) / Math.log1p(12)),
    velocity: clamp01(newSrc / 5),
    social: clamp01(Math.log1p(redditVel) / Math.log1p(60)),
    wiki,
  };
}

export function scoreStory(story, now, cfg, wikiTitles) {
  const f = features(story, now, cfg, wikiTitles);
  const ageH = Math.max(0, (now - story.lastSeen) / 3600000);
  const decayTop = Math.pow(0.5, ageH / cfg.topHalfLifeH);
  const decayBrk = Math.pow(0.5, (ageH * 60) / 45);
  const score = Math.round(100 * (0.40 * f.reach + 0.30 * f.velocity + 0.22 * f.social + 0.08 * f.wiki) * decayTop * 10) / 10;
  const breakingScore = Math.round(100 * (0.55 * f.velocity + 0.25 * f.social + 0.20 * f.reach) * decayBrk * 10) / 10;
  return { score, breakingScore, parts: { reach: +f.reach.toFixed(3), velocity: +f.velocity.toFixed(3), social: +f.social.toFixed(3), wiki: +f.wiki.toFixed(3) }, nSources: f.nSources, newSources: f.newSrc, redditPoints: f.redditPts };
}

const TOPICS = {
  conflict: 'war missile strike attack ceasefire troop military bomb drone invasion hostage airstrike army shelling militant rebel',
  politics: 'election president minister parliament vote senate congress government protest policy law court trial ruling tariff sanction summit',
  business: 'stock market economy inflation bank earnings shares rate fed trade company ceo merger layoff bankruptcy oil price',
  tech: 'ai openai google apple microsoft chip robot app software hack cyber startup tesla spacex meta amazon nvidia',
  crypto: 'bitcoin crypto token memecoin solana ethereum blockchain coinbase binance etf stablecoin',
  sports: 'football soccer nba nfl mlb nhl tennis golf olympic cup league match goal champion tournament coach',
  entertainment: 'movie film singer album celebrity actor actress concert netflix tv show award star viral meme tiktok',
  science: 'nasa space study researcher scientist planet mars moon climate species fossil discovery telescope',
  disaster: 'earthquake hurricane flood fire storm wildfire tsunami volcano typhoon cyclone landslide crash collapse',
  crime: 'police arrest murder shooting suspect killed court charged prison fraud trafficking stabbing',
  health: 'virus outbreak vaccine hospital cancer disease health doctor drug fda who pandemic',
  gaming: 'game gaming playstation xbox nintendo steam esports streamer fortnite minecraft gta roblox console',
  meme: 'meme funny lol viral trend challenge prank hilarious cursed relatable',
  animals: 'tiger lion dog cat zoo monkey panda elephant shark whale bear wolf bird snake horse raccoon animal',
};
const TOPIC_SETS = Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, new Set(v.split(' '))]));
export function topicsOf(tokenSet) {
  const out = [];
  for (const [k, set] of Object.entries(TOPIC_SETS)) { for (const t of tokenSet) if (set.has(t)) { out.push(k); break; } }
  return out;
}
