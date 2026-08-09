/**
 * The coach.
 *
 * Turns a spot into a recommendation, the numbers behind it, and — after you
 * act — a grade. Three commitments shape everything here:
 *
 * 1. NEVER STATE A MIXED STRATEGY AS A PURE ONE. If two actions are within a
 *    twentieth of a big blind, they are the same action wearing different
 *    clothes, and the honest output is "either". A coach that says "always
 *    raise" about a spot the solver mixes is teaching a false certainty that
 *    the student will later have to unlearn.
 *
 * 2. SEPARATE WHAT IS EXACT FROM WHAT IS ESTIMATED. Pot odds are arithmetic.
 *    Equity is a sample with an error bar. They are labelled differently and
 *    never averaged into one confident-looking number.
 *
 * 3. GRADE THE DECISION, NOT THE RESULT. The runout is withheld until after
 *    the feedback, because people rate identical decisions as better when the
 *    outcome happened to be good, and poker is the purest environment there is
 *    for learning the wrong lesson from a win.
 */

import { CATEGORY, categoryOf, describe, evaluate } from './cards.js';
import { equityVsRange, outsFor } from './equity.js';
import { classOf } from './notation.js';
import { rangeByWidth } from './bots.js';
import { LEAKS, POSITION_NAME, RFI, preflopPlan } from './ranges.js';
import {
  alpha, commitmentAdvice, equityForNextCard, equityFromOuts, evOfCall,
  mdf, potOdds, realisationFactor, realisedEquity, requiredEquity, spr,
} from './odds.js';

/**
 * Grade bands, in big blinds of EV given up against the best action.
 * Anchored to measured solver error costs: opening one hand too wide is about
 * 0.14bb, a wrong flop size about 0.31bb, the same error on the turn 0.87bb.
 * So a range slip lands in "slightly off", a real strategic error in
 * "mistake", and only genuinely large errors reach "blunder".
 */
export const GRADES = [
  { id: 'solid', label: 'Solid', max: 0.05 },
  { id: 'loose', label: 'Slightly off', max: 0.25 },
  { id: 'mistake', label: 'Mistake', max: 1.0 },
  { id: 'blunder', label: 'Blunder', max: Infinity },
];

export function gradeFor(evLoss) {
  return GRADES.find((g) => evLoss <= g.max) ?? GRADES[GRADES.length - 1];
}

/** Two actions this close are the same decision; calling one wrong is noise. */
const INDIFFERENT_BB = 0.05;

/** Thousands separators. "40000 runouts" reads as a typo; "40,000" reads as a count. */
const num = (n) => n.toLocaleString('en-US');

/** Below this, a per-100 rate is an extrapolation from noise. */
const MIN_DECISIONS_TO_RATE = 20;

/**
 * Everything the coach knows about the spot in front of you.
 *
 * @param spot {
 *   hole, board, street, pot, toCall, minRaiseTo, maxRaiseTo, canCheck,
 *   canRaise, bigBlind, stack, position, opponents, villainWidth
 * }
 */
export function analyse(spot) {
  const {
    hole, board, street, pot, toCall, bigBlind, stack,
    position, opponents = 1, villainWidth = 0.35,
  } = spot;

  const bb = (chips) => chips / bigBlind;
  const range = rangeByWidth(villainWidth);
  // No sample count passed on purpose: postflop the engine enumerates and the
  // number is exact, and preflop it uses its full default so the error bar is
  // half a point rather than a point and a half. This panel is read by a
  // person who is about to risk money on it.
  const eq = equityVsRange(hole, board, range);
  const inPosition = position === 'BTN' || position === 'CO';

  // The pot you FACE already includes their bet. Using the pot before the bet
  // understates what you need and talks you into calls that lose money.
  const potFacing = pot;
  const potBefore = Math.max(0, pot - toCall);
  const required = toCall > 0 ? requiredEquity(toCall, potFacing) : 0;

  const outs = board.length >= 3 && board.length < 5 ? outsFor(hole, board) : null;
  const madeCat = board.length >= 3 ? categoryOf(evaluate([...hole, ...board])) : null;

  // The nut bonus belongs to DRAWS, not to made hands: it exists because a
  // draw wins a big pot when it gets there. Applying it to a hand that is
  // already ahead produced "83.5% effective equity" from 58% raw, which is
  // not a thing.
  const drawing = Boolean(outs && outs.strongOuts >= 8 && eq.equity < 0.55);
  const realisation = realisationFactor({
    inPosition,
    suited: (hole[0] & 3) === (hole[1] & 3),
    nutted: drawing,
    capped: madeCat !== null && madeCat <= CATEGORY.PAIR && board.length >= 4,
  });
  const realised = realisedEquity(eq.equity, realisation);

  const sprNow = spr(stack, potFacing);
  const facts = [];
  const warnings = [];

  facts.push({
    key: 'equity',
    label: 'Your equity',
    value: `${(eq.equity * 100).toFixed(1)}%`,
    detail: eq.exact
      ? `exact — every runout, against all ${num(eq.combos)} hands they can hold`
      : `±${(eq.stdErr * 100).toFixed(1)} at 95%, from ${num(eq.samples)} sampled runouts`,
    exact: eq.exact,
  });

  if (toCall > 0) {
    facts.push({
      key: 'price',
      label: 'You need',
      value: `${(required * 100).toFixed(1)}%`,
      detail: `calling ${Math.round(toCall)} into ${Math.round(potFacing)} — ${potOdds(toCall, potFacing).toFixed(1)} to 1`,
      exact: true,
    });
  }

  // The correction that matters most in the most common spot in poker.
  if (outs && outs.strongOuts > 0 && toCall > 0 && toCall < stack) {
    const oneCard = equityForNextCard(outs.strongOuts, outs.street);
    const twoCard = equityFromOuts(outs.strongOuts, outs.street);
    facts.push({
      key: 'outs',
      label: `${outs.strongOuts} outs`,
      value: `${(oneCard * 100).toFixed(1)}%`,
      detail: outs.street === 'turn'
        ? 'for the river — the only card left.'
        : `for the one card you are buying. ${(twoCard * 100).toFixed(1)}% if you see both, which you only do when the money is already in.`,
      exact: true,
    });
    if (twoCard > required && oneCard < required) {
      warnings.push(
        'The two-card number clears the price and the one-card number does not. '
        + 'Calling a flop bet buys one card; you have to pay again on the turn. '
        + 'This call needs implied odds to be right, not arithmetic.',
      );
    }
  }

  if (toCall > 0) {
    facts.push({
      key: 'mdf',
      label: 'Their bluff needs',
      value: `${(alpha(toCall, potBefore) * 100).toFixed(0)}%`,
      detail: `to work. You should defend about ${(mdf(toCall, potBefore) * 100).toFixed(0)}% of your range against this size — as a range, not with this hand specifically.`,
      exact: true,
    });
  }

  facts.push({
    key: 'spr',
    label: 'SPR',
    value: sprNow === Infinity ? '—' : sprNow.toFixed(1),
    detail: commitmentAdvice(sprNow).text,
    exact: true,
  });

  if (realisation < 0.95) {
    warnings.push(
      `Out of position you realise about ${Math.round(realisation * 100)}% of your equity — `
      + 'you cannot control the size of the pot you lose. Treat marginal spots as folds.',
    );
  }

  // The realisation discount is not a postflop-only correction — it is at its
  // largest preflop, where four more streets of being out of position are
  // still ahead of you. Showing raw equity while pricing the call on realised
  // equity would make the panel contradict its own verdict.
  if (Math.abs(realised - eq.equity) > 0.005) {
    const delta = (realised - eq.equity) * 100;
    facts.push({
      key: 'realised',
      label: 'Effective equity',
      value: `${(realised * 100).toFixed(1)}%`,
      detail: realisation < 1
        ? `${Math.abs(delta).toFixed(1)} points below raw. Out of position you cannot `
          + 'control the size of the pot, so some of that equity is never collected.'
        : `${delta.toFixed(1)} points above raw. Acting last, you see every decision `
          + 'before you commit, so you get to keep more of what you started with.',
      exact: false,
    });
  }

  const options = board.length === 0
    ? preflopOptions(spot, { eq, bb, realisation })
    : postflopOptions(spot, { eq, realised, outs, required, realisation, bb, potFacing, potBefore, madeCat });

  options.sort((a, b) => b.ev - a.ev);
  const best = options[0];
  const mixed = options.filter((o) => best.ev - o.ev <= INDIFFERENT_BB);

  return {
    street,
    hand: {
      class: classOf(hole[0], hole[1]),
      made: board.length >= 3 ? describe([...hole, ...board]) : null,
      draws: outs?.draws ?? [],
    },
    position: POSITION_NAME[position] ?? position,
    equity: eq,
    outs,
    required,
    spr: sprNow,
    realisation,
    facts,
    warnings,
    options,
    best,
    // More than one action inside the indifference band means the honest
    // answer is "either", and saying otherwise invents a certainty the maths
    // does not support.
    mixed: mixed.length > 1 ? mixed.map((o) => o.move) : null,
    opponents,
  };
}

/**
 * Preflop.
 *
 * The thing that makes preflop different from every later street is that raw
 * equity is a bad predictor of profit. 72s has 34% against a 3-bet-or-fold
 * range, which sounds like plenty against a price of 25% — and it is still a
 * fold, because you will play four more decisions out of position with the
 * worst hand at the table and you will not collect anything like 34% of that
 * pot. So the call is priced on REALISED equity, not raw, and the panel shows
 * both numbers rather than quietly using one and displaying the other.
 *
 * The raise is priced the way a raise actually makes money: mostly by everyone
 * folding. EV = P(all fold) × pot + P(called) × (what you make when called).
 * Not a constant standing in for "it's in the chart".
 */
function preflopOptions(spot, { eq, bb, realisation }) {
  const {
    hole, position, toCall, canRaise, minRaiseTo, maxRaiseTo, bigBlind, pot,
    opponents = 1,
  } = spot;
  const cls = classOf(hole[0], hole[1]);
  const facing = toCall > bigBlind ? 'open' : null;
  const plan = preflopPlan({ position, facing, openerPosition: spot.openerPosition });
  const chart = plan.raise ?? plan.threeBet ?? RFI[position];
  const inChart = chart?.has(cls) ?? false;
  const calls = plan.call?.has(cls) ?? false;
  const seat = POSITION_NAME[position] ?? position;
  const realised = realisedEquity(eq.equity, realisation);

  const out = [];
  // Folding is only a decision when there is something to call. Checking is
  // free, so folding instead of checking is the one strictly dominated action
  // in poker — and listing it as an option at 0.00bb put it inside the
  // indifference band of a marginal check, which had the coach announce
  // "check or fold — same value" in the big blind. They are not the same
  // value; one of them is never right.
  if (toCall > 0) {
    out.push({
      move: 'fold', ev: 0,
      why: 'Folding is always exactly zero. Money already in the pot is not yours.',
    });
  }

  if (toCall > 0) {
    const evCall = bb(evOfCall(toCall, pot, realised));
    out.push({
      move: 'call',
      ev: evCall,
      why: calls
        ? `${cls} is in the calling range from ${seat}.`
        : realisation < 1
          ? `${(eq.equity * 100).toFixed(1)}% raw, but you only realise about `
            + `${Math.round(realisation * 100)}% of it from ${seat} — call it `
            + `${(realised * 100).toFixed(1)}% effective. ${cls} is outside the chart here.`
          : `${cls} is outside the chart here.`,
    });
  } else {
    out.push({
      move: 'check',
      ev: 0.02,
      why: 'Nothing to call. Taking a free look at the flop costs nothing.',
    });
  }

  if (canRaise) {
    const to = Math.min(maxRaiseTo, Math.max(minRaiseTo, Math.round(bigBlind * (facing ? 3 : plan.sizing ?? 2.5))));
    const extra = to - toCall;
    // How often ONE opponent continues. Against an unopened pot the wide
    // defender is the big blind, which is getting a price and is already
    // invested; against a raise the continuing range is far tighter.
    const perOpponent = facing ? 0.28 : 0.42;
    const n = Math.max(1, opponents);
    const continueRange = rangeByWidth(perOpponent);
    // Your equity against ONE hand that continued — which is not the range you
    // started the hand against, because folding is information.
    //
    // RAW equity, deliberately, with no realisation premium. Realisation is a
    // statement about how much of your equity you collect over four streets of
    // one pot; multiplying it in here and then raising the result to the power
    // of the number of callers compounds a positional edge that does not
    // compound. The button's advantage is already expressed by the fact that
    // its chart is more than twice as wide as the hijack's.
    const vsOne = equityVsRange(hole, [], continueRange).equity;

    // Sum over how many of them actually call. Each continues independently
    // with probability d, so the count is binomial; and against k opponents
    // your share is approximately vsOne^k, because you now have to beat all of
    // them rather than one. That exponent is the whole reason a raise into
    // four players is a different proposition from a raise into one: fold
    // equity collapses AND the equity you are left with collapses with it.
    let chips = 0;
    let allFold = 0;
    for (let k = 0; k <= n; k++) {
      const p = choose(n, k) * perOpponent ** k * (1 - perOpponent) ** (n - k);
      if (k === 0) {
        allFold = p;
        chips += p * pot; // uncontested, and this is most of a raise's value
        continue;
      }
      chips += p * ((pot + (k + 1) * extra) * vsOne ** k - extra);
    }
    const evRaise = bb(chips);

    out.push({
      move: 'raise',
      to,
      // A hand outside the chart is not raising for value and not raising as a
      // bluff — it is raising because it looked like a hand, which is the leak.
      ev: inChart ? evRaise : Math.min(evRaise, 0) - 0.35,
      why: inChart
        ? `${cls} opens from ${seat}. Everyone folds about ${Math.round(allFold * 100)}% `
          + `of the time, which is where most of the money in a raise comes from; when `
          + `one of them plays back you have about ${(vsOne * 100).toFixed(0)}%.`
        : `${cls} is not in the ${seat} range — it is dominated by almost everything `
          + 'that continues against it, so the times you get called are the times you are behind.',
      leak: inChart ? null : LEAKS.earlyOffsuitBroadway,
    });
  }
  return out;
}

/** n choose k, for the handful of opponents a table ever has. */
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

function postflopOptions(spot, { eq, realised, outs, required, realisation, bb, potFacing, potBefore, madeCat }) {
  const { toCall, canCheck, canRaise, minRaiseTo, maxRaiseTo } = spot;
  const effective = realised;
  const out = [];

  // Same rule as preflop: with a free check available, folding is not a line,
  // it is a mistake, and offering it at 0.00bb makes it tie with any check
  // worth less than the indifference band.
  if (toCall > 0) {
    out.push({ move: 'fold', ev: 0, why: 'Folding is exactly zero, always.' });
  }

  if (canCheck) {
    out.push({
      move: 'check',
      ev: bb(eq.equity * potFacing) * 0.35,
      why: eq.equity < 0.6 && (!outs || outs.strongOuts < 8)
        ? 'Marginal showdown value belongs in a checking range. Betting it folds out worse and gets called by better.'
        : 'Checking keeps their bluffs in.',
    });
  }

  if (toCall > 0) {
    const evCall = bb(evOfCall(toCall, potFacing, effective));
    out.push({
      move: 'call',
      ev: evCall,
      why: `${(effective * 100).toFixed(1)}% effective equity against ${(required * 100).toFixed(1)}% needed`
        + (realisation < 0.95 ? ' — after the out-of-position discount.' : '.'),
      leak: effective < required && outs && outs.strongOuts > 0 ? LEAKS.chasingWithoutOdds : null,
    });
  }

  if (canRaise) {
    const size = Math.min(maxRaiseTo, Math.max(minRaiseTo, Math.round(toCall + potFacing * 0.66)));
    const extra = size - toCall;
    const isValue = eq.equity >= 0.62;
    const foldsNeeded = alpha(extra, potBefore + toCall);
    // Value: they call with the part of their range you beat, and you win a
    // pot that is now bigger by twice the raise.
    const valueEv = bb((potFacing + 2 * extra) * (effective - 0.5) * 0.9);
    // Bluff: fold equity, plus whatever the hand is still worth when called.
    const drawBack = outs ? Math.min(0.35, outs.strongOuts / 47) : 0;
    const bluffEv = bb(
      foldsNeeded * potFacing * 0.9
      - (1 - foldsNeeded) * extra * (1 - drawBack * 2),
    );
    out.push({
      move: 'raise',
      to: size,
      ev: isValue ? valueEv : bluffEv,
      why: isValue
        ? `Ahead of ${(effective * 100).toFixed(0)}% of what they can have — build the pot while you are.`
        : `As a bluff this has to work ${(foldsNeeded * 100).toFixed(0)}% of the time`
          + (outs && outs.strongOuts >= 8
            ? `, and you still have ${outs.strongOuts} outs when it does not.`
            : ', with nothing behind it when it does not.'),
    });
  }
  return out;
}

/**
 * Grade an action that has already been taken.
 *
 * The result of the hand is deliberately not an input. It cannot be — a call
 * that was right can lose and a call that was wrong can win, and letting the
 * runout colour the grade is exactly how poker teaches people the wrong
 * lesson for years at a time.
 */
export function grade(analysis, taken) {
  const chosen = analysis.options.find((o) => o.move === taken.move) ?? { ev: -1, move: taken.move };
  const loss = Math.max(0, analysis.best.ev - chosen.ev);

  // An action inside the indifference band is not an error, however the
  // arithmetic came out.
  const indifferent = analysis.mixed?.includes(taken.move);
  const g = indifferent ? GRADES[0] : gradeFor(loss);

  return {
    grade: g.id,
    label: g.label,
    evLoss: indifferent ? 0 : loss,
    best: analysis.best.move,
    bestSize: analysis.best.to ?? null,
    chosen: taken.move,
    indifferent: Boolean(indifferent),
    why: indifferent
      ? `${analysis.mixed.join(' and ')} are worth the same here. Either is fine.`
      : chosen.move === analysis.best.move
        ? analysis.best.why
        : `${analysis.best.move} is better by ${loss.toFixed(2)}bb. ${analysis.best.why}`,
    leak: chosen.leak ?? null,
  };
}

/**
 * Running score. EV loss per 100 decisions converges in hundreds of hands,
 * where win rate needs tens of thousands — so it is the only progress number
 * worth showing a student who wants to know whether they are improving.
 */
export function emptyScorecard() {
  return { decisions: 0, evLoss: 0, counts: { solid: 0, loose: 0, mistake: 0, blunder: 0 }, leaks: {} };
}

export function record(card, graded) {
  card.decisions++;
  card.evLoss += graded.evLoss;
  card.counts[graded.grade] = (card.counts[graded.grade] ?? 0) + 1;
  if (graded.leak) {
    const k = graded.leak.name;
    card.leaks[k] = card.leaks[k] ?? { name: k, why: graded.leak.why, count: 0, cost: 0 };
    card.leaks[k].count++;
    card.leaks[k].cost += graded.evLoss;
  }
  return card;
}

export function summarise(card) {
  const per100 = card.decisions ? (card.evLoss / card.decisions) * 100 : 0;
  // Ranked by TOTAL cost, not by how often it happens. A leak you hit 40% of
  // the time worth 0.05bb is noise; one you hit 6% of the time worth 2bb is
  // the whole problem.
  const leaks = Object.values(card.leaks).sort((a, b) => b.cost - a.cost);
  return {
    decisions: card.decisions,
    evLoss: card.evLoss,
    evLossPer100: per100,
    // Below this the per-100 figure is an extrapolation, not a measurement:
    // one blunder in your first five decisions reads as "87bb lost per 100",
    // which is not a fact about your poker. The client shows the running total
    // until there is enough to rate.
    rateable: card.decisions >= MIN_DECISIONS_TO_RATE,
    counts: card.counts,
    leaks: leaks.slice(0, 3),
    verdict: card.decisions < MIN_DECISIONS_TO_RATE
      ? 'Not enough decisions yet to say anything honest.'
      : per100 < 2 ? 'Very few errors. Your fundamentals are there.'
        : per100 < 8 ? 'Improving. The leaks below are where the money is.'
          : 'Plenty to work on — start with the leak at the top.',
  };
}
