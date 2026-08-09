/**
 * The opponents.
 *
 * A training bot is only worth playing if it is (a) legal, (b) distinguishable
 * from the other bots, and (c) exploitable in the specific way its seat card
 * claims. Those are the three things tested here, and the third one matters
 * most: if Mercy's card says "folds to a continuation bet less than a quarter
 * of the time" and Mercy actually folds half the time, the lesson the student
 * takes away is wrong, and they learned it from us.
 *
 * The other invariant worth guarding is that a bot must never wedge the table.
 * Every decision is checked against the legal-action set for the node it was
 * given, over thousands of randomly generated nodes.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONALITIES, PERSONALITY_IDS, applyResult, decide, makeBot, rangeByWidth,
} from '../src/games/poker/bots.js';
import { freshDeck, parseCard } from '../src/games/poker/cards.js';
import { classOf } from '../src/games/poker/notation.js';
import { makeRng, shuffle } from '../src/shared/rng.js';

const hand = (str) => str.trim().split(/\s+/).map(parseCard);

/** A legal betting node, so nothing below is testing an impossible spot. */
function node(over = {}) {
  const bigBlind = 20;
  const pot = over.pot ?? 100;
  const toCall = over.toCall ?? 0;
  return {
    hole: hand('Ah Kd'),
    board: [],
    street: 'preflop',
    pot,
    toCall,
    minRaiseTo: toCall + bigBlind,
    maxRaiseTo: 2000,
    canCheck: toCall <= 0,
    canRaise: true,
    bigBlind,
    position: 'BTN',
    seatsIn: 3,
    handNo: 1,
    ...over,
  };
}

/** Deal a random legal spot from a seeded deck, so runs are reproducible. */
function randomNode(rng, streetCards) {
  const deck = shuffle(freshDeck(), rng);
  const hole = [deck[0], deck[1]];
  const board = deck.slice(2, 2 + streetCards);
  const street = ['preflop', '', '', 'flop', 'turn', 'river'][streetCards] || 'preflop';
  const bigBlind = 20;
  const pot = 40 + Math.floor(rng() * 600);
  const toCall = rng() < 0.5 ? 0 : Math.floor(rng() * 300);
  return node({
    hole, board, street: streetCards === 5 ? 'river' : street,
    pot, toCall, bigBlind,
    minRaiseTo: toCall + bigBlind,
    maxRaiseTo: 2000,
    canCheck: toCall <= 0,
    canRaise: true,
    position: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'][Math.floor(rng() * 6)],
    handNo: 1 + Math.floor(rng() * 200),
  });
}

describe('personalities', () => {
  test('there are six, each with a name, a tell and a lesson', () => {
    assert.equal(PERSONALITY_IDS.length, 6);
    for (const id of PERSONALITY_IDS) {
      const p = PERSONALITIES[id];
      assert.ok(p.name, `${id} has no name`);
      assert.ok(p.blurb.length > 10, `${id} has no blurb`);
      assert.ok(p.tell.length > 3, `${id} has no tell`);
      assert.ok(p.lesson.length > 10, `${id} teaches nothing`);
    }
  });

  test('every parameter is in a range that means something', () => {
    for (const id of PERSONALITY_IDS) {
      const p = PERSONALITIES[id];
      for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']) {
        assert.ok(p.rfi[pos] > 0 && p.rfi[pos] <= 1, `${id} rfi.${pos} out of range`);
      }
      assert.ok(p.rfi.BTN > p.rfi.UTG, `${id} should open wider on the button`);
      for (const k of ['threeBet', 'foldToCbet', 'bluff', 'tilt']) {
        assert.ok(p[k] >= 0 && p[k] <= 1, `${id}.${k} = ${p[k]} is not a frequency`);
      }
      for (const street of ['flop', 'turn', 'river']) {
        assert.ok(p.cbet[street] > 0 && p.cbet[street] <= 1, `${id} cbet.${street} out of range`);
        assert.ok(p.valueFloor[street] > 0.4 && p.valueFloor[street] < 1, `${id} valueFloor.${street}`);
      }
      assert.ok(p.sizes.length > 0 && p.sizes.every((s) => s > 0 && s <= 2), `${id} has a silly bet size`);
    }
  });

  test('value thresholds rise street by street, as the pot grows', () => {
    // Betting the same hand strength into a river pot that is four times the
    // flop pot is how a bot bleeds money and how a student learns nothing.
    for (const id of PERSONALITY_IDS) {
      const v = PERSONALITIES[id].valueFloor;
      assert.ok(v.turn > v.flop, `${id} should need more to bet a turn`);
      assert.ok(v.river > v.turn, `${id} should need more to bet a river`);
    }
  });

  test('the archetypes are actually distinct, not six copies with different names', () => {
    const openBtn = PERSONALITY_IDS.map((id) => PERSONALITIES[id].rfi.BTN);
    assert.equal(new Set(openBtn).size, 6, 'no two bots open the same width');
    // The two extremes have to be far apart or "loose" and "tight" are labels
    // with nothing behind them.
    assert.ok(PERSONALITIES.blaze.rfi.BTN > PERSONALITIES.rocky.rfi.BTN * 3);
    assert.ok(PERSONALITIES.mercy.foldToCbet < PERSONALITIES.rocky.foldToCbet * 0.5);
  });

  test('each seat card describes a habit the parameters actually have', () => {
    // Rocky's card says he folds his blind to a steal; Mercy's says she never
    // folds to a c-bet; Blaze's says he barrels turns; Vera's says she 3-bets
    // most. If the numbers stop matching the words, the student is misled by
    // the thing that is supposed to be teaching them.
    assert.ok(PERSONALITIES.rocky.foldToCbet > 0.6, 'Rocky is billed as a folder');
    assert.ok(PERSONALITIES.mercy.foldToCbet < 0.25, 'Mercy is billed as never folding');
    assert.ok(PERSONALITIES.blaze.cbet.turn > 0.7, 'Blaze is billed as barrelling turns');

    // Vera 3-bets light and then folds to a 4-bet; Blaze 3-bets more still and
    // never folds. Those are different lessons, so the numbers have to
    // separate them in both directions, not just one.
    const ranked = [...PERSONALITY_IDS].sort((a, b) => PERSONALITIES[b].threeBet - PERSONALITIES[a].threeBet);
    assert.deepEqual(ranked.slice(0, 2), ['blaze', 'vera'], 'the two aggressors 3-bet most');
    assert.ok(
      PERSONALITIES.vera.foldToThreeBet > PERSONALITIES.blaze.foldToThreeBet,
      'Vera is billed as giving it up to pressure and Blaze is not',
    );
    assert.equal(PERSONALITIES.sol.tilt, 0, 'Sol is billed as having no leak');
  });

  test('Sol has the widest sizing menu, because a single size is readable', () => {
    for (const id of PERSONALITY_IDS) {
      if (id === 'sol') continue;
      assert.ok(PERSONALITIES.sol.sizes.length >= PERSONALITIES[id].sizes.length);
    }
    assert.equal(PERSONALITIES.mercy.sizes.length, 1, 'the station is meant to be readable');
  });
});

describe('range by width', () => {
  test('a wider number always contains the narrower one', () => {
    // Nested ranges are what make a width parameter mean anything. If 20%
    // contained a hand that 40% did not, "opens 40% of hands" would be a
    // description of nothing.
    let prev = rangeByWidth(0.02);
    for (const w of [0.05, 0.1, 0.2, 0.3, 0.5, 0.8]) {
      const wider = rangeByWidth(w);
      for (const cls of prev) assert.ok(wider.has(cls), `${w} should contain ${cls}`);
      prev = wider;
    }
  });

  test('the top of the range is the top of the range', () => {
    const tight = rangeByWidth(0.03);
    assert.ok(tight.has('AA'));
    assert.ok(tight.has('KK'));
    assert.ok(!tight.has('72o'));
  });

  test('it lands near the width it was asked for', () => {
    for (const w of [0.1, 0.25, 0.5]) {
      const combos = [...rangeByWidth(w)]
        .reduce((n, c) => n + (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12), 0);
      const actual = combos / 1326;
      assert.ok(Math.abs(actual - w) < 0.02, `asked ${w}, got ${actual.toFixed(3)}`);
    }
  });

  test('zero is empty and one is everything', () => {
    assert.equal(rangeByWidth(0).size, 0);
    assert.equal(rangeByWidth(1).size, 169);
  });
});

describe('seating a bot', () => {
  test('two seats of the same archetype do not play identically', () => {
    const a = makeBot('a', 'kaz', 1);
    const b = makeBot('b', 'kaz', 999);
    assert.notDeepEqual(a.p.rfi, b.p.rfi, 'jitter should separate two Kazes');
    assert.equal(a.name, b.name);
  });

  test('the same seed rebuilds the same bot, so replays are honest', () => {
    assert.deepEqual(makeBot('a', 'vera', 7).p, makeBot('a', 'vera', 7).p);
  });

  test('jitter never pushes a frequency outside its meaning', () => {
    for (const id of PERSONALITY_IDS) {
      for (let seed = 0; seed < 60; seed++) {
        const bot = makeBot('x', id, seed);
        assert.ok(bot.p.threeBet >= 0 && bot.p.threeBet <= 1);
        assert.ok(bot.p.foldToCbet >= 0 && bot.p.foldToCbet <= 1);
        assert.ok(bot.p.bluff >= 0 && bot.p.bluff <= 1);
        for (const v of Object.values(bot.p.rfi)) assert.ok(v > 0 && v <= 1);
      }
    }
  });

  test('an unknown archetype falls back rather than throwing', () => {
    const bot = makeBot('x', 'nobody', 1);
    assert.equal(bot.name, PERSONALITIES.sol.name);
  });
});

describe('decisions are always legal', () => {
  test('over four thousand random nodes, on every street', () => {
    const rng = makeRng(20240607);
    let checked = 0;
    for (const id of PERSONALITY_IDS) {
      const bot = makeBot('b', id, 42);
      for (const streetCards of [0, 3, 4, 5]) {
        for (let i = 0; i < 170; i++) {
          const v = randomNode(rng, streetCards);
          const d = decide(bot, v);
          checked++;

          assert.ok(['fold', 'check', 'call', 'raise'].includes(d.move), `bad move ${d.move}`);
          assert.ok(typeof d.why === 'string' && d.why.length > 0, 'every decision explains itself');
          if (d.move === 'check') assert.ok(v.canCheck, 'checked when there was a bet to face');
          if (d.move === 'call') assert.ok(v.toCall > 0, 'called nothing');
          if (d.move === 'raise') {
            assert.ok(v.canRaise, 'raised when it could not');
            assert.ok(Number.isInteger(d.to), `raise size ${d.to} is not a whole chip`);
            assert.ok(d.to >= v.minRaiseTo, `raised to ${d.to}, minimum ${v.minRaiseTo}`);
            assert.ok(d.to <= v.maxRaiseTo, `raised to ${d.to}, maximum ${v.maxRaiseTo}`);
          }
        }
      }
    }
    assert.equal(checked, 6 * 4 * 170);
  });

  test('it never folds when checking is free', () => {
    // Folding for nothing is the one decision that is always strictly wrong,
    // and it is the one a badly written bot makes most.
    const rng = makeRng(31337);
    for (const id of PERSONALITY_IDS) {
      const bot = makeBot('b', id, 5);
      for (let i = 0; i < 120; i++) {
        const v = { ...randomNode(rng, 3), toCall: 0, canCheck: true };
        const d = decide(bot, v);
        assert.notEqual(d.move, 'fold', `${id} folded for free`);
      }
    }
  });

  test('the same spot gives the same answer — the table cannot be re-rolled', () => {
    const bot = makeBot('b', 'kaz', 11);
    const v = node({ hole: hand('7c 2d'), toCall: 60, canCheck: false });
    const first = decide(bot, v);
    for (let i = 0; i < 5; i++) assert.deepEqual(decide(bot, v), first);
  });
});

describe('decisions are strategically sane', () => {
  test('aces raise preflop far more often than seven-deuce does', () => {
    const rate = (cls, holeStr) => {
      let raises = 0;
      for (let seed = 0; seed < 200; seed++) {
        const bot = makeBot('b', 'sol', seed);
        const d = decide(bot, node({ hole: hand(holeStr), handNo: seed, pot: 30 }));
        if (d.move === 'raise') raises++;
      }
      return raises / 200;
    };
    const aces = rate('AA', 'Ah As');
    const trash = rate('72o', '7c 2d');
    assert.ok(aces > 0.8, `aces should open nearly always, got ${aces}`);
    assert.ok(trash < 0.25, `seven-deuce should mostly fold, got ${trash}`);
  });

  test('a loose bot opens more hands than a tight one, measured not asserted', () => {
    const openRate = (id) => {
      let raises = 0;
      const rng = makeRng(4242);
      for (let i = 0; i < 400; i++) {
        const bot = makeBot('b', id, 3);
        const deck = shuffle(freshDeck(), rng);
        const d = decide(bot, node({ hole: [deck[0], deck[1]], handNo: i, pot: 30, position: 'BTN' }));
        if (d.move === 'raise') raises++;
      }
      return raises / 400;
    };
    const blaze = openRate('blaze');
    const rocky = openRate('rocky');
    assert.ok(blaze > rocky * 2, `Blaze ${blaze} should open far more than Rocky ${rocky}`);
  });

  test('the station calls far more than the rock does, facing the same bet', () => {
    const callRate = (id) => {
      let calls = 0;
      const rng = makeRng(90210);
      for (let i = 0; i < 300; i++) {
        const bot = makeBot('b', id, 8);
        const deck = shuffle(freshDeck(), rng);
        const d = decide(bot, node({
          hole: [deck[0], deck[1]], board: deck.slice(2, 5), street: 'flop',
          pot: 200, toCall: 100, canCheck: false, handNo: i,
        }));
        if (d.move === 'call' || d.move === 'raise') calls++;
      }
      return calls / 300;
    };
    assert.ok(callRate('mercy') > callRate('rocky') + 0.15, 'Mercy is billed as a station');
  });

  test('sizing comes from the node, not from the hand', () => {
    // A bot whose bet size tracks its hand strength is read inside twenty
    // hands, and the student learns to read a tell instead of learning poker.
    const sizes = (holeStr) => {
      const found = new Set();
      for (let i = 0; i < 200; i++) {
        const bot = makeBot('b', 'sol', 4);
        const d = decide(bot, node({
          hole: hand(holeStr), board: hand('Ah 7d 2c'), street: 'flop',
          pot: 200, toCall: 0, canCheck: true, handNo: i,
        }));
        if (d.move === 'raise') found.add(d.to);
      }
      return found;
    };
    const nuts = sizes('Ac Ad');
    const air = sizes('8h 3s');
    assert.ok(nuts.size > 1, 'a strong hand should use more than one size');
    // The size menus have to overlap. If they were disjoint, every bet would
    // announce the hand behind it.
    const shared = [...nuts].filter((s) => air.has(s));
    assert.ok(shared.length > 0, 'strong and weak hands must share sizes');
  });

  test('it does not bet every marginal hand — there is a checking range', () => {
    // Betting third pair on the river is the giveaway that a bot has no
    // showdown-value band, and it makes the whole table play the same.
    let checks = 0;
    const rng = makeRng(5150);
    for (let i = 0; i < 200; i++) {
      const bot = makeBot('b', 'sol', 2);
      const deck = shuffle(freshDeck(), rng);
      const d = decide(bot, node({
        hole: [deck[0], deck[1]], board: deck.slice(2, 7), street: 'river',
        pot: 300, toCall: 0, canCheck: true, handNo: i,
      }));
      if (d.move === 'check') checks++;
    }
    assert.ok(checks / 200 > 0.35, `only checked ${checks / 200} of rivers`);
  });
});

describe('tilt', () => {
  test('losing a big pot loosens a bot that tilts', () => {
    const bot = makeBot('b', 'blaze', 1);
    const before = bot.tiltState;
    applyResult(bot, { lostChips: 1800, stack: 2000 });
    assert.ok(bot.tiltState > before, 'Blaze should tilt after a big loss');
    assert.ok(bot.tiltState <= 1, 'tilt is bounded');
  });

  test('a bot with no tilt parameter never tilts, however it loses', () => {
    const bot = makeBot('b', 'sol', 1);
    for (let i = 0; i < 20; i++) applyResult(bot, { lostChips: 2000, stack: 2000 });
    assert.equal(bot.tiltState, 0, 'Sol is billed as having no leak, including this one');
  });

  test('it wears off when the losses stop', () => {
    const bot = makeBot('b', 'blaze', 1);
    applyResult(bot, { lostChips: 2000, stack: 2000 });
    const peak = bot.tiltState;
    for (let i = 0; i < 30; i++) applyResult(bot, { lostChips: 0, stack: 2000 });
    assert.ok(bot.tiltState < peak * 0.1, 'tilt should decay');
  });

  test('a tilted bot actually plays looser, not just carries a bigger number', () => {
    const spot = (bot, i) => decide(bot, node({ hole: hand('9c 4d'), handNo: i, pot: 30 }));
    const count = (bot) => {
      let raises = 0;
      for (let i = 0; i < 200; i++) if (spot(bot, i).move === 'raise') raises++;
      return raises;
    };
    const calm = makeBot('b', 'blaze', 6);
    const steaming = makeBot('b', 'blaze', 6);
    for (let i = 0; i < 4; i++) applyResult(steaming, { lostChips: 2000, stack: 2000 });
    assert.ok(steaming.tiltState > 0.2, 'set up a genuinely tilted bot');
    assert.ok(count(steaming) >= count(calm), 'tilt should widen the opening range');
  });

  test('a zero stack does not divide by zero', () => {
    const bot = makeBot('b', 'blaze', 1);
    applyResult(bot, { lostChips: 500, stack: 0 });
    assert.ok(Number.isFinite(bot.tiltState));
  });
});

describe('hand classification agrees with the range machinery', () => {
  test('every hole pair a bot can be dealt maps into a class the ranges know', () => {
    const all = rangeByWidth(1);
    const deck = freshDeck();
    for (let i = 0; i < deck.length; i++) {
      for (let j = i + 1; j < deck.length; j++) {
        assert.ok(all.has(classOf(deck[i], deck[j])), `${i},${j} produced an unknown class`);
      }
    }
  });
});
