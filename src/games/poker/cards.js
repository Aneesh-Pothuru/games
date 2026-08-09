/**
 * Card primitives and a 7-card hand evaluator.
 *
 * Card encoding: an integer 0..51. rank = card >> 2 (0 = Two … 12 = Ace),
 * suit = card & 3 (0 clubs, 1 diamonds, 2 hearts, 3 spades).
 *
 * The evaluator returns a single comparable integer. Higher is better and
 * EQUAL MEANS A GENUINE TIE — suits never break ties for a pot, so equal
 * scores split. That property is what lets the pot code stay simple.
 */

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['c', 'd', 'h', 's'];

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;
export const cardName = (card) => `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`;

export function parseCard(text) {
  const r = RANKS.indexOf(text[0].toUpperCase());
  const s = SUITS.indexOf(text[1].toLowerCase());
  if (r < 0 || s < 0) throw new Error(`bad card: ${text}`);
  return r * 4 + s;
}

export function freshDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

export const CATEGORY = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, BOAT: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAME = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];

/**
 * Straight masks, highest first so A-K-Q-J-T is matched before the wheel.
 *
 * The wheel (A-2-3-4-5) is last and carries high = 3 (a Five), NOT 12. That
 * single value is why the wheel is the lowest straight and the steel wheel the
 * lowest straight flush.
 */
const STRAIGHT_MASKS = (() => {
  const masks = [];
  for (let high = 12; high >= 4; high--) masks.push({ mask: 0b11111 << (high - 4), high });
  masks.push({ mask: (1 << 12) | 0b1111, high: 3 });
  return masks;
})();

/** cat in the high bits, then five 4-bit kicker slots. Fits comfortably in int32. */
function score(cat, kickers) {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + (kickers[i] ?? 0);
  return s;
}

/** Evaluate the best five-card hand out of 5, 6 or 7 cards. */
export function evaluate(cards) {
  const rankCount = new Array(13).fill(0);
  const suitCount = new Array(4).fill(0);
  const suitMask = new Array(4).fill(0);
  let rankMask = 0;

  for (const c of cards) {
    const r = c >> 2;
    const s = c & 3;
    rankCount[r]++;
    suitCount[s]++;
    suitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // With 7 cards at most one suit can reach five, so this branch is
  // unambiguous — and a 7-card hand can never hold both a flush and quads or
  // a flush and a full house, so returning here cannot miss a better hand.
  const flushSuit = suitCount.findIndex((n) => n >= 5);
  if (flushSuit >= 0) {
    const fm = suitMask[flushSuit];
    for (const { mask, high } of STRAIGHT_MASKS) {
      if ((fm & mask) === mask) return score(CATEGORY.STRAIGHT_FLUSH, [high]);
    }
    const top = [];
    for (let r = 12; r >= 0 && top.length < 5; r--) if ((fm >> r) & 1) top.push(r);
    return score(CATEGORY.FLUSH, top);
  }

  let quad = -1;
  const trips = [];
  const pairs = [];
  for (let r = 12; r >= 0; r--) {
    if (rankCount[r] === 4) quad = r;
    else if (rankCount[r] === 3) trips.push(r);
    else if (rankCount[r] === 2) pairs.push(r);
  }

  if (quad >= 0) {
    let kicker = -1;
    for (let r = 12; r >= 0; r--) if (r !== quad && rankCount[r] > 0) { kicker = r; break; }
    return score(CATEGORY.QUADS, [quad, kicker]);
  }

  if (trips.length >= 1 && (trips.length >= 2 || pairs.length >= 1)) {
    const t = trips[0];
    // With two sets of trips the lower trips plays as the pair.
    const p = trips.length >= 2 ? Math.max(trips[1], pairs.length ? pairs[0] : -1) : pairs[0];
    return score(CATEGORY.BOAT, [t, p]);
  }

  for (const { mask, high } of STRAIGHT_MASKS) {
    if ((rankMask & mask) === mask) return score(CATEGORY.STRAIGHT, [high]);
  }

  if (trips.length === 1) {
    const t = trips[0];
    const k = [];
    for (let r = 12; r >= 0 && k.length < 2; r--) if (r !== t && rankCount[r] > 0) k.push(r);
    return score(CATEGORY.TRIPS, [t, ...k]);
  }

  if (pairs.length >= 2) {
    const [p1, p2] = pairs;
    let kicker = -1;
    // A third pair's higher card is a legitimate kicker candidate.
    for (let r = 12; r >= 0; r--) if (r !== p1 && r !== p2 && rankCount[r] > 0) { kicker = r; break; }
    return score(CATEGORY.TWO_PAIR, [p1, p2, kicker]);
  }

  if (pairs.length === 1) {
    const p = pairs[0];
    const k = [];
    for (let r = 12; r >= 0 && k.length < 3; r--) if (r !== p && rankCount[r] > 0) k.push(r);
    return score(CATEGORY.PAIR, [p, ...k]);
  }

  const k = [];
  for (let r = 12; r >= 0 && k.length < 5; r--) if (rankCount[r] > 0) k.push(r);
  return score(CATEGORY.HIGH, k);
}

export const categoryOf = (s) => Math.floor(s / 16 ** 5);

/**
 * Hand names are read aloud at the table, so they use words, not the symbols
 * printed on the cards — "Pair of Aces", never "Pair of As".
 */
const RANK_WORD = [
  'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace',
];
const RANK_PLURAL = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

/** Human-readable hand name, e.g. "Flush, Ace high". */
export function describe(cards) {
  const s = evaluate(cards);
  const cat = categoryOf(s);
  const top = Math.floor(s / 16 ** 4) % 16;
  const second = Math.floor(s / 16 ** 3) % 16;
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return top === 12 ? 'Royal flush' : `Straight flush, ${RANK_WORD[top]} high`;
    case CATEGORY.QUADS: return `Four ${RANK_PLURAL[top]}`;
    case CATEGORY.BOAT: return `Full house, ${RANK_PLURAL[top]} over ${RANK_PLURAL[second]}`;
    case CATEGORY.FLUSH: return `Flush, ${RANK_WORD[top]} high`;
    case CATEGORY.STRAIGHT: return `Straight, ${RANK_WORD[top]} high`;
    case CATEGORY.TRIPS: return `Three ${RANK_PLURAL[top]}`;
    case CATEGORY.TWO_PAIR: return `Two pair, ${RANK_PLURAL[top]} and ${RANK_PLURAL[second]}`;
    case CATEGORY.PAIR: return `Pair of ${RANK_PLURAL[top]}`;
    default: return `${RANK_WORD[top]} high`;
  }
}

/** The exact five cards that make the hand, for highlighting at showdown. */
export function bestFive(cards) {
  if (cards.length <= 5) return cards.slice();
  let best = -1;
  let pick = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = evaluate(combo);
            if (s > best) { best = s; pick = combo; }
          }
  return pick;
}
