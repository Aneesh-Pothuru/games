/**
 * Poker tests.
 *
 * Three things are worth testing here and almost nothing else is:
 *   1. the evaluator, against hands that are genuinely hard to rank;
 *   2. side pots, against the conservation-of-chips invariant;
 *   3. the re-opening rule, which is the rule real casinos have to arbitrate.
 *
 * The worked betting examples below come from TDA rulebook illustrations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY,
  bestFive,
  cardName,
  categoryOf,
  describe as describeHand,
  evaluate,
  freshDeck,
  parseCard,
} from '../src/games/poker/cards.js';
import { makeRng, shuffle } from '../src/shared/rng.js';
import { buildPots, awardPots } from '../src/games/poker/pots.js';
import { applyAction, legalActions, openRound, postChips, roundComplete } from '../src/games/poker/betting.js';
import * as holdem from '../src/games/poker/index.js';
import { GAMES } from '../src/games/index.js';

const hand = (str) => str.trim().split(/\s+/).map(parseCard);

// -------------------------------------------------------------- evaluator --

describe('hand evaluator', () => {
  test('categories rank in the right order', () => {
    const ordered = [
      'Ac Kd 9h 5s 2c', // high card
      'Ac Ad 9h 5s 2c', // pair
      'Ac Ad 9h 9s 2c', // two pair
      'Ac Ad Ah 9s 2c', // trips
      '5c 6d 7h 8s 9c', // straight
      'Ac 9c 7c 5c 2c', // flush
      'Ac Ad Ah 9s 9c', // full house
      'Ac Ad Ah As 9c', // quads
      '5c 6c 7c 8c 9c', // straight flush
    ].map(hand);
    for (let i = 1; i < ordered.length; i++) {
      assert.ok(
        evaluate(ordered[i]) > evaluate(ordered[i - 1]),
        `${describeHand(ordered[i])} should beat ${describeHand(ordered[i - 1])}`,
      );
    }
  });

  test('the wheel is the lowest straight, not the highest', () => {
    const wheel = hand('Ac 2d 3h 4s 5c');
    const sixHigh = hand('2c 3d 4h 5s 6c');
    assert.equal(categoryOf(evaluate(wheel)), CATEGORY.STRAIGHT);
    assert.ok(evaluate(sixHigh) > evaluate(wheel), 'six-high straight beats the wheel');
    assert.equal(describeHand(wheel), 'Straight, Five high');
  });

  test('the steel wheel is the lowest straight flush', () => {
    const steel = hand('Ac 2c 3c 4c 5c');
    const six = hand('2c 3c 4c 5c 6c');
    assert.equal(categoryOf(evaluate(steel)), CATEGORY.STRAIGHT_FLUSH);
    assert.ok(evaluate(six) > evaluate(steel));
  });

  test('an ace-high straight is not a wheel', () => {
    const broadway = hand('Ac Kd Qh Js Tc');
    assert.equal(describeHand(broadway), 'Straight, Ace high');
    assert.equal(describeHand(hand('Ac Kc Qc Jc Tc')), 'Royal flush');
  });

  test('seven cards containing a wheel and a higher straight take the higher', () => {
    // A2345 and 34567 are both present.
    assert.equal(describeHand(hand('Ac 2d 3h 4s 5c 6d 7h')), 'Straight, Seven high');
  });

  test('a flush beats a straight when both are present', () => {
    const seven = hand('5c 6c 7c 8d 9c Ac 2h'); // 5-9 straight, and a club flush
    assert.equal(categoryOf(evaluate(seven)), CATEGORY.FLUSH);
  });

  test('paired board does not turn a flush into a full house', () => {
    const seven = hand('Ac Kc 9c 5c 2c 7d 7h');
    assert.equal(categoryOf(evaluate(seven)), CATEGORY.FLUSH);
  });

  test('two sets of trips make a full house using the lower as the pair', () => {
    const seven = hand('9c 9d 9h 5s 5c 5d 2h');
    assert.equal(describeHand(seven), 'Full house, Nines over Fives');
  });

  test('trips plus two pair uses the higher pair', () => {
    const seven = hand('9c 9d 9h 5s 5c Kd Kh');
    assert.equal(describeHand(seven), 'Full house, Nines over Kings');
  });

  test('three pair plays the top two with the third pair as kicker', () => {
    const seven = hand('Kc Kd 9h 9s 5c 5d 2h');
    const five = bestFive(seven);
    assert.equal(describeHand(seven), 'Two pair, Kings and Nines');
    // The kicker must be the five, not the second five of the third pair.
    assert.equal(evaluate(seven), evaluate(hand('Kc Kd 9h 9s 5c')));
    assert.equal(five.length, 5);
  });

  test('kickers decide otherwise-identical hands', () => {
    const a = hand('Ac Ad Kh 7s 5c');
    const b = hand('Ah As Qh 7d 5s');
    assert.ok(evaluate(a) > evaluate(b), 'king kicker beats queen kicker');
  });

  test('the board playing gives an exact tie', () => {
    const board = 'Ac Kc Qc Jc Tc';
    assert.equal(evaluate(hand(`${board} 2h 3d`)), evaluate(hand(`${board} 7s 8h`)));
  });

  test('bestFive really is the best five', () => {
    const seven = hand('Ac Kc Qc Jc Tc 2h 3d');
    assert.equal(evaluate(bestFive(seven)), evaluate(seven));
  });

  test('quads on board with a higher kicker in hand', () => {
    const withAce = hand('7c 7d 7h 7s 2c Ad 3h');
    const withKing = hand('7c 7d 7h 7s 2c Kd 3h');
    assert.ok(evaluate(withAce) > evaluate(withKing));
    assert.equal(describeHand(withAce), 'Four Sevens');
  });

  test('the deck is 52 distinct cards', () => {
    const deck = freshDeck();
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck).size, 52);
  });

  test('the best five out of seven always matches the seven-card score', () => {
    const rng = makeRng(20260809);
    for (let trial = 0; trial < 20000; trial++) {
      const seven = shuffle(freshDeck(), rng).slice(0, 7);
      const s = evaluate(seven);
      const cat = categoryOf(s);
      assert.ok(cat >= 0 && cat <= CATEGORY.STRAIGHT_FLUSH, `category ${cat}`);
      // The fast path and the exhaustive 21-combination search must agree, or
      // one of the shortcuts in evaluate() is wrong.
      assert.equal(evaluate(bestFive(seven)), s, `mismatch on ${seven.map(cardName).join(' ')}`);
    }
  });

  test('adding cards can never make a hand worse', () => {
    const rng = makeRng(4242);
    for (let trial = 0; trial < 5000; trial++) {
      const seven = shuffle(freshDeck(), rng).slice(0, 7);
      assert.ok(evaluate(seven) >= evaluate(seven.slice(0, 6)));
      assert.ok(evaluate(seven.slice(0, 6)) >= evaluate(seven.slice(0, 5)));
    }
  });
});

// --------------------------------------------------------------- side pots --

describe('side pots', () => {
  const P = (id, totalCommitted, folded = false) => ({ id, totalCommitted, folded });

  test('a simple contested pot is one layer', () => {
    const { pots, refunds } = buildPots([P('a', 100), P('b', 100)]);
    assert.equal(pots.length, 1);
    assert.equal(pots[0].amount, 200);
    assert.deepEqual(pots[0].eligible, ['a', 'b']);
    assert.deepEqual(refunds, {});
  });

  test('a short all-in creates a side pot the short stack cannot win', () => {
    const { pots } = buildPots([P('short', 50), P('a', 200), P('b', 200)]);
    assert.equal(pots.length, 2);
    assert.deepEqual(pots[0], { amount: 150, eligible: ['short', 'a', 'b'] });
    assert.deepEqual(pots[1], { amount: 300, eligible: ['a', 'b'] });
  });

  test('an uncalled bet comes straight back', () => {
    const { pots, refunds } = buildPots([P('shover', 500), P('caller', 120)]);
    assert.deepEqual(refunds, { shover: 380 });
    assert.equal(pots.length, 1);
    assert.equal(pots[0].amount, 240);
  });

  test("a folded player's chips stay in the pot but they cannot win it", () => {
    const { pots } = buildPots([P('a', 100), P('b', 100), P('c', 100, true)]);
    assert.equal(pots.length, 1);
    assert.equal(pots[0].amount, 300);
    assert.deepEqual(pots[0].eligible, ['a', 'b']);
  });

  test('dead money above every live player folds into the pot below', () => {
    // c bet 300 and folded to a re-raise; a and b were all-in for 100.
    const { pots, refunds } = buildPots([P('a', 100), P('b', 100), P('c', 300, true)]);
    assert.deepEqual(refunds, { c: 200 });
    assert.equal(pots.length, 1);
    assert.equal(pots[0].amount, 300);
    assert.deepEqual(pots[0].eligible, ['a', 'b']);
  });

  test('three all-ins at three levels make three pots', () => {
    const { pots } = buildPots([P('a', 100), P('b', 250), P('c', 400), P('d', 400)]);
    assert.deepEqual(
      pots.map((p) => [p.amount, p.eligible.join('')]),
      [
        [400, 'abcd'],
        [450, 'bcd'],
        [300, 'cd'],
      ],
    );
  });

  test('chips are conserved for any commitment set', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let trial = 0; trial < 3000; trial++) {
      const n = 2 + Math.floor(rand() * 8);
      const players = Array.from({ length: n }, (_, i) =>
        P(`p${i}`, Math.floor(rand() * 500), rand() < 0.4),
      );
      // At least one player must survive to the end of a real hand.
      players[0].folded = false;
      const total = players.reduce((t, p) => t + p.totalCommitted, 0);
      const { pots, refunds } = buildPots(players);
      const out =
        pots.reduce((t, p) => t + p.amount, 0) +
        Object.values(refunds).reduce((t, v) => t + v, 0);
      assert.equal(out, total, 'chips created or destroyed');
      for (const pot of pots) assert.ok(pot.eligible.length > 0, 'unwinnable pot');
    }
  });

  test('awards go to the best hand in each pot independently', () => {
    const { pots } = buildPots([P('short', 50), P('a', 200), P('b', 200)]);
    // The short stack has the best hand but can only win what they paid for.
    const { won } = awardPots(pots, { short: 900, a: 500, b: 100 }, ['short', 'a', 'b']);
    assert.equal(won.short, 150);
    assert.equal(won.a, 300);
    assert.equal(won.b, undefined);
  });

  test('a tie splits, and the odd chip goes left of the button', () => {
    const { pots } = buildPots([P('a', 25), P('b', 25), P('c', 25)]);
    assert.equal(pots[0].amount, 75);
    const { won } = awardPots(pots, { a: 500, b: 500, c: 1 }, ['b', 'c', 'a']);
    // b is first left of the button, so b gets the odd chip.
    assert.equal(won.b, 38);
    assert.equal(won.a, 37);
    assert.equal(won.b + won.a, 75);
  });
});

// ---------------------------------------------------------- betting rounds --

function seat(id, stack) {
  return {
    id,
    stack,
    folded: false,
    allIn: false,
    hasActed: false,
    committedThisRound: 0,
    totalCommitted: 0,
    lastAction: null,
  };
}

describe('betting', () => {
  test('minimum raise is the size of the last raise', () => {
    const seats = [seat('a', 1000), seat('b', 1000)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 60 });
    // A bet of 60 sets the last full raise to 60, so the minimum re-raise is 120.
    assert.equal(legalActions(round, seats[1]).minRaiseTo, 120);
    assert.equal(applyAction(round, seats, seats[1], { type: 'raise', to: 119 }).error, 'raise_too_small');
    assert.ok(!applyAction(round, seats, seats[1], { type: 'raise', to: 120 }).error);
  });

  test('a short all-in does not re-open the betting to a player who has acted', () => {
    // a bets 100, b calls, c is all-in for 130 — 30 short of a full raise.
    const seats = [seat('a', 1000), seat('b', 1000), seat('c', 130)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 100 });
    applyAction(round, seats, seats[1], { type: 'call' });
    const shove = applyAction(round, seats, seats[2], { type: 'raise', to: 130 });
    assert.equal(shove.full, false, 'an incomplete raise must not count as a full one');

    // a and b have both acted and face only 30 against a full raise of 100.
    for (const s of [seats[0], seats[1]]) {
      const legal = legalActions(round, s);
      assert.equal(legal.raise, false, `${s.id} must not be able to re-raise`);
      assert.equal(legal.call, true);
      assert.equal(legal.callAmount, 30);
    }
    assert.equal(applyAction(round, seats, seats[0], { type: 'raise', to: 400 }).error, 'cannot_raise');
  });

  test('a player who has not yet acted can raise over a short all-in', () => {
    const seats = [seat('a', 1000), seat('b', 1000), seat('c', 130), seat('d', 1000)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 100 });
    applyAction(round, seats, seats[1], { type: 'call' });
    applyAction(round, seats, seats[2], { type: 'raise', to: 130 });
    // d has not acted this round at all, so their action is intact.
    const legal = legalActions(round, seats[3]);
    assert.equal(legal.raise, true);
    // The minimum is still measured from the last FULL raise of 100, on top of
    // the current bet of 130.
    assert.equal(legal.minRaiseTo, 230);
  });

  test('a full raise gives everyone their action back', () => {
    const seats = [seat('a', 1000), seat('b', 1000), seat('c', 1000)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 100 });
    applyAction(round, seats, seats[1], { type: 'call' });
    assert.equal(seats[1].hasActed, true);
    applyAction(round, seats, seats[2], { type: 'raise', to: 300 });
    assert.equal(seats[0].hasActed, false);
    assert.equal(seats[1].hasActed, false);
    assert.equal(legalActions(round, seats[1]).raise, true);
  });

  test('an all-in below the minimum is legal; anything else below is not', () => {
    const seats = [seat('a', 1000), seat('b', 55)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 40 });
    const legal = legalActions(round, seats[1]);
    assert.equal(legal.minRaiseTo, 55, 'clamped to the stack');
    assert.ok(!applyAction(round, seats, seats[1], { type: 'raise', to: 55 }).error);
    assert.equal(seats[1].allIn, true);
  });

  test('a raise beyond the stack is clamped rather than rejected', () => {
    const seats = [seat('a', 1000), seat('b', 200)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[1], { type: 'raise', to: 99999 });
    assert.equal(seats[1].stack, 0);
    assert.equal(round.currentBet, 200);
  });

  test('you cannot check into a bet, or call nothing', () => {
    const seats = [seat('a', 1000), seat('b', 1000)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    assert.equal(applyAction(round, seats, seats[0], { type: 'call' }).error, 'nothing_to_call');
    applyAction(round, seats, seats[0], { type: 'raise', to: 60 });
    assert.equal(applyAction(round, seats, seats[1], { type: 'check' }).error, 'cannot_check');
  });

  test('the round is not complete while anyone is short of the current bet', () => {
    const seats = [seat('a', 1000), seat('b', 1000), seat('c', 130)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 100 });
    applyAction(round, seats, seats[1], { type: 'call' });
    applyAction(round, seats, seats[2], { type: 'raise', to: 130 });
    assert.equal(roundComplete(round, seats), false, 'a and b still owe 30');
    applyAction(round, seats, seats[0], { type: 'call' });
    assert.equal(roundComplete(round, seats), false);
    applyAction(round, seats, seats[1], { type: 'call' });
    assert.equal(roundComplete(round, seats), true);
  });

  test('the big blind gets an option when the pot is only limped', () => {
    const seats = [seat('btn', 1000), seat('sb', 1000), seat('bb', 1000)];
    const round = openRound(seats, { currentBet: 20, minBet: 20 });
    postChips(seats[1], 10);
    postChips(seats[2], 20);
    applyAction(round, seats, seats[0], { type: 'call' });
    applyAction(round, seats, seats[1], { type: 'call' });
    assert.equal(roundComplete(round, seats), false, 'the blind has not acted yet');
    const legal = legalActions(round, seats[2]);
    assert.equal(legal.check, true, 'the blind may check their option');
    assert.equal(legal.raise, true, 'the blind may also raise it');
    applyAction(round, seats, seats[2], { type: 'check' });
    assert.equal(roundComplete(round, seats), true);
  });

  test('folded and all-in players are never asked to act again', () => {
    const seats = [seat('a', 1000), seat('b', 100), seat('c', 1000)];
    const round = openRound(seats, { currentBet: 0, minBet: 20 });
    applyAction(round, seats, seats[0], { type: 'raise', to: 100 });
    applyAction(round, seats, seats[1], { type: 'call' }); // all-in
    applyAction(round, seats, seats[2], { type: 'fold' });
    assert.equal(roundComplete(round, seats), true);
    assert.equal(legalActions(round, seats[1]).fold, false);
  });
});

// ------------------------------------------------------------- game module --

function makeRoom(count, config = {}) {
  const players = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    tok: `t${i}`,
    name: `P${i}`,
    seat: i,
    left: false,
  }));
  const room = {
    code: 'BCDF',
    gameId: 'holdem',
    hostId: 'p0',
    phase: 'playing',
    players,
    scores: {},
    config: holdem.normalizeConfig({ ...holdem.defaultConfig, ...config }),
    game: null,
    lastResult: null,
    seq: 0,
  };
  room.game = holdem.start(room, 987654321, 1_000_000);
  return room;
}

const actorSeat = (room) => room.game.seats[room.game.actor];

/**
 * Every chip in the tournament. Between hands the pot has already been pushed
 * back into stacks while `totalCommitted` still records what went in, so
 * counting both there would double the money.
 */
const chipTotal = (room) => {
  const inPlay = room.game.seats.reduce((t, s) => t + s.stack, 0);
  if (room.game.phase !== 'hand') return inPlay;
  return inPlay + room.game.seats.reduce((t, s) => t + s.totalCommitted, 0);
};

/**
 * Drive the table until `done(room)` or the step budget runs out.
 *
 * Every loop here is bounded on purpose. An unbounded "play until the hand
 * ends" loop turns a rules bug into a hung test run instead of a failure, and
 * a hung run tells you nothing about which rule broke.
 */
function drive(room, choose, { done, steps = 500, tick = 1000 } = {}) {
  let now = 2_000_000;
  for (let step = 0; step < steps; step++) {
    if (done(room)) return { steps: step, finished: true };
    now += tick;
    const g = room.game;
    if (g.phase === 'over') break;
    if (g.phase === 'handover') {
      holdem.onDeadline(room, now);
      continue;
    }
    const s = actorSeat(room);
    assert.ok(s, 'the table has a clock but nobody on it');
    const legal = legalActions(g.round, s);
    const act = choose(legal, s, step, room);
    const outcome = holdem.action(room, s.id, { type: 'act', ...act }, now);
    assert.ok(!outcome.error, `illegal action ${JSON.stringify(act)}: ${outcome.error}`);
  }
  return { finished: done(room) };
}

/** Never puts a chip in voluntarily. */
const passive = (legal) => (legal.check ? { move: 'check' } : { move: 'fold' });
/** Sees every street as cheaply as possible. */
const callingStation = (legal) => (legal.check ? { move: 'check' } : { move: 'call' });
/** Gets chips moving so busts and side pots actually happen. */
const maniac = (legal) =>
  legal.raise ? { move: 'raise', to: legal.maxRaiseTo } : legal.check ? { move: 'check' } : { move: 'call' };

describe('hold’em', () => {
  test('is registered and reachable through the picker', () => {
    assert.ok(GAMES.holdem, 'holdem must be in the registry');
    assert.equal(GAMES.holdem.meta.familiar, 'Poker');
  });

  test('deals two cards each from one deck with no duplicates', () => {
    const room = makeRoom(6);
    const all = room.game.seats.flatMap((s) => s.hole);
    assert.equal(all.length, 12);
    assert.equal(new Set(all).size, 12, 'a card was dealt twice');
  });

  test('blinds are posted and the big blind is the bet to match', () => {
    const room = makeRoom(6);
    const g = room.game;
    assert.equal(g.seats[g.sbIndex].totalCommitted, 10);
    assert.equal(g.seats[g.bbIndex].totalCommitted, 20);
    assert.equal(g.round.currentBet, 20);
    assert.equal(g.round.lastFullRaiseSize, 20);
  });

  test('preflop action starts left of the big blind', () => {
    const room = makeRoom(6);
    const g = room.game;
    const expected = (g.bbIndex + 1) % g.seats.length;
    assert.equal(g.actor, expected);
  });

  test('heads-up, the button posts the small blind and acts first preflop', () => {
    const room = makeRoom(2);
    const g = room.game;
    assert.equal(g.sbIndex, g.buttonIndex, 'the button is the small blind heads-up');
    assert.equal(g.actor, g.buttonIndex, 'and acts first before the flop');
  });

  test('heads-up, the big blind acts first after the flop', () => {
    const room = makeRoom(2);
    const g = room.game;
    drive(room, callingStation, { done: (r) => r.game.street === 'flop', steps: 6 });
    assert.equal(g.street, 'flop');
    assert.equal(g.actor, g.bbIndex, 'the non-button acts first postflop');
  });

  test('only the player on the clock may act', () => {
    const room = makeRoom(4);
    const other = room.game.seats[(room.game.actor + 1) % 4].id;
    assert.equal(holdem.action(room, other, { type: 'act', move: 'fold' }, 2e6).error, 'not_your_turn');
  });

  test('a fold to one player ends the hand without a showdown', () => {
    const room = makeRoom(4);
    const g = room.game;
    const r = drive(room, () => ({ move: 'fold' }), { done: (x) => x.game.phase !== 'hand', steps: 8 });
    assert.ok(r.finished);
    assert.equal(g.phase, 'handover');
    assert.equal(g.result.showdown, false);
    for (const s of g.result.shown) assert.equal(s.hole, null, 'cards must not be shown');
  });

  test('the winner of an uncontested pot collects the blinds', () => {
    const room = makeRoom(3);
    const g = room.game;
    const start = room.config.startingStack;
    drive(room, () => ({ move: 'fold' }), { done: (x) => x.game.phase !== 'hand', steps: 8 });
    const bb = g.seats[g.bbIndex];
    assert.equal(bb.stack, start + 10, 'the big blind picks up the small blind');
  });

  test('chips are conserved on every single step of a tournament', () => {
    const room = makeRoom(5, { blindMinutes: 0 });
    const total = 5 * room.config.startingStack;
    // Mixed policy so the run produces real side pots rather than one long
    // chain of limped pots.
    const mixed = (legal, seat, step) =>
      step % 5 === 0 ? maniac(legal) : step % 3 === 0 ? passive(legal) : callingStation(legal);
    const r = drive(room, mixed, {
      done: (x) => {
        assert.equal(chipTotal(x), total, 'chips created or destroyed');
        return x.game.phase === 'over';
      },
      steps: 4000,
    });
    assert.ok(r.finished, 'the tournament must actually finish');
    assert.equal(room.game.seats.filter((s) => s.stack > 0).length, 1);
    assert.equal(chipTotal(room), total);
  });

  test('every player gets a distinct finishing place', () => {
    const room = makeRoom(4, { blindMinutes: 0 });
    drive(room, maniac, { done: (x) => x.game.phase === 'over', steps: 4000 });
    assert.equal(room.game.phase, 'over');
    const places = room.game.over.standings.map((s) => s.place).sort((a, b) => a - b);
    assert.deepEqual(places, [1, 2, 3, 4]);
    assert.equal(room.game.over.winner, room.game.seats.find((s) => s.stack > 0).id);
  });

  test('the clock folds when there is a bet to face', () => {
    const room = makeRoom(4);
    const g = room.game;
    const first = actorSeat(room).id;
    holdem.onDeadline(room, g.deadline + 1);
    assert.equal(g.seats.find((s) => s.id === first).folded, true);
  });

  test('the clock never folds a hand that could be checked for free', () => {
    const room = makeRoom(4);
    const g = room.game;
    drive(room, callingStation, { done: (x) => x.game.street === 'flop', steps: 20 });
    assert.equal(g.street, 'flop', 'need a free street to test against');
    const onClock = actorSeat(room).id;
    holdem.onDeadline(room, g.deadline + 1);
    assert.equal(g.seats.find((s) => s.id === onClock).folded, false, 'must not fold a free hand');
  });

  test('blinds climb between hands, never during one', () => {
    const room = makeRoom(4, { blindMinutes: 1 });
    const g = room.game;
    assert.equal(g.level, 0);
    const later = g.levelEndsAt + 1;
    for (let i = 0; i < 8 && g.phase === 'hand'; i++) {
      holdem.action(room, actorSeat(room).id, { type: 'act', move: 'fold' }, later);
    }
    assert.equal(g.phase, 'handover');
    assert.equal(g.level, 0, 'the level must not move mid-hand');
    holdem.onDeadline(room, later);
    assert.equal(g.level, 1, 'and must move on the next deal');
    assert.equal(g.round.currentBet, 30, 'the new big blind is the bet to match');
  });

  test('a busted player is not dealt into the next hand', () => {
    const room = makeRoom(3, { blindMinutes: 0, startingStack: 500 });
    // A stack of 0 mid-hand means all-in, not busted — `place` is the only
    // signal that someone is actually out.
    drive(room, maniac, {
      done: (x) => x.game.phase === 'hand' && x.game.seats.some((s) => s.place !== null),
      steps: 3000,
    });
    const busted = room.game.seats.filter((s) => s.place !== null);
    assert.ok(busted.length >= 1, 'nobody ever busted');
    if (room.game.phase === 'hand') {
      for (const s of busted) assert.equal(s.inHand, false, 'a busted player was dealt in');
      assert.equal(
        room.game.seats.flatMap((s) => s.hole).length,
        room.game.seats.filter((s) => s.inHand).length * 2,
        'a busted player was dealt cards',
      );
    }
  });

  test('a side pot really does pay the short stack only what they paid for', () => {
    const room = makeRoom(3, { blindMinutes: 0 });
    const g = room.game;
    // Force a genuine three-way all-in at three different stack sizes.
    g.seats[0].stack = 100;
    g.seats[1].stack = 400;
    g.seats[2].stack = 1000;
    drive(room, maniac, { done: (x) => x.game.phase !== 'hand', steps: 30 });
    const paid = g.result.pots.reduce((t, p) => t + p.amount, 0);
    const refunded = Object.values(g.result.refunds).reduce((t, v) => t + v, 0);
    assert.equal(paid + refunded, g.seats.reduce((t, s) => t + s.totalCommitted, 0));
    // Whatever happened, the 100-chip stack can never end up with more than
    // three times what they put in.
    assert.ok(g.seats[0].stack <= 300, `short stack won ${g.seats[0].stack}`);
  });
});

// ---------------------------------------------------------------- leakage --

describe('hold’em information leaks', () => {
  test('no view ever contains the deck', () => {
    const room = makeRoom(6);
    for (const p of room.players) {
      const view = holdem.viewFor(room, p.id);
      assert.equal(JSON.stringify(view).includes('"deck"'), false);
    }
  });

  test('you see your own two cards and nobody else’s', () => {
    const room = makeRoom(6);
    for (const p of room.players) {
      const view = holdem.viewFor(room, p.id);
      const mine = view.seats.find((s) => s.id === p.id);
      assert.equal(mine.hole.length, 2);
      for (const s of view.seats) {
        if (s.id === p.id) continue;
        assert.equal(s.hole, null, `${p.id} can see ${s.id}'s cards`);
        assert.equal(s.cardCount, 2, 'but should still see that they hold two');
      }
    }
  });

  test('a spectator with no seat sees no cards at all', () => {
    const room = makeRoom(4);
    const view = holdem.viewFor(room, 'nobody');
    for (const s of view.seats) assert.equal(s.hole, null);
    assert.equal(view.myTurn, false);
    assert.equal(view.legal, null);
  });

  test('cards stay hidden when the hand ends without a showdown', () => {
    const room = makeRoom(4);
    drive(room, () => ({ move: 'fold' }), { done: (x) => x.game.phase !== 'hand', steps: 8 });
    const winner = room.game.seats.find((s) => s.inHand && !s.folded);
    const view = holdem.viewFor(room, room.players.find((p) => p.id !== winner.id).id);
    assert.equal(view.seats.find((s) => s.id === winner.id).hole, null);
  });

  test('cards are turned face up for everyone at a showdown', () => {
    const room = makeRoom(3, { blindMinutes: 0 });
    const g = room.game;
    // Everyone calls all the way down to the river.
    drive(room, callingStation, { done: (x) => x.game.phase !== 'hand', steps: 40 });
    assert.equal(g.result.showdown, true);
    const view = holdem.viewFor(room, room.players[0].id);
    for (const s of view.seats.filter((x) => x.inHand && !x.folded)) {
      assert.equal(s.hole.length, 2, 'showdown cards must be visible');
      assert.ok(s.handName, 'and named');
    }
  });

  test('the legal-action set is computed for the viewer, not the actor', () => {
    const room = makeRoom(5);
    const onClock = actorSeat(room).id;
    for (const p of room.players) {
      const view = holdem.viewFor(room, p.id);
      assert.equal(view.myTurn, p.id === onClock);
      assert.equal(view.legal === null, p.id !== onClock);
    }
  });
});
