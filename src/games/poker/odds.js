/**
 * The closed-form poker maths. No simulation here — every function is an exact
 * formula, so these are the numbers a coach can state without hedging.
 *
 * Kept separate from equity.js on purpose: equity is estimated, odds are not.
 * Mixing "we sampled 5000 runouts" with "pot odds are exactly 25%" in one
 * module makes it far too easy to present one with the other's confidence.
 */

/**
 * The equity a call needs to break even.
 *
 *   required = call / (pot + call)
 *
 * `pot` must ALREADY include the bet you are facing. The classic error is to
 * use the pot before the bet, which understates what you need and talks you
 * into calls that lose money.
 *
 * Facing 50 into a pot that was 100: pot is now 150, you call 50, and you need
 * 50/200 = 25%.
 */
export function requiredEquity(callAmount, potAfterBet) {
  const total = potAfterBet + callAmount;
  return total <= 0 ? 0 : callAmount / total;
}

/** The same number as classical odds, e.g. 3 for "3 to 1". */
export function potOdds(callAmount, potAfterBet) {
  return callAmount <= 0 ? Infinity : potAfterBet / callAmount;
}

/**
 * Minimum defence frequency: the share of your range you must continue with
 * so that a bet of this size cannot profit by auto-bluffing.
 *
 *   MDF   = pot / (pot + bet)
 *   alpha = bet / (pot + bet)      (the bluffer's required success rate)
 *
 * `pot` here is the pot BEFORE the bet.
 *
 * MDF is a bound on exploitation, not a rule for every hand. It does not apply
 * when your range is capped, when you hold no hands worth continuing with, or
 * against an opponent who is not bluffing enough — against a player who never
 * bluffs, the correct defence frequency is zero.
 */
export function mdf(betSize, potBeforeBet) {
  const total = potBeforeBet + betSize;
  return total <= 0 ? 1 : potBeforeBet / total;
}

export function alpha(betSize, potBeforeBet) {
  return 1 - mdf(betSize, potBeforeBet);
}

/**
 * The value:bluff ratio a polarised betting range needs at this size, so a
 * bluff-catcher is exactly indifferent.
 *
 * Betting pot: 2 value to 1 bluff. Betting half pot: 3 to 1. Betting twice
 * pot: 1.5 to 1. Bigger bets get to bluff MORE, which is the opposite of most
 * players' intuition.
 */
export function valueToBluff(betSize, potBeforeBet) {
  const totalAfter = potBeforeBet + 2 * betSize;
  return { value: totalAfter - betSize, bluff: betSize, ratio: (totalAfter - betSize) / betSize };
}

/**
 * Stack-to-pot ratio, measured on the effective stack.
 *
 * SPR is what decides commitment, and it is fixed the moment the flop is
 * dealt — which is why it belongs in preflop sizing decisions rather than
 * postflop ones.
 */
export function spr(effectiveStack, pot) {
  return pot <= 0 ? Infinity : effectiveStack / pot;
}

/** How much of one pair is worth stacking off for, by SPR. */
export function commitmentAdvice(sprValue) {
  if (sprValue <= 1) return { band: 'committed', text: 'Any pair is a stack-off. There is no fold left to make.' };
  if (sprValue <= 3) return { band: 'low', text: 'Top pair is enough to get it in.' };
  if (sprValue <= 6) return { band: 'medium', text: 'Top pair good kicker plays for one street, not three.' };
  if (sprValue <= 13) return { band: 'high', text: 'You want two pair or better to play a big pot.' };
  return { band: 'deep', text: 'Deep. One pair is a bluff-catcher; play for implied odds.' };
}

/**
 * Exact equity from a given number of outs, by enumeration rather than the
 * rule of 2 and 4.
 *
 * Flop with two cards to come, 47 unseen:
 *   P(miss both) = C(47-outs, 2) / C(47, 2)
 * Turn with one to come, 46 unseen:
 *   P(hit) = outs / 46
 */
export function equityFromOuts(outs, street) {
  if (outs <= 0) return 0;
  if (street === 'turn') return Math.min(1, outs / 46);
  const unseen = 47;
  const miss = ((unseen - outs) * (unseen - outs - 1)) / (unseen * (unseen - 1));
  return 1 - miss;
}

/**
 * The rule of 2 and 4, and how wrong it is.
 *
 * The shortcut over-estimates, and the error grows with the out count: at 9
 * outs it is about 1.4 points high, at 15 outs about 4.5. Worth quoting the
 * exact number when the difference changes a decision.
 */
export function ruleOfTwoAndFour(outs, street) {
  const quick = street === 'turn' ? outs * 2 : outs * 4;
  const exact = equityFromOuts(outs, street) * 100;
  return { quick, exact, error: quick - exact };
}

/**
 * Implied odds: how much more you need to win on later streets for a call
 * that is short of direct pot odds to break even.
 *
 *   need = (call - equity * (pot + call)) / equity
 *
 * Returns 0 when the call is already profitable on its own. Returns null when
 * the hand has no equity, because no amount of future money fixes that.
 */
export function impliedOddsNeeded(callAmount, potAfterBet, equity) {
  if (equity <= 0) return null;
  const direct = equity * (potAfterBet + callAmount) - callAmount;
  if (direct >= 0) return 0;
  return -direct / equity;
}

/**
 * Expected value of a call, in chips.
 *
 *   EV = equity * (pot + call) - call
 *
 * Positive means calling beats folding. Folding is always exactly 0 — money
 * already in the pot is not yours, and treating it as a loss you can recover
 * is the single most expensive mistake in the game.
 */
export function evOfCall(callAmount, potAfterBet, equity) {
  return equity * (potAfterBet + callAmount) - callAmount;
}

/**
 * Expected value of a bluff that only wins uncontested.
 *
 *   EV = foldPct * pot - (1 - foldPct) * bet
 *
 * This is the pure form and it ignores the equity you keep when called, so it
 * is a floor rather than the true value of a semi-bluff.
 */
export function evOfBluff(betSize, potBeforeBet, foldFrequency) {
  return foldFrequency * potBeforeBet - (1 - foldFrequency) * betSize;
}

/** How often a bluff of this size must work to break even — this is alpha. */
export const breakEvenBluffFrequency = alpha;

/**
 * Geometric sizing: the constant fraction of pot that, bet on each of the
 * remaining streets, gets exactly stacks in by the river.
 *
 *   (1 + 2f)^n = (2S + P) / P    ->    f = ((( 2S + P ) / P)^(1/n) - 1) / 2
 *
 * Betting a smaller fraction leaves money behind; a bigger one puts you all-in
 * early and gives up a street of value.
 */
export function geometricSizing(effectiveStack, pot, streetsLeft) {
  if (streetsLeft <= 0 || pot <= 0) return 0;
  const target = (2 * effectiveStack + pot) / pot;
  return (target ** (1 / streetsLeft) - 1) / 2;
}
