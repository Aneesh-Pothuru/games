/**
 * Equity and odds.
 *
 * The expected equities below are EXACT, produced by enumerating all
 * C(48,5) = 1,712,304 boards for each specific pair of holdings. They are not
 * copied from a chart: published charts quote the average over every suit
 * configuration of a matchup, so "AA vs KK = 82.36%" is the aggregate and a
 * specific AhAs vs KhKs is 82.64%. Testing against the aggregate would have
 * looked like a 0.3-point evaluator bug forever.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, freshDeck, parseCard } from '../src/games/poker/cards.js';
import { equityVsRange, equityVsRandom, outsFor } from '../src/games/poker/equity.js';
import { parseRange } from '../src/games/poker/notation.js';
import {
  alpha, bluffShareOfRange, commitmentAdvice, equityForNextCard, equityFromOuts,
  evOfBluff, evOfCall, geometricSizing, impliedOddsNeeded, mdf, potOdds,
  realisationFactor, realisedEquity, requiredEquity, requiredEquityAtSpr, requiredEquityVsRaise,
  requiredEquityWithImplied, ruleOfTwoAndFour, sizeForCombos, spr, valueToBluff,
} from '../src/games/poker/odds.js';

const C = (s) => s.trim().split(/\s+/).map(parseCard);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

/** Ground truth: every board, no sampling. ~1.7s per call, so used sparingly. */
function exactHeadsUp(hero, vill) {
  const dead = new Set([...hero, ...vill]);
  const deck = freshDeck().filter((c) => !dead.has(c));
  const n = deck.length;
  let w = 0;
  let t = 0;
  let total = 0;
  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const board = [deck[a], deck[b], deck[c], deck[d], deck[e]];
            const x = evaluate([...hero, ...board]);
            const y = evaluate([...vill, ...board]);
            if (x > y) w++;
            else if (x === y) t++;
            total++;
          }
        }
      }
    }
  }
  return (w + t / 2) / total;
}

describe('evaluator ground truth', () => {
  // One exact enumeration, as an anchor. If this drifts, every equity in the
  // app is wrong and nothing else in the suite would notice.
  test('AhAs vs KhKs is 82.64% over all 1.7M boards', () => {
    near(exactHeadsUp(C('Ah As'), C('Kh Ks')) * 100, 82.6366, 0.0005, 'AA vs KK');
  });
});

describe('equity vs a range', () => {
  test('the river is enumerated exactly, not sampled', () => {
    // Qh Jh Th with Ah Kh is a royal flush, which cannot lose or chop.
    const r = equityVsRange(C('Ah Kh'), C('Qh Jh Th 2c 5d'), parseRange('TT+, AQs+'));
    assert.equal(r.exact, true);
    assert.equal(r.stdErr, 0);
    assert.equal(r.equity, 1);
  });

  test('ace high is worth almost nothing against a strong range', () => {
    // Same two cards, a board that misses them entirely. Four hearts, not
    // five; A-K-Q-J with no ten is not a straight either.
    const r = equityVsRange(C('Ah Kh'), C('Qh Jh 2c 5d 9s'), parseRange('TT+, AQs+'));
    assert.equal(r.exact, true);
    assert.ok(r.equity < 0.1, `ace high should be near dead, got ${r.equity}`);
    assert.equal(r.win, 0, 'it beats nothing in that range');
  });

  test('a hand that cannot win has zero equity', () => {
    // Villain range is exactly the nuts on this board; hero has nothing.
    const r = equityVsRange(C('7c 2d'), C('Ah Kh Qh Jh Th'), parseRange('AA'));
    assert.equal(r.exact, true);
    assert.equal(r.equity, 0.5, 'the board plays — both hands are the same royal flush');
  });

  test('the turn is still exact against a narrow range', () => {
    const r = equityVsRange(C('Ah Kh'), C('Qh Jh 2c 5d'), parseRange('TT+'));
    assert.equal(r.exact, true);
    assert.ok(r.samples > 0);
  });

  test('preflop falls back to sampling, and says so', () => {
    const r = equityVsRange(C('Ah Kh'), [], parseRange('TT+, AQs+'));
    assert.equal(r.exact, false);
    assert.ok(r.stdErr > 0, 'a sampled number must report its error');
    assert.ok(r.stdErr < 0.02, `±${(r.stdErr * 100).toFixed(2)} is too loose to coach with`);
  });

  test('sampled equity lands within its own stated error', () => {
    const hero = C('Ah Kd');
    const vill = C('Qs Qc');
    const truth = exactHeadsUp(hero, vill);
    // A one-combo range is the same question the exact enumeration answers.
    const r = equityVsRange(hero, [], parseRange('QQ'), { samples: 20000 });
    near(r.equity, truth, r.stdErr * 2, 'AKo vs QQ');
  });

  test('the same spot always returns the same number', () => {
    const args = [C('Ah Kh'), C('Qh 7d 2c'), parseRange('TT+, AJs+')];
    assert.equal(equityVsRange(...args).equity, equityVsRange(...args).equity);
  });

  test('the ORDER of the hole cards does not change the answer', () => {
    // The sampler is seeded from the spot. Seeding it from the cards in
    // argument order means [Ah, Kh] and [Kh, Ah] are different spots, so the
    // same hand returns two different equities depending on which way round
    // the caller happened to pass them — the exact flicker the seeding is
    // there to prevent. It shipped that way once.
    const range = parseRange('TT+, AJs+');
    const a = equityVsRange([C('Ah Kh')[0], C('Ah Kh')[1]], [], range);
    const b = equityVsRange([C('Ah Kh')[1], C('Ah Kh')[0]], [], range);
    assert.equal(a.equity, b.equity, 'AhKh and KhAh must be the same spot');
  });

  test('the order of the BOARD does not change the answer either', () => {
    const range = parseRange('TT+, AJs+');
    const board = C('Qh 7d 2c 9s');
    const a = equityVsRange(C('Ah Kh'), board, range);
    const b = equityVsRange(C('Ah Kh'), [board[2], board[0], board[3], board[1]], range);
    assert.equal(a.equity, b.equity);
  });

  test('two different ranges of the same size get different samples', () => {
    // Keying the seed on the number of surviving combos rather than on the
    // range's identity means two unrelated ranges share a random stream, which
    // correlates errors that should be independent.
    const one = parseRange('AA, KK');       // 12 combos
    const two = parseRange('72o');          // 12 combos
    assert.equal(one.size + 0, 2);
    const a = equityVsRange(C('Qh Qd'), [], one);
    const b = equityVsRange(C('Qh Qd'), [], two);
    assert.notEqual(a.equity, b.equity, 'these are not the same question');
  });

  test('every postflop street against a real range is EXACT, not sampled', () => {
    // This is the point of the enumeration budget. A coach quoting "55.2%" on
    // the flop should mean 55.2%, not 55.2 give or take half a point.
    const range = parseRange('22+, A2s+, K9s+, QTs+, JTs, ATo+, KQo');
    for (const board of ['Qh 7d 2c', 'Qh 7d 2c 9s', 'Qh 7d 2c 9s 4h']) {
      const r = equityVsRange(C('Ah Kh'), C(board), range);
      assert.ok(r.exact, `${board} should be enumerated`);
      assert.equal(r.stdErr, 0, 'an exact answer has no error bar');
    }
  });

  test('the reported error bar is a 95% half-width and shrinks as sqrt(n)', () => {
    const range = parseRange('22+, A2s+, K9s+, QTs+, JTs, ATo+, KQo');
    const small = equityVsRange(C('Ah Kh'), [], range, { samples: 2500 });
    const big = equityVsRange(C('Ah Kh'), [], range, { samples: 40000 });
    assert.ok(!small.exact && !big.exact, 'preflop is sampled');
    // Four times the samples should halve the bar, to within rounding.
    const ratio = small.stdErr / big.stdErr;
    assert.ok(ratio > 3.4 && ratio < 4.6, `16x samples should shrink the bar 4x, got ${ratio}`);
  });

  test('blockers shrink the villain range', () => {
    const withBlocker = equityVsRange(C('Ah Ks'), [], parseRange('AA'));
    const without = equityVsRange(C('7h 2s'), [], parseRange('AA'));
    assert.equal(withBlocker.combos, 3, 'holding an ace kills half the aces');
    assert.equal(without.combos, 6);
  });

  test('equity against a random hand beats equity against a strong range', () => {
    const random = equityVsRandom(C('Ah Kh'), []).equity;
    const strong = equityVsRange(C('Ah Kh'), [], parseRange('QQ+, AKs')).equity;
    assert.ok(random > strong, `${random} should beat ${strong}`);
  });

  test('a dominated hand is behind a range that dominates it', () => {
    const r = equityVsRange(C('Ah Qd'), [], parseRange('AKs, AKo'));
    assert.ok(r.equity < 0.35, `AQo vs AK should be well under 35%, got ${r.equity}`);
  });
});

describe('outs', () => {
  const outs = (h, b) => outsFor(C(h), C(b));

  test('a flush draw with two overcards is 15', () => {
    const o = outs('Ah Kh', 'Qh 7h 2c');
    assert.equal(o.outs, 15, '9 to the flush plus 6 to a pair');
    assert.equal(o.strongOuts, 9, 'nine of them make a hand rather than a pair');
    assert.ok(o.draws.includes('flush draw'));
  });

  test('an open-ender is 8 to the straight', () => {
    const o = outs('9h 8s', 'Tc 7d 2s');
    assert.equal(o.strongOuts, 8);
    assert.equal(o.outs, 14);
    assert.ok(o.draws.includes('open-ended straight draw'));
  });

  test('a gutshot is 4, not 8', () => {
    const o = outs('9h 8s', 'Tc 6d 2s');
    assert.equal(o.strongOuts, 4);
    assert.ok(o.draws.includes('gutshot'));
    assert.ok(!o.draws.includes('open-ended straight draw'));
  });

  test('two overcards are 6', () => {
    const o = outs('Ah Kd', '7c 5s 2h');
    assert.equal(o.outs, 6);
    assert.equal(o.strongOuts, 0);
  });

  test('a pocket pair has 2 outs to a set', () => {
    assert.equal(outs('7h 7s', 'Ac Kd 2h').outs, 2);
  });

  test('a made straight is not drawing', () => {
    assert.equal(outs('9h 8s', 'Tc 7d 6s').outs, 0);
  });

  test('a card that pairs the board is not an out', () => {
    // Pairing the queen lifts everyone's category equally.
    const o = outs('Ah Kh', 'Qh 7h 2c');
    const queens = o.cards.filter((c) => (c >> 2) === 10);
    assert.equal(queens.length, 0);
  });

  test('but a board-pairing card that completes a flush IS an out', () => {
    // The deuce of hearts pairs the board and makes the flush.
    const o = outs('Ah Kh', 'Qh 7h 2c');
    assert.ok(o.cards.includes(parseCard('2h')), 'the 2h completes the flush');
  });

  test('a combo draw counts both draws without double counting', () => {
    const o = outs('Ah Kh', 'Qh Jh 2c');
    assert.ok(o.draws.includes('flush draw'));
    assert.equal(o.cards.length, new Set(o.cards).size, 'no card counted twice');
  });
});

// ------------------------------------------------------------------- odds --

describe('pot odds', () => {
  test('facing half pot needs 25%', () => {
    // Pot was 100, villain bets 50, pot is now 150 and the call is 50.
    near(requiredEquity(50, 150), 0.25, 1e-9, 'half pot');
    assert.equal(potOdds(50, 150), 3, '3 to 1');
  });

  test('facing pot needs 33%', () => {
    near(requiredEquity(100, 200), 1 / 3, 1e-9, 'pot-sized');
  });

  test('facing a third needs 20%', () => {
    near(requiredEquity(33, 133), 0.1988, 0.001, 'third pot');
  });

  test('the pot must already include the bet', () => {
    // The classic error: using the pot BEFORE the bet understates what you
    // need and talks you into calls that lose money.
    const wrong = requiredEquity(50, 100);
    const right = requiredEquity(50, 150);
    assert.ok(wrong > right, 'the mistake always makes the call look better');
    near(wrong, 1 / 3, 1e-9, 'before-bet pot');
  });
});

describe('MDF and alpha', () => {
  test('the standard table', () => {
    // bet as a fraction of pot -> MDF
    for (const [bet, expected] of [[0.25, 0.8], [0.5, 2 / 3], [0.75, 4 / 7], [1, 0.5], [2, 1 / 3]]) {
      near(mdf(bet * 100, 100), expected, 1e-9, `${bet}x pot`);
      near(alpha(bet * 100, 100), 1 - expected, 1e-9, `alpha at ${bet}x`);
    }
  });

  test('a pot-sized bluff must work half the time', () => {
    near(alpha(100, 100), 0.5, 1e-9, 'pot-sized bluff');
  });

  test('bigger bets are allowed to bluff more, not less', () => {
    const half = valueToBluff(50, 100).ratio;
    const potSized = valueToBluff(100, 100).ratio;
    const overbet = valueToBluff(200, 100).ratio;
    near(half, 3, 1e-9, 'half pot is 3:1');
    near(potSized, 2, 1e-9, 'pot is 2:1');
    near(overbet, 1.5, 1e-9, 'double pot is 1.5:1');
    assert.ok(half > potSized && potSized > overbet, 'the ratio falls as the bet grows');
  });

  test('a bluff breaks even exactly at alpha', () => {
    near(evOfBluff(100, 100, alpha(100, 100)), 0, 1e-9, 'break-even bluff');
    assert.ok(evOfBluff(100, 100, 0.6) > 0);
    assert.ok(evOfBluff(100, 100, 0.4) < 0);
  });
});

describe('outs to equity', () => {
  test('nine outs on the flop is about 35%', () => {
    near(equityFromOuts(9, 'flop') * 100, 34.97, 0.05, 'flush draw, two to come');
  });

  test('nine outs on the turn is about 19.6%', () => {
    near(equityFromOuts(9, 'turn') * 100, 19.57, 0.05, 'flush draw, one to come');
  });

  test('the rule of 4 crosses over: low it under-shoots, high it over-shoots', () => {
    // Worth knowing precisely, because the shortcut is wrong in DIFFERENT
    // directions and everyone remembers only the "it over-estimates" half.
    // 4 outs: 16 vs 16.47 exact, so the quick number is LOW.
    // 15 outs: 60 vs 54.12 exact, nearly 6 points HIGH.
    const small = ruleOfTwoAndFour(4, 'flop');
    const big = ruleOfTwoAndFour(15, 'flop');
    assert.ok(small.error < 0, `4 outs should under-shoot, got ${small.error}`);
    assert.ok(big.error > 5, `15 outs should over-shoot badly, got ${big.error}`);
    near(big.exact, 54.12, 0.1, '15 outs exact');
    assert.equal(big.quick, 60);
  });

  test('the rule of 2 always under-shoots slightly, because 46 is not 50', () => {
    for (const n of [4, 9, 15]) {
      const r = ruleOfTwoAndFour(n, 'turn');
      assert.ok(r.error < 0, `${n} outs: expected an under-estimate, got ${r.error}`);
      assert.ok(Math.abs(r.error) < 3, `${n} outs: off by ${r.error}`);
    }
  });

  test('more outs is always more equity', () => {
    for (let n = 1; n < 20; n++) {
      assert.ok(equityFromOuts(n + 1, 'flop') > equityFromOuts(n, 'flop'));
      assert.ok(equityFromOuts(n, 'flop') > equityFromOuts(n, 'turn'), 'two cards beat one');
    }
  });
});

describe('EV and implied odds', () => {
  test('a call at exactly the required equity is break-even', () => {
    near(evOfCall(50, 150, requiredEquity(50, 150)), 0, 1e-9, 'break-even call');
  });

  test('folding is zero, never negative', () => {
    // Money already in the pot is not yours. A call that loses 10 is worse
    // than folding even though you "already put 40 in".
    assert.ok(evOfCall(50, 150, 0.1) < 0, 'a bad call is worse than folding');
  });

  test('implied odds quantify what a short call needs to make back', () => {
    // 20% equity facing a half-pot bet that needs 25%.
    const need = impliedOddsNeeded(50, 150, 0.2);
    assert.ok(need > 0, 'the call is short on its own');
    // Winning that much more on later streets makes it exactly break even.
    near(evOfCall(50, 150 + need, 0.2), 0, 1e-6, 'implied odds close the gap');
  });

  test('a call that already prices in needs nothing extra', () => {
    assert.equal(impliedOddsNeeded(50, 150, 0.4), 0);
  });

  test('no equity means no implied odds can save it', () => {
    assert.equal(impliedOddsNeeded(50, 150, 0), null);
  });
});

describe('SPR and sizing', () => {
  test('SPR is stack over pot', () => {
    assert.equal(spr(300, 100), 3);
    assert.equal(commitmentAdvice(2).band, 'low');
    assert.equal(commitmentAdvice(0.8).band, 'committed');
    assert.equal(commitmentAdvice(20).band, 'deep');
  });

  test('geometric sizing gets stacks in over the streets left', () => {
    const pot = 100;
    const stack = 900;
    for (const streets of [1, 2, 3]) {
      const f = geometricSizing(stack, pot, streets);
      // Applying that fraction each street should land on the full stack.
      let p = pot;
      let put = 0;
      for (let i = 0; i < streets; i++) {
        const bet = p * f;
        put += bet;
        p += 2 * bet;
      }
      near(put, stack, 0.5, `${streets} streets`);
    }
  });

  test('fewer streets means bigger bets', () => {
    assert.ok(geometricSizing(900, 100, 1) > geometricSizing(900, 100, 3));
  });
});

describe('corrections that cost real money', () => {
  test('a flop call buys ONE card, not two', () => {
    // Nine-out flush draw facing half pot. Two-card equity says comfortable
    // call; one-card equity says fold by nearly six points. The call is
    // usually still right — but for implied odds, not for this reason.
    const required = requiredEquity(50, 150);
    near(required, 0.25, 1e-9, 'price');
    near(equityFromOuts(9, 'flop'), 0.3497, 0.0005, 'both cards');
    near(equityForNextCard(9, 'flop'), 0.1915, 0.0005, 'the card you are buying');
    assert.ok(equityFromOuts(9, 'flop') > required, 'the two-card number says call');
    assert.ok(equityForNextCard(9, 'flop') < required, 'the honest number says fold');
  });

  test('required equity heads-up never exceeds 50%, however large the bet', () => {
    let last = 0;
    for (const bet of [50, 100, 200, 500, 5000, 1e6]) {
      const r = requiredEquity(bet, 100 + bet);
      assert.ok(r < 0.5, `${bet}: ${r}`);
      assert.ok(r > last, 'and it rises monotonically');
      last = r;
    }
  });

  test('facing a raise is not the same shape as facing a bet', () => {
    // Pot 100, you bet 50, villain raises to 150. You call 100 into 300.
    near(requiredEquityVsRaise(100, 50, 150), 0.25, 1e-9, '3x raise of a half-pot bet');
    // The common error treats the raise size as the call.
    const wrong = requiredEquity(150, 250);
    assert.ok(wrong > 0.37, 'the error reports far more than the truth');
  });

  test('alpha is not the bluff share of the range', () => {
    // At pot-sized: a bluff must work 50% of the time, but bluffs should be
    // a third of the betting range. Conflating them over-bluffs by half.
    near(alpha(100, 100), 0.5, 1e-9, 'alpha at pot');
    near(bluffShareOfRange(100, 100), 1 / 3, 1e-9, 'bluff share at pot');
    near(bluffShareOfRange(50, 100), 0.25, 1e-9, 'bluff share at half pot');
  });

  test('the combos you hold decide the size, not the other way round', () => {
    near(sizeForCombos(12, 4), 0.5, 1e-9, '12 value, 4 bluffs -> half pot');
    near(sizeForCombos(12, 6), 1, 1e-9, '12 value, 6 bluffs -> pot');
    near(sizeForCombos(20, 4), 0.25, 1e-9, '20 value, 4 bluffs -> quarter pot');
    assert.equal(sizeForCombos(6, 12), null, 'over-bluffed at every size');
  });

  test('SPR barely changes the price but changes everything else', () => {
    near(requiredEquityAtSpr(1), 1 / 3, 1e-9, 'SPR 1');
    near(requiredEquityAtSpr(3), 0.4286, 0.0005, 'SPR 3');
    near(requiredEquityAtSpr(6), 0.4615, 0.0005, 'SPR 6');
    near(requiredEquityAtSpr(20), 0.4878, 0.0005, 'SPR 20');
    // Barely two points across a range where the correct stack-off standard
    // goes from top pair to a set. The price is not the mechanism.
    assert.ok(requiredEquityAtSpr(20) - requiredEquityAtSpr(6) < 0.03);
  });

  test('reverse implied odds move the requirement violently', () => {
    near(requiredEquityWithImplied(100, 200), 1 / 3, 1e-9, 'no later money');
    near(requiredEquityWithImplied(100, 200, 0, 100), 0.5, 1e-9, 'losing another call');
    near(requiredEquityWithImplied(100, 200, 0, 300), 2 / 3, 1e-9, 'losing three more');
    assert.ok(requiredEquityWithImplied(100, 200, 200, 0) < 1 / 3, 'implied odds cut it');
  });

  test('realisation is applied to the uncertain part, not multiplied in', () => {
    // Multiplying is the obvious implementation and it is wrong at both ends.
    // 95% x 1.23 = 117%, which is not a probability; 70% x 1.23 = 86%, which
    // claims position conjures sixteen points out of a hand that is already
    // well ahead. The adjustment has to vanish where the hand is decided.
    const ip = 1.23;
    const oop = 0.82;

    // Exactly plain multiplication at a coin flip, which is where the
    // published realisation factors were measured.
    near(realisedEquity(0.5, ip), 0.5 * ip, 1e-9, 'coin flip in position');
    near(realisedEquity(0.5, oop), 0.5 * oop, 1e-9, 'coin flip out of position');

    // And it never runs off the end of the scale, which multiplying does.
    assert.ok(realisedEquity(0.95, ip) < 1, '117% is not a probability');
    assert.ok(realisedEquity(0.95, ip) < 0.95 * ip, 'a near-lock has nothing left to gain');
    assert.ok(realisedEquity(0.70, ip) < 0.70 * ip);

    // The adjustment is largest where the hand is least decided and vanishes
    // at both ends — you cannot gain much on a hand that is already won, and
    // you cannot lose much of an equity you barely have.
    const shift = (e) => Math.abs(realisedEquity(e, oop) - e);
    assert.ok(shift(0.5) > shift(0.15), 'a coin flip moves more than a 15% hand');
    assert.ok(shift(0.5) > shift(0.9), 'and more than a 90% hand');
    assert.ok(shift(0.02) < 0.02, 'a hopeless hand has almost nothing to give up');
    assert.ok(shift(0.98) < 0.02, 'and a locked one has almost nothing to gain');

    // Always a probability, for any factor the model can produce.
    for (let e = 0; e <= 1.0001; e += 0.02) {
      for (const r of [0.5, 0.82, 1, 1.23, 1.6]) {
        const x = realisedEquity(e, r);
        assert.ok(x >= 0 && x <= 1, `realised(${e}, ${r}) = ${x}`);
      }
    }
  });

  test('realisation preserves the direction and the fixed points', () => {
    assert.equal(realisedEquity(0, 1.5), 0, 'no equity stays no equity');
    assert.equal(realisedEquity(1, 0.5), 1, 'a lock stays a lock');
    assert.equal(realisedEquity(0.42, 1), 0.42, 'a factor of one changes nothing');
    for (let e = 0.05; e < 1; e += 0.05) {
      assert.ok(realisedEquity(e, 1.2) > e, 'in position is always a gain');
      assert.ok(realisedEquity(e, 0.85) < e, 'out of position is always a loss');
    }
  });

  test('realisation is above 1 in position and below it out of position', () => {
    assert.ok(realisationFactor({ inPosition: true }) > 1.1);
    assert.ok(realisationFactor({ inPosition: false }) < 0.9);
    assert.ok(
      realisationFactor({ inPosition: true, suited: true })
        > realisationFactor({ inPosition: true }),
      'suited realises more',
    );
    assert.ok(
      realisationFactor({ inPosition: false, capped: true })
        < realisationFactor({ inPosition: false }),
      'capped realises less',
    );
  });
});
