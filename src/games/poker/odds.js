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
 * Facing a RAISE, which is not the same shape and is routinely computed wrong.
 *
 * You bet B into P0, villain raises TO R, and you call R - B — your own bet is
 * already dead money and is not part of the call.
 *
 *   required = (R - B) / (P0 + 2R)
 *
 * Treating the raise size as the call amount reports 60% where the answer is
 * 25%. Cheap raises are much cheaper to call than they look.
 */
export function requiredEquityVsRaise(potBeforeYourBet, yourBet, raiseTo) {
  const call = raiseTo - yourBet;
  const facing = potBeforeYourBet + yourBet + raiseTo;
  return requiredEquity(call, facing);
}

/**
 * The share of a betting range that should be bluffs, at a given size.
 *
 *   bluffShare = b / (1 + 2b)      for b = bet / pot
 *
 * This is NOT alpha. Alpha is how often a bluff must SUCCEED (50% at pot);
 * the bluff share of the range is a different number (33.3% at pot). Using
 * alpha here builds a range roughly half again too bluff-heavy at every size,
 * and the two are easy to confuse because both are "the bluffing number".
 */
export function bluffShareOfRange(betSize, potBeforeBet) {
  const b = potBeforeBet > 0 ? betSize / potBeforeBet : 0;
  return b / (1 + 2 * b);
}

/**
 * The bet size that the combos you actually hold can support.
 *
 *   b* = bluffs / (value - bluffs)
 *
 * Inverting the balance condition rather than picking a size and hoping. With
 * 12 value combos and 4 bluffs you can bet half pot; with 6 value and 12
 * bluffs no size is defensible and you should be checking.
 */
export function sizeForCombos(valueCombos, bluffCombos) {
  if (valueCombos <= bluffCombos) return null;
  return bluffCombos / (valueCombos - bluffCombos);
}

/**
 * The equity needed to call an all-in at a given SPR, since shoving at SPR s
 * IS betting s times the pot.
 *
 *   required = SPR / (1 + 2 * SPR)
 *
 * Note where this asymptotes: 50%, and it barely moves from SPR 6 (46.2%) to
 * SPR 20 (48.8%). Pot odds are therefore NOT the reason deep stacks demand
 * stronger hands — the reason is that only very strong hands are willing to
 * put a deep stack in, so the range you are called by tightens far faster than
 * the price loosens. An engine that compares raw equity to this number will
 * happily stack you into a set.
 */
export function requiredEquityAtSpr(sprValue) {
  return sprValue / (1 + 2 * sprValue);
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
 * The equity a draw has for the card it is actually buying.
 *
 * This is the correction that matters most in the most common spot in poker.
 * Calling a flop bet buys ONE card — you have to pay again on the turn to see
 * the river — so the number to compare against pot odds is o/47, not the
 * two-card figure.
 *
 * A nine-out flush draw facing half pot: two-card equity is 34.97% against a
 * 25% price and looks like a comfortable call. One-card equity is 19.15% and
 * is a fold by nearly six points. The call is usually still right, but because
 * of implied odds and the option to raise later — not because 35% beats 25%.
 * Quoting the two-card number against a bet that is not all-in is the single
 * most expensive habit a naive odds display can teach.
 *
 * The two-card figure is correct only when you are all-in, or certain to see
 * both cards for free.
 */
export function equityForNextCard(outs, street) {
  if (outs <= 0) return 0;
  return Math.min(1, outs / (street === 'turn' ? 46 : 47));
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
 * Required equity once the money you expect to LOSE on later streets is
 * counted too.
 *
 *   required = (call + lose) / (pot + win + call + lose)
 *
 * With win and lose both zero this collapses to plain pot odds, which is why
 * it is the only formula the engine really needs. The reverse term is violent:
 * an expected further loss equal to the call pushes a 33% requirement to 50%.
 * That is what makes second pair a fold against a big turn bet even when the
 * immediate price looks fine.
 */
export function requiredEquityWithImplied(callAmount, potAfterBet, winLater = 0, loseLater = 0) {
  const risk = callAmount + loseLater;
  const reward = potAfterBet + winLater;
  return requiredEquity(risk, reward);
}

/**
 * Equity realisation. Raw equity assumes the hand gets checked down, which
 * never happens.
 *
 * In position you see every action before committing, can take free cards and
 * can control the final pot, so you realise MORE than raw equity — typically
 * 1.10 to 1.20. Out of position it is 0.75 to 0.90. Suitedness adds roughly
 * another 0.08, and most of that is not the extra raw equity: it is that the
 * equity a suited hand flops is NUTTED, which is the profile that gets paid.
 *
 * Nutted draws over-realise (a combo draw can reach 1.4); capped medium made
 * hands under-realise (0.75 is common) because they cannot call three streets.
 */
export function realisationFactor({ inPosition, suited = false, nutted = false, capped = false }) {
  let r = inPosition ? 1.15 : 0.82;
  if (suited) r += 0.08;
  if (nutted) r += 0.2;
  if (capped) r -= 0.1;
  return Math.max(0.5, Math.min(1.6, r));
}

/**
 * Apply a realisation factor to raw equity.
 *
 * NOT a multiplication, which is the obvious thing to write and is wrong at
 * both ends. Multiplying 70% by 1.23 claims 86% — but position cannot conjure
 * sixteen points out of a hand that is already well ahead, and multiplying 95%
 * by the same factor claims 117%, which is not a probability at all. The same
 * error runs the other way: a 3% hand does not lose a fifth of its equity to
 * being out of position, because there is barely any equity there to lose.
 *
 * The adjustment belongs on the UNCERTAIN part of the hand:
 *
 *   effective = e + (r - 1) * 2 * e * (1 - e)
 *
 * e(1-e) peaks at a coin flip and vanishes at both ends, and the factor of two
 * makes this agree exactly with plain multiplication at e = 0.5, where the
 * published realisation numbers were measured. So a hand that is genuinely
 * 50/50 gets the full positional premium, a hand that is already 95% gets
 * almost none of it, and the result is always a probability.
 */
export function realisedEquity(equity, factor) {
  const e = Math.max(0, Math.min(1, equity));
  const adjusted = e + (factor - 1) * 2 * e * (1 - e);
  return Math.max(0, Math.min(1, adjusted));
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
