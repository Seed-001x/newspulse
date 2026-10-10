// Coin <-> story matching. A pump.fun coin's name/symbol vs the stories currently trending.
import { tokens } from './text.js';
const GENERIC = new Set('coin token inu doge pepe wif cash finance swap dao protocol official the'.split(' '));

/** Returns up to 3 stories sharing the coin's significant words. confidence = matched/significant words, scaled by story score. */
export function matchCoin({ name = '', symbol = '' }, recs, engine) {
  const sig = new Set([...tokens(name), ...tokens(symbol)].filter(t => !GENERIC.has(t)));
  if (!sig.size) return [];
  const out = [];
  for (const r of recs) {
    const pool = new Set(r.story.tokens);
    for (const e of r.story.entities.keys()) for (const t of tokens(e)) pool.add(t);
    let hit = 0; const words = [];
    for (const t of sig) if (pool.has(t)) { hit++; words.push(t); }
    if (!hit) continue;
    const frac = hit / sig.size;
    if (frac < 0.5) continue;
    out.push({ confidence: +(frac * Math.min(1, r.score / 40)).toFixed(3), matchedWords: words, coinWords: sig.size, story: engine.publicStory(r) });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}
