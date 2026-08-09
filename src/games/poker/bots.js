/**
 * The opponents.
 *
 * Six personalities, each exploitable in a DIFFERENT way, because the point is
 * not to give the student a fair fight — it is to make each seat teach a
 * different lesson. Beat Mercy by never bluffing; beat Rocky by stealing every
 * button; beat Blaze by calling down and refusing to fold.
 *
 * Everything is a parameter, not prose. A bot's fold-to-c-bet is a number you
 * can point at, which is what lets the coach say "he folds two thirds of the
 * time here" and be telling the truth.
 *
 * The tells that give a bot away are mostly not about strategy:
 *   - sizing that correlates with hand strength (so size is picked from the
 *     NODE, never from the hand)
 *   - taking the argmax (so every decision is SAMPLED)
 *   - perfect consistency (so each seat is jittered at table creation)
 *   - instant, uniform timing (handled by the table's pacing, not here)
 */

import { makeRng } from '../../shared/rng.js';
import { CATEGORY, categoryOf, evaluate } from './cards.js';
import { equityVsRandom, outsFor } from './equity.js';
import { classOf } from './notation.js';
import { RFI } from './ranges.js';

/**
 * Parameters, calibrated to the archetype stat bands that tracking software
 * has used for twenty years. `rfi` is the share of hands opened by position,
 * which is the single number that separates these six most cleanly.
 */
export const PERSONALITIES = {
  rocky: {
    name: 'Rocky',
    blurb: 'Rock. Plays almost nothing and means it every time.',
    tell: 'Folds his blind to a steal three times out of four.',
    lesson: 'Raise every button. When he puts money in, believe him.',
    rfi: { UTG: 0.08, HJ: 0.10, CO: 0.14, BTN: 0.20, SB: 0.16, BB: 0.18 },
    threeBet: 0.03, foldToThreeBet: 0.78,
    cbet: { flop: 0.58, turn: 0.35, river: 0.22 },
    foldToCbet: 0.66, raiseCbet: 0.06,
    bluff: 0.10, valueFloor: { flop: 0.70, turn: 0.75, river: 0.82 },
    callElasticity: 1.30, aggroMade: 0.10, aggroDraw: 0.05,
    sizes: [0.5, 0.75], noise: 0.10, tilt: 0.05,
  },
  mercy: {
    name: 'Mercy',
    blurb: 'Calling station. Sees a lot of flops and almost every river.',
    tell: 'Folds to a continuation bet less than a quarter of the time.',
    lesson: 'Stop bluffing. Value bet thinner than feels right, and size up.',
    rfi: { UTG: 0.22, HJ: 0.26, CO: 0.32, BTN: 0.40, SB: 0.34, BB: 0.62 },
    threeBet: 0.015, foldToThreeBet: 0.32,
    cbet: { flop: 0.38, turn: 0.26, river: 0.18 },
    foldToCbet: 0.24, raiseCbet: 0.04,
    bluff: 0.03, valueFloor: { flop: 0.60, turn: 0.66, river: 0.72 },
    callElasticity: 0.55, aggroMade: 0.06, aggroDraw: 0.03,
    sizes: [0.5], noise: 0.30, tilt: 0.10,
  },
  blaze: {
    name: 'Blaze',
    blurb: 'Maniac. Raises constantly and barrels every street.',
    tell: 'Bets seven out of ten turns whether or not he has anything.',
    lesson: 'Call down wider. Trap instead of raising — he bluffs into checks.',
    rfi: { UTG: 0.32, HJ: 0.40, CO: 0.52, BTN: 0.70, SB: 0.60, BB: 0.55 },
    threeBet: 0.19, foldToThreeBet: 0.36,
    cbet: { flop: 0.88, turn: 0.78, river: 0.70 },
    foldToCbet: 0.34, raiseCbet: 0.26,
    bluff: 0.70, valueFloor: { flop: 0.50, turn: 0.54, river: 0.60 },
    callElasticity: 0.88, aggroMade: 0.40, aggroDraw: 0.55,
    sizes: [0.75, 1.0, 1.5], noise: 0.35, tilt: 0.45,
  },
  kaz: {
    name: 'Kaz',
    blurb: 'Tight and aggressive. Solid, and folds to pressure preflop.',
    tell: 'Gives up on the turn after c-betting the flop more than half the time.',
    lesson: '3-bet him light, and take the pot when he checks the turn.',
    rfi: { UTG: 0.16, HJ: 0.19, CO: 0.26, BTN: 0.44, SB: 0.38, BB: 0.38 },
    threeBet: 0.075, foldToThreeBet: 0.62,
    cbet: { flop: 0.62, turn: 0.46, river: 0.36 },
    foldToCbet: 0.50, raiseCbet: 0.10,
    bluff: 0.34, valueFloor: { flop: 0.62, turn: 0.67, river: 0.73 },
    callElasticity: 1.05, aggroMade: 0.16, aggroDraw: 0.28,
    sizes: [0.33, 0.66], noise: 0.15, tilt: 0.12,
  },
  vera: {
    name: 'Vera',
    blurb: 'Loose and aggressive. Three-bets light, then folds when you push back.',
    tell: 'Three-bets one hand in seven, and gives it up to a four-bet.',
    lesson: 'Four-bet her light with suited wheel aces. Do not fold so much.',
    rfi: { UTG: 0.22, HJ: 0.27, CO: 0.38, BTN: 0.58, SB: 0.48, BB: 0.48 },
    threeBet: 0.135, foldToThreeBet: 0.44,
    cbet: { flop: 0.78, turn: 0.60, river: 0.48 },
    foldToCbet: 0.42, raiseCbet: 0.18,
    bluff: 0.52, valueFloor: { flop: 0.58, turn: 0.63, river: 0.69 },
    callElasticity: 0.95, aggroMade: 0.26, aggroDraw: 0.42,
    sizes: [0.33, 0.75, 1.25], noise: 0.20, tilt: 0.25,
  },
  sol: {
    name: 'Sol',
    blurb: 'Balanced. No obvious leak to attack.',
    tell: 'None worth the name.',
    lesson: 'There is no exploit here. Win with fundamentals or do not win.',
    rfi: { UTG: 0.17, HJ: 0.21, CO: 0.28, BTN: 0.48, SB: 0.42, BB: 0.42 },
    threeBet: 0.095, foldToThreeBet: 0.53,
    cbet: { flop: 0.55, turn: 0.48, river: 0.40 },
    foldToCbet: 0.47, raiseCbet: 0.12,
    bluff: 0.40, valueFloor: { flop: 0.60, turn: 0.65, river: 0.71 },
    callElasticity: 1.00, aggroMade: 0.20, aggroDraw: 0.33,
    sizes: [0.25, 0.33, 0.75, 1.25], noise: 0.08, tilt: 0,
  },
};

export const PERSONALITY_IDS = Object.keys(PERSONALITIES);

/**
 * Hand-class strength order, used to turn "opens 20% of hands" into an actual
 * range without shipping a chart per bot. Ordered by heads-up equity against a
 * random hand, which is a good enough proxy preflop and is monotone, so a
 * width parameter always produces a nested range.
 */
const STRENGTH_ORDER = (() => {
  const cache = [];
  return () => {
    if (cache.length) return cache;
    const scored = [];
    for (const cls of Object.keys(PREFLOP_EQUITY)) scored.push([cls, PREFLOP_EQUITY[cls]]);
    scored.sort((a, b) => b[1] - a[1]);
    cache.push(...scored.map(([cls]) => cls));
    return cache;
  };
})();

/**
 * Equity against a random hand for each of the 169 classes, as a rank key.
 * Approximated from the standard published ordering rather than simulated at
 * boot — the exact values do not matter, only the ORDER does, and the order is
 * stable and well known.
 */
const PREFLOP_EQUITY = (() => {
  const RANKS = 'AKQJT98765432';
  const out = {};
  const val = (ch) => 14 - RANKS.indexOf(ch);
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hi = RANKS[Math.min(i, j)];
      const lo = RANKS[Math.max(i, j)];
      const a = val(hi);
      const b = val(lo);
      if (i === j) {
        out[hi + hi] = 50 + a * 2.5;
      } else {
        const gap = a - b;
        // A hand's value is its high card, its kicker, a connectedness bonus
        // and a suited bonus. Crude, monotone, and matches the published
        // ordering closely enough that a width parameter cuts in the right
        // place.
        const base = a * 1.6 + b * 1.0 - Math.max(0, gap - 1) * 0.9;
        out[`${hi}${lo}s`] = base + 4.2;
        out[`${hi}${lo}o`] = base;
      }
    }
  }
  return out;
})();

/** The widest `pct` of hands, by that ordering. */
export function rangeByWidth(pct) {
  const order = STRENGTH_ORDER();
  const set = new Set();
  let combos = 0;
  const target = pct * 1326;
  for (const cls of order) {
    if (combos >= target) break;
    set.add(cls);
    combos += cls.length === 2 ? 6 : cls.endsWith('s') ? 4 : 12;
  }
  return set;
}

/** Seat a bot, jittered so two of the same archetype never play identically. */
export function makeBot(id, personalityId, seed) {
  const base = PERSONALITIES[personalityId] ?? PERSONALITIES.sol;
  const rng = makeRng(seed);
  const jitter = (v, amt = 0.1) => Math.max(0, v * (1 + (rng() * 2 - 1) * amt));
  return {
    id,
    personality: personalityId,
    name: base.name,
    p: {
      ...base,
      rfi: Object.fromEntries(Object.entries(base.rfi).map(([k, v]) => [k, jitter(v)])),
      threeBet: jitter(base.threeBet),
      foldToCbet: jitter(base.foldToCbet, 0.06),
      bluff: jitter(base.bluff),
      callElasticity: jitter(base.callElasticity, 0.05),
    },
    tiltState: 0,
    seed,
  };
}

// ----------------------------------------------------------------- decide --

/**
 * One decision.
 *
 * @param bot    from makeBot
 * @param view   { hole, board, street, pot, toCall, minRaiseTo, maxRaiseTo,
 *                 canCheck, canRaise, bigBlind, position, seatsIn, handNo }
 * @returns { move: 'fold'|'check'|'call'|'raise', to?, why }
 */
export function decide(bot, view) {
  const rng = makeRng((bot.seed ^ (view.handNo * 2654435761) ^ view.street.length ^ view.pot) >>> 0);
  const p = tilted(bot);

  if (view.board.length === 0) return preflop(bot, p, view, rng);
  return postflop(bot, p, view, rng);
}

/** Tilt makes a bot looser and more aggressive, which is what tilt actually is. */
function tilted(bot) {
  const t = bot.tiltState ?? 0;
  if (!t) return bot.p;
  return {
    ...bot.p,
    bluff: bot.p.bluff * (1 + t),
    callElasticity: bot.p.callElasticity * (1 - 0.4 * t),
    rfi: Object.fromEntries(Object.entries(bot.p.rfi).map(([k, v]) => [k, Math.min(0.95, v * (1 + 0.6 * t))])),
  };
}

function preflop(bot, p, view, rng) {
  const cls = classOf(view.hole[0], view.hole[1]);
  const width = p.rfi[view.position] ?? p.rfi.BTN;
  const inRange = rangeByWidth(width).has(cls);
  const premium = rangeByWidth(0.045).has(cls); // roughly TT+, AQs+, AK

  if (view.toCall <= 0) {
    // Nobody has raised. Open or check the option.
    if (inRange && rng() > 0.12) {
      const to = Math.min(view.maxRaiseTo, Math.max(view.minRaiseTo, Math.round(view.bigBlind * 2.5)));
      return { move: 'raise', to, why: `opens ${Math.round(width * 100)}% from ${view.position}` };
    }
    return view.canCheck ? { move: 'check', why: 'checks the option' } : { move: 'fold', why: 'out of range' };
  }

  // Facing a raise.
  if (premium && rng() < 0.55 + p.threeBet) {
    const to = Math.min(view.maxRaiseTo, Math.max(view.minRaiseTo, Math.round(view.toCall * 3)));
    if (view.canRaise) return { move: 'raise', to, why: 'three-bets for value' };
  }
  if (rng() < p.threeBet && view.canRaise) {
    const to = Math.min(view.maxRaiseTo, Math.max(view.minRaiseTo, Math.round(view.toCall * 3)));
    return { move: 'raise', to, why: 'three-bets as a bluff' };
  }
  // Defend wider than the opening range, because the price is better.
  const defend = rangeByWidth(Math.min(0.95, width * 1.9));
  if (defend.has(cls)) return { move: 'call', why: 'defends against the raise' };
  return { move: 'fold', why: 'not enough to continue' };
}

function postflop(bot, p, view, rng) {
  // A bot does not need the coach's precision — it needs an answer inside a
  // millisecond, four times a hand, for three seats. Turn and river enumerate
  // exactly regardless; this count only bites on the flop, where +/-1.8 points
  // never changes which side of a threshold the decision lands on.
  const eq = equityVsRandom(view.hole, view.board, { samples: 3000 }).equity;
  const made = categoryOf(evaluate([...view.hole, ...view.board]));
  const draw = view.board.length < 5 ? outsFor(view.hole, view.board).strongOuts / 47 : 0;
  const street = view.street;
  const floor = p.valueFloor[street] ?? 0.62;

  // Sizing comes from the NODE, never from the hand. A bot whose bet size
  // tracks its hand strength is readable inside twenty hands.
  const frac = p.sizes[Math.floor(rng() * p.sizes.length)];
  const sizeTo = (base) => Math.min(
    view.maxRaiseTo,
    Math.max(view.minRaiseTo, Math.round(base + view.pot * frac)),
  );

  if (view.toCall <= 0) {
    if (eq >= floor) {
      const pBet = Math.min(0.97, 0.55 + 1.6 * (eq - floor));
      if (rng() < pBet && view.canRaise) return { move: 'raise', to: sizeTo(0), why: 'bets for value' };
      return { move: 'check', why: 'checks a strong hand' };
    }
    if (draw >= 0.15 && rng() < p.bluff * (0.6 + 1.2 * draw) && view.canRaise) {
      return { move: 'raise', to: sizeTo(0), why: 'semi-bluffs a draw' };
    }
    // Marginal showdown value CHECKS. Omitting this band is what makes a bot
    // bet third pair on the river and give itself away.
    if (eq < 0.35 && draw < 0.1 && rng() < p.bluff * p.cbet[street] && view.canRaise) {
      return { move: 'raise', to: sizeTo(0), why: 'bluffs with nothing' };
    }
    return { move: 'check', why: 'checks' };
  }

  // Facing a bet.
  const priceEq = view.toCall / (view.pot + view.toCall);
  const needed = priceEq * p.callElasticity;

  if (eq >= 0.72 && made >= CATEGORY.TWO_PAIR && view.canRaise) {
    if (rng() < p.aggroMade * (1 + 2 * (eq - 0.72))) {
      return { move: 'raise', to: sizeTo(view.toCall), why: 'raises for value' };
    }
  }
  if (draw >= 0.2 && street !== 'river' && view.canRaise && rng() < p.aggroDraw) {
    return { move: 'raise', to: sizeTo(view.toCall), why: 'raises with a draw' };
  }
  const implied = street === 'river' ? 0 : Math.min(0.08, draw * 0.35);
  if (eq + implied >= needed) return { move: 'call', why: 'has the price' };
  // A little mixed defence, so no single size runs them over completely.
  if (eq + implied >= needed - 0.04 && rng() < 0.25) return { move: 'call', why: 'defends light' };
  return { move: 'fold', why: 'not enough equity' };
}

/** Bots tilt after losing a big pot, and it wears off. */
export function applyResult(bot, { lostChips, stack }) {
  const severity = stack > 0 ? Math.min(1, lostChips / stack) : 0;
  const gain = (bot.p.tilt ?? 0) * severity;
  bot.tiltState = Math.min(1, (bot.tiltState ?? 0) * 0.85 + gain);
  return bot;
}
