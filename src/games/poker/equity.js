/**
 * Equity: how often this hand wins, against a random hand or against a range.
 *
 * Two strategies, chosen by how much work the spot actually needs:
 *
 *   EXACT enumeration whenever the whole tree fits in the budget. On the river
 *   there is no runout at all, so it is just the villain's combos; on the turn
 *   it is combos x 44 rivers; on the flop, combos x 990. All three fit, so
 *   every postflop number the coach prints is exact and carries no error bar.
 *
 *   MONTE CARLO for preflop, where heads-up is 1,712,304 runouts per villain
 *   combo and exact is minutes rather than milliseconds.
 *
 * Sampling error is reported honestly rather than hidden: the 95% half-width
 * of a proportion is 1.96*sqrt(Var/n), so 40,000 samples is worth about +/-0.5
 * points. A coach that prints 66.53% from 500 samples is making up the last
 * two digits, and a student who notices will stop trusting the ones that are
 * real.
 *
 * The sampler is SEEDED from the cards, so the same spot always returns the
 * same number. Advice that flickers between 61% and 63% while you think reads
 * as broken, and it teaches you to distrust it.
 */

import { makeRng } from '../../shared/rng.js';
import { CATEGORY, categoryOf, freshDeck, rankOf, suitOf } from './cards.js';
import { boardState, evalBoard2, evalAny, eval7 } from './fasteval.js';
import { rangeCombos } from './notation.js';

/**
 * A deterministic seed for a spot.
 *
 * The cards are SORTED first, and that is the whole point. Hashing them in
 * argument order means [A♥, K♥] and [K♥, A♥] are different spots as far as the
 * sampler is concerned, so the same hand returns two different equities
 * depending on which order the caller happened to pass the hole cards — which
 * is precisely the flicker this seeding exists to prevent.
 *
 * The range is keyed by its identity, not by how many combos survived card
 * removal: two genuinely different ranges routinely have the same combo count.
 */
function seedFor(hero, board, rangeKey, samples) {
  let h = 2166136261;
  const mix = (n) => {
    h ^= n;
    h = Math.imul(h, 16777619);
  };
  for (const c of [...hero, ...board].sort((a, b) => a - b)) mix(c + 1);
  for (let i = 0; i < rangeKey.length; i++) mix(rangeKey.charCodeAt(i));
  mix(samples);
  return h >>> 0;
}

/** Stable identity for a range, so two different ranges never share a seed. */
function keyForRange(range) {
  if (!range) return 'random';
  return [...range].sort().join(',');
}

/**
 * When to enumerate instead of sample, counted in hero-vs-villain showdowns.
 *
 * Each showdown is two evaluations, and the evaluator runs at about 20M/sec.
 * The line is drawn at 400,000 because that is exactly where a FLOP against a
 * realistic range falls: 361 surviving combos x 990 runouts = 357,390
 * showdowns, measured at 13ms. So every number the coach quotes postflop is
 * enumerated, not sampled, and carries no error bar at all.
 *
 * A flop against a uniformly random hand is 1,070,190 showdowns (34ms) and
 * stays sampled — that call only ever comes from a bot deciding, where a third
 * of a percent does not change the answer. And nothing preflop is close:
 * heads-up preflop is 1,712,304 runouts per villain combo, which is minutes.
 */
const EXACT_SHOWDOWN_BUDGET = 400_000;

/**
 * Samples when we cannot enumerate.
 *
 * The standard error of a proportion is sqrt(p(1-p)/n), so the 95% half-width
 * at the worst case p=0.5 is 0.98/sqrt(n). 40,000 samples is +/-0.5 points,
 * which is the point where the second digit stops being fiction. It costs
 * about 8ms on this evaluator; on the old one it would have been 90ms, which
 * is why the number used to be 5,000 and the error bar used to be +/-1.4.
 */
const DEFAULT_SAMPLES = 40_000;

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
  const showdowns = villainCombos.length * runouts;

  if (showdowns <= EXACT_SHOWDOWN_BUDGET) {
    return enumerate(hero, board, villainCombos, deck, need);
  }
  const samples = opts.samples ?? DEFAULT_SAMPLES;
  const seed = seedFor(hero, board, keyForRange(range), samples);
  return sample(hero, board, villainCombos, deck, need, samples, seed);
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

/**
 * Every (villain hand, runout) pair, exactly once.
 *
 * The loop is RUNOUT-OUTER, villain-inner, which is the opposite of the
 * obvious nesting and the reason this is fast. Every villain on a given runout
 * shares the same five board cards, so the board's rank masks and suit counts
 * are folded in once per runout instead of once per showdown — for a turn spot
 * that is 46 board builds instead of 45,540.
 *
 * The two nestings enumerate the identical set of pairs: {villain, runout}
 * where they do not share a card. Only the order changes.
 */
function enumerate(hero, board, villainCombos, deck, need) {
  let win = 0;
  let tie = 0;
  let total = 0;

  const h0 = hero[0];
  const h1 = hero[1];
  const known = board.length;
  const full = [...board, 0, 0, 0, 0, 0].slice(0, 5);
  // Flags rather than a scan: a villain holding a card that just came off the
  // deck is an impossible hand, and that check runs once per showdown.
  const dealt = new Uint8Array(52);

  forEachRunout(deck, need, (runout) => {
    for (let i = 0; i < need; i++) {
      full[known + i] = runout[i];
      dealt[runout[i]] = 1;
    }
    const bs = boardState(full);
    const heroScore = evalBoard2(bs, h0, h1);

    for (let i = 0; i < villainCombos.length; i++) {
      const v0 = villainCombos[i][0];
      const v1 = villainCombos[i][1];
      if (dealt[v0] || dealt[v1]) continue;
      const villainScore = evalBoard2(bs, v0, v1);
      if (heroScore > villainScore) win++;
      else if (heroScore === villainScore) tie++;
      total++;
    }

    for (let i = 0; i < need; i++) dealt[runout[i]] = 0;
  });

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

function sample(hero, board, villainCombos, deck, need, samples, seed) {
  const rng = makeRng(seed);
  const n = deck.length;
  const h0 = hero[0];
  const h1 = hero[1];
  const known = board.length;

  // One scratch deck and one position index for the whole run. The old version
  // allocated a filtered copy of the deck per sample, which at 40,000 samples
  // is 40,000 arrays for the garbage collector to deal with and cost more than
  // the evaluation did.
  const scratch = deck.slice();
  const at = new Int32Array(52).fill(-1);
  for (let i = 0; i < n; i++) at[scratch[i]] = i;
  const swap = (i, j) => {
    const a = scratch[i];
    const b = scratch[j];
    scratch[i] = b;
    scratch[j] = a;
    at[b] = i;
    at[a] = j;
  };

  const full = [0, 0, 0, 0, 0];
  for (let i = 0; i < known; i++) full[i] = board[i];

  let win = 0;
  let tie = 0;
  for (let s = 0; s < samples; s++) {
    const villain = villainCombos[(rng() * villainCombos.length) | 0];
    const v0 = villain[0];
    const v1 = villain[1];
    // Park the villain's cards at the far end; the live deck is what is left.
    swap(at[v0], n - 1);
    swap(at[v1], n - 2);
    const live = n - 2;
    // Partial Fisher-Yates: shuffle only the cards we are about to turn over.
    for (let k = 0; k < need; k++) {
      swap(k, k + ((rng() * (live - k)) | 0));
      full[known + k] = scratch[k];
    }

    const heroScore = eval7(h0, h1, full[0], full[1], full[2], full[3], full[4]);
    const villainScore = eval7(v0, v1, full[0], full[1], full[2], full[3], full[4]);
    if (heroScore > villainScore) win++;
    else if (heroScore === villainScore) tie++;
  }

  const equity = (win + tie / 2) / samples;
  // Var(X) where X is 1 for a win, ½ for a chop and 0 for a loss works out to
  // p(1-p) - t/4 exactly, with t the chop rate. The usual Bernoulli formula
  // drops the -t/4 and so always overstates the error — harmlessly, but there
  // is no reason to overstate it when the correction is one subtraction.
  const t = tie / samples;
  const variance = Math.max(equity * (1 - equity) - t / 4, 1e-9);
  return {
    equity, win, tie, lose: samples - win - tie, samples,
    exact: false,
    // 95% half-width, which is what "+/-" should always mean.
    stdErr: 1.96 * Math.sqrt(variance / samples),
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
  const current = categoryOf(evalAny([...hero, ...board]));

  const heroRanks = new Set(hero.map(rankOf));
  const boardRanks = new Set(board.map(rankOf));

  // One reusable buffer for the 45-odd probes below, filled with the last slot
  // swapped out each time. Allocating a fresh array per candidate card is more
  // work than evaluating the hand in it.
  const probe = [...hero, ...board, 0];
  const last = probe.length - 1;

  const cards = [];
  const strong = [];
  for (const c of deck) {
    probe[last] = c;
    const after = categoryOf(evalAny(probe));
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
  const bits = [...rankSet].reduce((m, r) => m | (1 << r), 0);
  for (let high = 12; high >= 4; high--) {
    const mask = 0b11111 << (high - 4);
    if ((bits & mask) === mask) return true;
  }
  // The ace plays below the deuce as well as above the king, and the wheel is
  // the one place that matters. It is checked last because it is the LOWEST
  // straight, so any higher run above must win first.
  const wheel = (1 << 12) | 0b1111;
  return (bits & wheel) === wheel;
}

export { DRAW };
