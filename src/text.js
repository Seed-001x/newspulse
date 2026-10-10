// Pure text helpers: tokens, simple entity extraction, similarity.
const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those he she they them his her their '
  + 'we you i not no yes new says say said after before over under into out up down off about against between during than then so too very can will would could should may might '
  + 'has have had do does did how why what when where who whom which more most less least also just now today live update updates report reports amid per vs via news video watch').split(/\s+/));

export const decode = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
export const stripTags = (s) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const stem = (w) => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
export function tokens(text) {
  const out = new Set();
  for (const raw of String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** Capitalised word runs ("Tschuna Tiger", "Donald Trump", "Bank of England"), skipping the very first word of a title when it is a plain word. */
export function entities(title) {
  const t = String(title || '');
  const out = new Map();
  const re = /\b([A-Z][\p{L}'’-]+(?:\s+(?:of|the|de|van|von|al|bin)\s+[A-Z][\p{L}'’-]+|\s+[A-Z][\p{L}'’-]+)*)/gu;
  let m;
  while ((m = re.exec(t))) {
    const e = m[1].trim();
    const first = m.index === 0 && !e.includes(' ');
    if (first || e.length < 3 || STOP.has(e.toLowerCase())) continue;
    out.set(e, (out.get(e) || 0) + 1);
  }
  return [...out.keys()];
}

export function similarity(a, b) {
  let shared = 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) shared++;
  const union = a.size + b.size - shared;
  return { shared, jaccard: union ? shared / union : 0, overlap: s.size ? shared / s.size : 0 };
}
