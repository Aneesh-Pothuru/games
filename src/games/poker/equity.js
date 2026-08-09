/**
 * Equity: how often this hand wins, against a random hand or against a range.
 *
 * Two strategies, chosen by how much work the spot actually needs:
 *
 *   EXACT enumeration when the count is small enough to finish in a few
 *   milliseconds — on the river there is no runout at all, so it is just the
 *   villain's combos; on the turn it is combos x 44 rivers.
 *
 *   MONTE CARLO otherwise. Measured on this evaluator at ~1.75M evals/sec,
 *   5000 samples costs about 10ms, which is the budget one decision gets.
 *
 * Sampling error is reported honestly rather than hidden: the standard error
 * of a proportion is sqrt(p(1-p)/n), so 5000 samples is worth about +/-1.4
 * points at 95% confidence. A coach that prints 66.53% from 500 samples is
 * making up the last two digits.
 *
 * The sampler is SEEDED from the cards, so the same spot always returns the
 * same number. Advice that flickers between 61% and 63% while you think reads
 * as broken, and it teaches you to distrust it.
 */

import { makeRng } from '../../shared/rng.js';
import { CATEGORY, categoryOf, evaluate, freshDeck, rankOf, suitOf } from './cards.js';
import { rangeCombos } from './notation.js';

/** Cheap deterministic seed so a given spot always evaluates the same way. */
function seedFrom(cards) {
  let h = 2166136261;
  for (const c of cards) {
    h ^= c + 1;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const EXACT_EVAL_BUDGET = 60_000;

/**
 * Hero's equity against one opponent whose hand is drawn from `range`.
 *
 * @param hero  [card, card]
 * @param board 0, 3, 4 or 5 cards
 * @param range Set of hand classes, or null for a uniformly random hand
 * @param opts  { samples }
 * @returns { equity, win, tie, lose, samples, exact, stdErr, combos }
 */
export function equityVsRange(hero, board = [], range = null, opts = {}) {
  const dead = [...hero, ...board];
  const deck = freshDeck().filter((c) => !dead.includes(c));

  // The villain's possible holdings, already stripped of anything we can see.
  const villainCombos = range
    ? rangeCombos(range, dead)
    : allPairsFrom(deck);
  if (!villainCombos.length) {
    return { equity: 0.5, win: 0, tie: 0, lose: 0, samples: 0, exact: true, stdErr: 0, combos: 0 };
  }

  const need = 5 - board.length;
  const runouts = countRunouts(deck.length - 2, need);
  const exactCost = villainCombos.length * runouts;

  if (exactCost <= EXACT_EVAL_BUDGET) {
    return enumerate(hero, board, villainCombos, deck, need);
  }
  const samples = opts.samples ?? 5000;
  return sample(hero, board, villainCombos, deck, need, samples);
}

export const equityVsRandom = (hero, board = [], opts = {}) =>
  equityVsRange(hero, board, null, opts);

function allPairsFrom(deck) {
  const out = [];
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) out.push([deck[i], deck[j]]);
  }
  return out;
}

/** C(n, k) for the small k we ever need. */
function countRunouts(n, k) {
  if (k <= 0) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

// --------------------------------------------------------------- exhaustive --

function enumerate(hero, board, villainCombos, deck, need) {
  let win = 0;
  let tie = 0;
  let total = 0;

  for (const villain of villainCombos) {
    const left = deck.filter((c) => c !== villain[0] && c !== villain[1]);
    forEachRunout(left, need, (runout) => {
      const full = [...board, ...runout];
      const h = evaluate([...hero, ...full]);
      const v = evaluate([...villain, ...full]);
      if (h > v) win++;
      else if (h === v) tie++;
      total++;
    });
  }

  const equity = total ? (win + tie / 2) / total : 0.5;
  return {
    equity, win, tie, lose: total - win - tie, samples: total,
    exact: true, stdErr: 0, combos: villainCombos.length,
  };
}

/** Every k-subset of `deck`, without allocating the whole list. */
function forEachRunout(deck, k, fn) {
  if (k === 0) return fn([]);
  const idx = new Array(k).fill(0).map((_, i) => i);
  const n = deck.length;
  const pick = new Array(k);
  for (;;) {
    for (let i = 0; i < k; i++) pick[i] = deck[idx[i]];
    fn(pick);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// -------------------------------------------------------------- monte carlo --

function sample(hero, board, villainCombos, deck, need, samples) {
  const rng = makeRng(seedFrom([...hero, ...board, villainCombos.length, samples]));
  let win = 0;
  let tie = 0;

  const pool = deck.slice();
  for (let i = 0; i < samples; i++) {
    const villain = villainCombos[Math.floor(rng() * villainCombos.length)];
    // Partial Fisher-Yates over a scratch copy: only shuffle what we draw.
    const d = pool.filter((c) => c !== villain[0] && c !== villain[1]);
    for (let k = 0; k < need; k++) {
      const j = k + Math.floor(rng() * (d.length - k));
      const t = d[k];
      d[k] = d[j];
      d[j] = t;
    }
    const full = [...board, ...d.slice(0, need)];
    const h = evaluate([...hero, ...full]);
    const v = evaluate([...villain, ...full]);
    if (h > v) win++;
    else if (h === v) tie++;
  }

  const equity = (win + tie / 2) / samples;
  return {
    equity, win, tie, lose: samples - win - tie, samples,
    exact: false,
    // 95% half-width, which is what "+/-" should always mean.
    stdErr: 1.96 * Math.sqrt(Math.max(equity * (1 - equity), 0.0001) / samples),
    combos: villainCombos.length,
  };
}

// --------------------------------------------------------------------- outs --

const DRAW = {
  FLUSH: 'flush draw',
  OESD: 'open-ended straight draw',
  GUTSHOT: 'gutshot',
  BACKDOOR_FLUSH: 'backdoor flush draw',
  OVERCARDS: 'two overcards',
  PAIR_TO_TRIPS: 'set draw',
  TWO_PAIR_TO_BOAT: 'full house draw',
};

/**
 * Exact outs, counted rather than guessed.
 *
 * An out is a card that raises your hand's CATEGORY — high card to pair, pair
 * to trips, anything to a flush or a straight. That is the definition every
 * poker text uses, and it is the only one that gives the familiar numbers:
 * nine to a flush, eight to an open-ender, four to a gutshot, six for two
 * overcards.
 *
 * Not "any card that improves my five-card score". Adding a sixth card to a
 * five-card hand almost always improves the best five — a better kicker
 * counts, a lower pair on the board counts — so that definition returns
 * essentially the whole deck. Measured before this was fixed: 47 outs for a
 * gutshot.
 *
 * Also classifies the draw, because "nine outs" is a number and "you have a
 * flush draw" is a plan.
 */
export function outsFor(hero, board) {
  if (board.length < 3 || board.length > 4) {
    return { outs: 0, cards: [], draws: [], street: board.length === 5 ? 'river' : 'preflop' };
  }
  const street = board.length === 3 ? 'flop' : 'turn';
  const dead = [...hero, ...board];
  const deck = freshDeck().filter((c) => !dead.includes(c));
  const current = categoryOf(evaluate([...hero, ...board]));

  const heroRanks = new Set(hero.map(rankOf));
  const boardRanks = new Set(board.map(rankOf));

  const cards = [];
  const strong = [];
  for (const c of deck) {
    const after = categoryOf(evaluate([...hero, ...board, c]));
    if (after <= current) continue;
    // A card that only pairs the BOARD lifts everyone's category by the same
    // amount and improves nothing about your hand relative to theirs. Without
    // this, a flush draw counts 23 outs instead of 15.
    //
    // Only for pair-level improvements, though: the deuce of hearts pairs the
    // board AND completes your flush, and it is very much an out. Dropping it
    // is why the flush draw came to 14.
    const onlyPairs = after <= CATEGORY.TWO_PAIR;
    if (onlyPairs && boardRanks.has(rankOf(c)) && !heroRanks.has(rankOf(c))) continue;
    cards.push(c);
    // Cards that make a hand rather than a pair — the ones you are actually
    // drawing to, and the count a coach should quote for a draw.
    if (after >= CATEGORY.TRIPS) strong.push(c);
  }

  return {
    outs: cards.length,
    strongOuts: strong.length,
    cards,
    draws: classifyDraws(hero, board),
    street,
  };
}

function classifyDraws(hero, board) {
  const all = [...hero, ...board];
  const draws = [];

  const suits = [0, 0, 0, 0];
  for (const c of all) suits[suitOf(c)]++;
  const heroSuits = hero.map(suitOf);
  for (let s = 0; s < 4; s++) {
    if (suits[s] === 4 && heroSuits.includes(s)) draws.push(DRAW.FLUSH);
    else if (suits[s] === 3 && heroSuits.includes(s) && board.length === 3) {
      draws.push(DRAW.BACKDOOR_FLUSH);
    }
  }

  const straight = straightDrawType(all);
  if (straight) draws.push(straight);

  const ranks = all.map(rankOf);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const heroRanks = hero.map(rankOf);
  const boardRanks = board.map(rankOf);

  if (heroRanks[0] === heroRanks[1] && !boardRanks.includes(heroRanks[0])) {
    draws.push(DRAW.PAIR_TO_TRIPS);
  }
  const pairs = [...counts.values()].filter((n) => n === 2).length;
  if (pairs >= 2) draws.push(DRAW.TWO_PAIR_TO_BOAT);

  const topBoard = Math.max(...boardRanks);
  if (heroRanks[0] > topBoard && heroRanks[1] > topBoard && heroRanks[0] !== heroRanks[1]) {
    draws.push(DRAW.OVERCARDS);
  }
  return draws;
}

/**
 * Open-ended vs gutshot, decided by how many distinct cards complete it —
 * eight versus four. Counting the ranks rather than eyeballing the gap is what
 * gets the wheel and the double-gutshot right.
 */
function straightDrawType(cards) {
  const present = new Set(cards.map(rankOf));
  let completing = 0;
  for (let r = 0; r < 13; r++) {
    if (present.has(r)) continue;
    const withCard = new Set([...present, r]);
    if (hasStraight(withCard)) completing++;
  }
  if (hasStraight(present)) return null;
  if (completing >= 2) return DRAW.OESD;
  if (completing === 1) return DRAW.GUTSHOT;
  return null;
}

function hasStraight(rankSet) {
  // Ace low: rank 12 also plays below the deuce.
  const bits = [...rankSet].reduce((m, r) => m | (1 << r), 0) | (rankSet.has(12) ? 1 << -1 >>> 32 : 0);
  for (let high = 12; high >= 4; high--) {
    const mask = 0b11111 << (high - 4);
    if ((bits & mask) === mask) return true;
  }
  const wheel = (1 << 12) | 0b1111;
  return (bits & wheel) === wheel;
}

export { DRAW };
