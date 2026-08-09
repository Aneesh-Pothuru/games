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
  alpha, commitmentAdvice, equityFromOuts, evOfBluff, evOfCall, geometricSizing,
  impliedOddsNeeded, mdf, potOdds, requiredEquity, ruleOfTwoAndFour, spr, valueToBluff,
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
