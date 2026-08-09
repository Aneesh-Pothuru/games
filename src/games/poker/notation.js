/**
 * Hand-class notation, and the bridge from it to actual cards.
 *
 * There are 1326 distinct two-card hands but only 169 strategically distinct
 * ones, because suits are interchangeable before a board exists: 13 pairs,
 * 78 suited, 78 offsuit. Every published range chart is written in those 169
 * classes, so that is what ranges are stored as — and it is why a range costs
 * a few hundred bytes rather than a few hundred kilobytes.
 *
 * The two directions both matter:
 *   - parseRange('77+, ATs+, AJo+')  ->  the set of classes, for charts
 *   - combosOf('AKs')                ->  the 4 real card pairs, for equity,
 *                                        because blockers only exist at the
 *                                        card level
 *
 * Combination counts, which are the whole reason blockers work:
 *   pair     6 combos   (C(4,2))
 *   suited   4 combos   (one per suit)
 *   offsuit 12 combos   (4 x 3)
 *   total    13*6 + 78*4 + 78*12 = 78 + 312 + 936 = 1326
 */

import { RANKS } from './cards.js';

/** Aces first, which is how every chart in the world is written. */
export const RANK_ORDER = 'AKQJT98765432';

/** 0 = deuce … 12 = ace. Matches cards.js. */
const rankIndex = (ch) => RANKS.indexOf(ch === 'T' ? 'T' : ch);

export function isPair(cls) {
  return cls.length === 2 && cls[0] === cls[1];
}
export const isSuited = (cls) => cls.endsWith('s');

/** Canonical class name for two cards, e.g. [Ah, Ks] -> 'AKo'. */
export function classOf(a, b) {
  const ra = a >> 2;
  const rb = b >> 2;
  const hi = RANKS[Math.max(ra, rb)];
  const lo = RANKS[Math.min(ra, rb)];
  if (ra === rb) return hi + lo;
  return hi + lo + ((a & 3) === (b & 3) ? 's' : 'o');
}

/** All 169 classes, strongest-looking first (pairs, then suited, then offsuit). */
export const ALL_CLASSES = (() => {
  const out = [];
  for (const r of RANK_ORDER) out.push(r + r);
  for (let i = 0; i < 13; i++) {
    for (let j = i + 1; j < 13; j++) out.push(RANK_ORDER[i] + RANK_ORDER[j] + 's');
  }
  for (let i = 0; i < 13; i++) {
    for (let j = i + 1; j < 13; j++) out.push(RANK_ORDER[i] + RANK_ORDER[j] + 'o');
  }
  return out;
})();

export const COMBO_COUNT = (cls) => (isPair(cls) ? 6 : isSuited(cls) ? 4 : 12);

/** The concrete card pairs in a class. This is where blockers become real. */
export function combosOf(cls) {
  const out = [];
  const hi = rankIndex(cls[0]);
  const lo = rankIndex(cls[1]);
  if (isPair(cls)) {
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([hi * 4 + s1, hi * 4 + s2]);
    }
  } else if (isSuited(cls)) {
    for (let s = 0; s < 4; s++) out.push([hi * 4 + s, lo * 4 + s]);
  } else {
    for (let s1 = 0; s1 < 4; s1++) {
      for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([hi * 4 + s1, lo * 4 + s2]);
    }
  }
  return out;
}

// ------------------------------------------------------------------- parse --

/**
 * A range in the notation every chart uses.
 *
 * Supported forms, which between them cover every published chart:
 *   AA          one class
 *   77+         77 through AA
 *   A9s+        A9s A T s… up to AKs (the KICKER climbs, not the pair)
 *   AJo+        AJo AQo AKo
 *   T9s-76s     a run of connectors down the diagonal
 *   99-66       a run of pairs
 *   A5s-A2s     a run of one-gappers along a row
 *   AXs         every ace-x suited
 *
 * Anything unrecognised is ignored rather than thrown, because a range string
 * is content, not code — one typo in a chart must not take a game down.
 */
export function parseRange(text) {
  const set = new Set();
  for (const rawPart of String(text ?? '').split(',')) {
    const part = rawPart.trim().replace(/\s+/g, '');
    if (!part) continue;
    if (part.includes('-')) addRun(set, part);
    else if (part.endsWith('+')) addPlus(set, part.slice(0, -1));
    else addOne(set, part);
  }
  return set;
}

function valid(cls) {
  return ALL_CLASSES.includes(cls);
}

function addOne(set, token) {
  const cls = normalize(token);
  if (cls) {
    if (cls.endsWith('*')) {
      // AXs / KXo — the whole row.
      const base = cls.slice(0, 1);
      const suffix = cls.slice(-2, -1);
      for (const r of RANK_ORDER) {
        // AXs is the ace ROW, not the ace pair — without this, normalize()
        // sees 'AAs', takes its pair branch before it ever looks at the
        // suffix, and quietly folds AA into every A-x range.
        if (r === base) continue;
        const c = normalize(base + r + suffix);
        if (c && valid(c)) set.add(c);
      }
    } else if (valid(cls)) set.add(cls);
  }
}

/** Normalise 'aKs' -> 'AKs' and put the higher rank first. */
function normalize(token) {
  if (token.length < 2) return null;
  const a = token[0].toUpperCase();
  const b = token[1].toUpperCase();
  const suffix = token.length > 2 ? token[2].toLowerCase() : '';
  if (b === 'X') return `${a}X${suffix}*`;
  const ia = RANK_ORDER.indexOf(a);
  const ib = RANK_ORDER.indexOf(b);
  if (ia < 0 || ib < 0) return null;
  const hi = ia <= ib ? a : b;
  const lo = ia <= ib ? b : a;
  if (hi === lo) return hi + lo;
  if (suffix !== 's' && suffix !== 'o') return null;
  return hi + lo + suffix;
}

/**
 * The '+' means different things for pairs and non-pairs, and getting it
 * backwards is the classic chart-parsing bug: 77+ climbs the PAIRS, A9s+
 * climbs the KICKER and leaves the ace alone.
 */
function addPlus(set, token) {
  const cls = normalize(token);
  if (!cls) return;
  if (isPair(cls)) {
    const from = RANK_ORDER.indexOf(cls[0]);
    for (let i = from; i >= 0; i--) set.add(RANK_ORDER[i] + RANK_ORDER[i]);
    return;
  }
  const hi = RANK_ORDER.indexOf(cls[0]);
  const lo = RANK_ORDER.indexOf(cls[1]);
  const suffix = cls[2];
  for (let k = lo; k > hi; k--) {
    const c = RANK_ORDER[hi] + RANK_ORDER[k] + suffix;
    if (valid(c)) set.add(c);
  }
}

/** 'T9s-76s', '99-66', 'A5s-A2s'. Endpoints inclusive, either order. */
function addRun(set, token) {
  const [aRaw, bRaw] = token.split('-');
  const a = normalize(aRaw);
  const b = normalize(bRaw);
  if (!a || !b) return;

  if (isPair(a) && isPair(b)) {
    const i = RANK_ORDER.indexOf(a[0]);
    const j = RANK_ORDER.indexOf(b[0]);
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
      set.add(RANK_ORDER[k] + RANK_ORDER[k]);
    }
    return;
  }
  if (isPair(a) || isPair(b) || a[2] !== b[2]) return;

  const suffix = a[2];
  const hiA = RANK_ORDER.indexOf(a[0]);
  const loA = RANK_ORDER.indexOf(a[1]);
  const hiB = RANK_ORDER.indexOf(b[0]);
  const loB = RANK_ORDER.indexOf(b[1]);

  if (hiA === hiB) {
    // Same top card, kicker sliding: A5s-A2s.
    for (let k = Math.min(loA, loB); k <= Math.max(loA, loB); k++) {
      const c = RANK_ORDER[hiA] + RANK_ORDER[k] + suffix;
      if (valid(c)) set.add(c);
    }
    return;
  }
  if (loA - hiA !== loB - hiB) return; // not a constant-gap diagonal
  const step = hiA < hiB ? 1 : -1;
  for (let k = hiA; k !== hiB + step; k += step) {
    const c = RANK_ORDER[k] + RANK_ORDER[k + (loA - hiA)] + suffix;
    if (valid(c)) set.add(c);
  }
}

// ------------------------------------------------------------------ weight --

/** How many of the 1326 hands a range contains. */
export function comboCount(range) {
  let n = 0;
  for (const cls of range) n += COMBO_COUNT(cls);
  return n;
}

/** The share of all hands, which is what "a 22% range" means. */
export function rangePercent(range) {
  return (comboCount(range) / 1326) * 100;
}

/** Every concrete combo in a range, minus anything blocked by known cards. */
export function rangeCombos(range, dead = []) {
  const blocked = new Set(dead);
  const out = [];
  for (const cls of range) {
    for (const combo of combosOf(cls)) {
      if (!blocked.has(combo[0]) && !blocked.has(combo[1])) out.push(combo);
    }
  }
  return out;
}

/** Compact shorthand for a set of classes, for display. */
export function describeRange(range) {
  return ALL_CLASSES.filter((c) => range.has(c)).join(', ');
}
