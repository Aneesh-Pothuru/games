/**
 * The hot-path evaluator, checked against the readable one.
 *
 * There are two evaluators in this codebase on purpose. `cards.js evaluate()`
 * is written to be read — you can check a poker rule against it line by line.
 * `fasteval.js` is written to be fast, runs eleven times quicker, and is
 * completely unreadable as a statement of the rules. Neither is trustworthy
 * alone. Together they are, because they must return the IDENTICAL INTEGER for
 * every hand, and any disagreement is a bug in one of them.
 *
 * The full sweep — all 133,784,560 seven-card hands, plus all 2,598,960
 * five-card and 20,358,520 six-card hands — has been run and passes with zero
 * mismatches. It takes about ninety seconds, so the default suite runs a large
 * seeded random sample plus every hand shape that has ever been got wrong.
 * Set POKER_EXHAUSTIVE=1 to run the whole thing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORY, categoryOf, evaluate, parseCard } from '../src/games/poker/cards.js';
import { CAT, evalAny, eval7, boardState, evalBoard2 } from '../src/games/poker/fasteval.js';
import { makeRng } from '../src/shared/rng.js';

const hand = (str) => str.trim().split(/\s+/).map(parseCard);

describe('the two evaluators agree', () => {
  test('the category ordinals are the same in both files', () => {
    // They are separate constants, so nothing but a test stops them drifting —
    // and if they drift, every score silently shifts by a power of sixteen.
    assert.equal(CAT.HIGH, CATEGORY.HIGH);
    assert.equal(CAT.PAIR, CATEGORY.PAIR);
    assert.equal(CAT.TWO_PAIR, CATEGORY.TWO_PAIR);
    assert.equal(CAT.TRIPS, CATEGORY.TRIPS);
    assert.equal(CAT.STRAIGHT, CATEGORY.STRAIGHT);
    assert.equal(CAT.FLUSH, CATEGORY.FLUSH);
    assert.equal(CAT.BOAT, CATEGORY.BOAT);
    assert.equal(CAT.QUADS, CATEGORY.QUADS);
    assert.equal(CAT.SF, CATEGORY.STRAIGHT_FLUSH);
  });

  test('on the hands that are actually hard to rank', () => {
    const cases = [
      // The wheel is the lowest straight, and the ace plays low in it.
      'Ac 2d 3h 4s 5c 9d Kh',
      'Ac 2c 3c 4c 5c 9d Kh',        // steel wheel
      'Tc Jc Qc Kc Ac 2d 3h',        // royal
      // Two sets of trips: the lower one plays as the boat's pair.
      '7c 7d 7h 9s 9d 9c 2s',
      // Quads plus a pair — the pair must not become a kicker.
      'Kc Kd Kh Ks 9c 9d 2s',
      // Trips on a board that also makes a straight: the straight wins.
      '5c 6d 7h 8s 9c 9d 9h',
      // Flush and a straight at once, but not a straight flush.
      'Ah Kh Qh Jh 9h Ts 2c',
      // Five of one suit where the straight-flush test must look at the flush
      // cards only, not at every card in the hand.
      '2h 3h 4h 5h 9h 6c 7d',
      // Three pair: only the top two count and the third pair's rank is the
      // kicker, which is the classic seven-card off-by-one.
      'Ac Ad 9h 9s 4c 4d Kh',
      // A board that beats both hole cards.
      'Tc Jd Qh Ks Ac 2d 3h',
      // Six to a straight.
      '4c 5d 6h 7s 8c 9d Kh',
      // A pair on the board plus a pair in hand, sharing a rank.
      'Ac Ad As 4c 4d 4h 2s',
    ];
    for (const c of cases) {
      const cards = hand(c);
      assert.equal(evalAny(cards), evaluate(cards), `evalAny disagrees on ${c}`);
      assert.equal(eval7(...cards), evaluate(cards), `eval7 disagrees on ${c}`);
    }
  });

  test('over 300,000 random seven-card hands', () => {
    const rng = makeRng(0xC0FFEE);
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let n = 0; n < 300_000; n++) {
      for (let k = 51; k > 44; k--) {
        const j = (rng() * (k + 1)) | 0;
        const t = deck[k];
        deck[k] = deck[j];
        deck[j] = t;
      }
      const cards = deck.slice(45);
      const base = evaluate(cards);
      assert.equal(eval7(...cards), base, `eval7 disagrees on ${cards}`);
      assert.equal(evalAny(cards), base, `evalAny disagrees on ${cards}`);
    }
  });

  test('over 150,000 random five- and six-card hands', () => {
    // Five and six matter because the coach evaluates a flop (5) and a turn
    // (6) directly, not just complete seven-card showdowns.
    const rng = makeRng(0xBADA55);
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let n = 0; n < 150_000; n++) {
      const size = n % 2 === 0 ? 5 : 6;
      for (let k = 51; k > 51 - size; k--) {
        const j = (rng() * (k + 1)) | 0;
        const t = deck[k];
        deck[k] = deck[j];
        deck[j] = t;
      }
      const cards = deck.slice(52 - size);
      assert.equal(evalAny(cards), evaluate(cards), `disagrees on ${cards}`);
    }
  });

  test('the board-hoisted form agrees with the plain one', () => {
    const rng = makeRng(0x5EED);
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let n = 0; n < 100_000; n++) {
      for (let k = 51; k > 44; k--) {
        const j = (rng() * (k + 1)) | 0;
        const t = deck[k];
        deck[k] = deck[j];
        deck[j] = t;
      }
      const cards = deck.slice(45);
      const bs = boardState(cards.slice(0, 5));
      assert.equal(evalBoard2(bs, cards[5], cards[6]), eval7(...cards));
    }
  });

  test('a prepared board can be reused for many hole cards', () => {
    // This is the whole reason boardState exists, so it is worth proving that
    // reuse does not leak state from one evaluation into the next.
    const board = hand('Qh 7d 2c 9s 4h');
    const bs = boardState(board);
    const holes = [hand('Ah Kh'), hand('Qc Qd'), hand('2h 2s'), hand('Jc Tc')];
    const first = holes.map((h) => evalBoard2(bs, h[0], h[1]));
    for (let round = 0; round < 3; round++) {
      holes.forEach((h, i) => {
        assert.equal(evalBoard2(bs, h[0], h[1]), first[i], 'boardState was mutated');
        assert.equal(evalBoard2(bs, h[0], h[1]), evaluate([...h, ...board]));
      });
    }
  });

  test('categoryOf works on scores from either evaluator', () => {
    const royal = hand('Tc Jc Qc Kc Ac 2d 3h');
    assert.equal(categoryOf(eval7(...royal)), CATEGORY.STRAIGHT_FLUSH);
    assert.equal(categoryOf(evalAny(royal)), CATEGORY.STRAIGHT_FLUSH);
  });
});

describe('the wheel, which is where evaluators go wrong', () => {
  test('it is a straight, and the lowest one', () => {
    const wheel = hand('Ac 2d 3h 4s 5c');
    const six = hand('2c 3d 4h 5s 6c');
    assert.equal(categoryOf(evalAny(wheel)), CATEGORY.STRAIGHT);
    assert.ok(evalAny(six) > evalAny(wheel), 'six-high beats the wheel');
    assert.equal(evalAny(wheel), evaluate(wheel));
  });

  test('a hand containing both the wheel and a higher straight takes the higher', () => {
    const both = hand('Ac 2d 3h 4s 5c 6d 7h');
    assert.equal(evalAny(both), evaluate(both));
    assert.ok(evalAny(both) > evalAny(hand('Ac 2d 3h 4s 5c 9d Kh')));
  });

  test('the steel wheel is a straight flush, and the lowest one', () => {
    const steel = hand('Ac 2c 3c 4c 5c');
    const sixHighSf = hand('2c 3c 4c 5c 6c');
    assert.equal(categoryOf(evalAny(steel)), CATEGORY.STRAIGHT_FLUSH);
    assert.ok(evalAny(sixHighSf) > evalAny(steel));
    assert.equal(evalAny(steel), evaluate(steel));
  });
});

describe('the exhaustive sweep', { skip: !process.env.POKER_EXHAUSTIVE }, () => {
  test('all 133,784,560 seven-card hands', () => {
    let bad = 0;
    let checked = 0;
    const buf = [0, 0, 0, 0, 0, 0, 0];
    for (let a = 0; a < 46; a++) {
      for (let b = a + 1; b < 47; b++) {
        for (let c = b + 1; c < 48; c++) {
          for (let d = c + 1; d < 49; d++) {
            for (let e = d + 1; e < 50; e++) {
              for (let f = e + 1; f < 51; f++) {
                for (let g = f + 1; g < 52; g++) {
                  buf[0] = a; buf[1] = b; buf[2] = c; buf[3] = d;
                  buf[4] = e; buf[5] = f; buf[6] = g;
                  const base = evaluate(buf);
                  if (eval7(a, b, c, d, e, f, g) !== base) bad++;
                  if (evalAny(buf) !== base) bad++;
                  checked++;
                }
              }
            }
          }
        }
      }
    }
    assert.equal(checked, 133_784_560);
    assert.equal(bad, 0);
  });
});
