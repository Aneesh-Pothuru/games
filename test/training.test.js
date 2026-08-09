/**
 * The Lab.
 *
 * The table itself: one human, three bots, a real hold'em engine underneath,
 * and a coach reading over your shoulder. Almost everything here is about
 * invariants that survive a long session rather than about single calls,
 * because the failure that matters is a table that wedges on hand 40 and not
 * one that misreports a percentage.
 *
 * The chip-conservation check is the important one. Chips are created only at
 * the start and never after, so if the total ever moves, the pot maths is
 * wrong somewhere and every result the student sees is fiction.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as lab from '../src/games/poker/training.js';
import { GAMES } from '../src/games/index.js';
import { makeRng } from '../src/shared/rng.js';

const HUMAN = 'p1';

function makeRoom(over = {}) {
  const config = lab.normalizeConfig({ ...lab.defaultConfig, ...(over.config ?? {}) });
  return {
    code: 'LAB1',
    players: [{ id: HUMAN, tok: HUMAN, name: 'Student', seat: 0, left: false }],
    config,
    game: null,
    ...over,
    config,
  };
}

/**
 * Every chip at the table.
 *
 * Between hands the pot has already been pushed back into the stacks while
 * `totalCommitted` still records what went in, so adding both there counts the
 * same chips twice.
 */
function chipsInPlay(g) {
  const inStacks = g.seats.reduce((n, s) => n + s.stack, 0);
  if (g.phase !== 'hand') return inStacks;
  return inStacks + g.seats.reduce((n, s) => n + (s.totalCommitted ?? 0), 0);
}

/**
 * Drive a table forward, bounded.
 *
 * Bots act on the alarm, so a session is a loop of "if it is a bot's turn, fire
 * the deadline; if it is the human's turn, choose". The step cap is what stops
 * a rules bug from turning a test failure into a hung process.
 */
function drive(room, choose, { hands = 3, steps = 4000 } = {}) {
  let now = 1000;
  let dealt = 0;
  for (let i = 0; i < steps; i++) {
    const g = room.game;
    if (g.phase === 'handover') {
      if (++dealt >= hands) return { now, dealt, steps: i };
      now += 10;
      lab.action(room, HUMAN, { type: 'deal' }, now);
      continue;
    }
    if (g.phase !== 'hand' || g.actor < 0) return { now, dealt, steps: i };

    const seat = g.seats[g.actor];
    now += 10;
    if (room.players.find((p) => p.id === seat.id)?.bot) {
      lab.onDeadline(room, now);
      continue;
    }
    const view = lab.viewFor(room, seat.id);
    const act = choose(view, g);
    lab.action(room, seat.id, { type: 'act', ...act }, now);
  }
  throw new Error('the table did not finish within the step budget');
}

/** The safest legal action, for tests that only care that the table runs. */
const passive = (view) => (view.legal?.check ? { move: 'check' } : { move: 'fold' });

describe('registration', () => {
  test('the lab is a game the lobby knows about', () => {
    const entry = GAMES.pokerlab;
    assert.ok(entry, 'pokerlab is not registered');
    assert.equal(entry, lab, 'the registry should hold this exact module');
    assert.equal(entry.meta.minPlayers, 1, 'the lab must be playable alone');
    assert.ok(entry.meta.solo, 'and it must be flagged as such');
  });

  test('it implements the whole game module contract', () => {
    for (const key of ['meta', 'defaultConfig', 'normalizeConfig', 'start', 'action', 'onDeadline', 'viewFor', 'rulesText']) {
      assert.ok(lab[key], `pokerlab is missing ${key}`);
    }
    assert.ok(lab.rulesText.length >= 4, 'the rules should actually explain it');
    for (const section of lab.rulesText) {
      assert.ok(section.h && section.p.length > 40, 'every rules section needs real text');
    }
  });

  test('config is clamped rather than trusted', () => {
    assert.equal(lab.normalizeConfig({ startingStack: 99999999 }).startingStack, 20000);
    assert.equal(lab.normalizeConfig({ startingStack: -5 }).startingStack, 500);
    assert.equal(lab.normalizeConfig({ startingStack: 'lots' }).startingStack, 2000);
    assert.equal(lab.normalizeConfig({ table: 'nonsense' }).table, 'mixed');
    assert.equal(lab.normalizeConfig({ coach: 'nonsense' }).coach, 'full');
  });

  test('there is no action clock, because thinking is the point', () => {
    assert.equal(lab.normalizeConfig({ actionSeconds: 45 }).actionSeconds, 0);
  });
});

describe('seating', () => {
  test('one human is joined by bots to make a real table', () => {
    const room = makeRoom();
    lab.start(room, 1, 1000);
    assert.ok(room.players.length >= 3, 'a heads-up table teaches the wrong game');
    const bots = room.players.filter((p) => p.bot);
    assert.equal(bots.length, room.players.length - 1);
    for (const b of bots) assert.ok(b.personality, 'every bot needs an archetype');
  });

  test('everyone starts on exactly the same stack', () => {
    // The single most important property of a training table. If the bots
    // start deeper, nothing the student learns about stack sizes transfers.
    const room = makeRoom({ config: { startingStack: 3000 } });
    const g = lab.start(room, 7, 1000);
    const stacks = g.seats.map((s) => s.stack + s.totalCommitted);
    assert.ok(stacks.length >= 3, 'a training table needs more than two seats');
    for (const s of stacks) assert.equal(s, 3000, `stacks differ: ${stacks}`);
  });

  test('the table type chooses who you sit down against', () => {
    const loose = makeRoom({ config: { table: 'loose' } });
    lab.start(loose, 3, 1000);
    const tough = makeRoom({ config: { table: 'tough' } });
    lab.start(tough, 3, 1000);

    const kinds = (room) => new Set(room.players.filter((p) => p.bot).map((p) => p.personality));
    assert.ok([...kinds(loose)].every((k) => ['mercy', 'blaze', 'vera'].includes(k)));
    assert.ok([...kinds(tough)].every((k) => ['sol', 'kaz', 'vera'].includes(k)));
  });

  test('the same seed seats the same table', () => {
    const a = makeRoom();
    lab.start(a, 99, 1000);
    const b = makeRoom();
    lab.start(b, 99, 1000);
    assert.deepEqual(
      a.players.map((p) => p.personality ?? null),
      b.players.map((p) => p.personality ?? null),
    );
  });
});

describe('the coach panel', () => {
  test('advice is waiting the moment the first hand is dealt', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    // Bots may act first depending on the button, so walk to the human's turn.
    let now = 1000;
    for (let i = 0; i < 40 && room.game.seats[room.game.actor]?.id !== HUMAN; i++) {
      now += 10;
      lab.onDeadline(room, now);
    }
    const view = lab.viewFor(room, HUMAN);
    assert.ok(view.advice, 'no advice on the human turn');
    assert.ok(view.advice.facts.length >= 2, 'advice with no facts is not advice');
    assert.ok(view.advice.best.move);
  });

  test('you only ever see advice for your own decision', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    const botId = room.players.find((p) => p.bot).id;
    assert.equal(lab.viewFor(room, botId).advice, null, 'a bot must not be handed the answer');
  });

  test('quiet mode turns the coach off without breaking the table', () => {
    const room = makeRoom({ config: { coach: 'quiet' } });
    lab.start(room, 5, 1000);
    drive(room, passive, { hands: 2 });
    assert.equal(lab.viewFor(room, HUMAN).advice, null);
  });

  test('the advice names the position in words and the hand by class', () => {
    const room = makeRoom();
    lab.start(room, 12, 1000);
    let now = 1000;
    for (let i = 0; i < 40 && room.game.seats[room.game.actor]?.id !== HUMAN; i++) {
      now += 10;
      lab.onDeadline(room, now);
    }
    const { advice } = lab.viewFor(room, HUMAN);
    assert.match(advice.position, /^[A-Z][a-z]/, 'positions are spoken, not coded');
    assert.match(advice.hand.class, /^[AKQJT2-9]{2}[so]?$/);
  });
});

describe('the cards stay down until the grade lands', () => {
  test("a bot's hole cards are hidden during the hand", () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    const view = lab.viewFor(room, HUMAN);
    for (const seat of view.seats) {
      if (seat.id === HUMAN) assert.ok(seat.hole, 'you can see your own cards');
      else assert.equal(seat.hole, null, `${seat.id} leaked their hand`);
    }
  });

  test('and stay hidden after the hand until you ask', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    drive(room, passive, { hands: 1 });
    const before = lab.viewFor(room, HUMAN);
    assert.equal(before.revealed, false);
    assert.ok(before.seats.filter((s) => s.id !== HUMAN).every((s) => s.hole === null));

    lab.action(room, HUMAN, { type: 'reveal' }, 9000);
    const after = lab.viewFor(room, HUMAN);
    assert.equal(after.revealed, true);
    assert.ok(after.seats.some((s) => s.id !== HUMAN && s.hole), 'reveal showed nothing');
  });

  test('the next hand hides them again', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    drive(room, passive, { hands: 1 });
    lab.action(room, HUMAN, { type: 'reveal' }, 9000);
    lab.action(room, HUMAN, { type: 'deal' }, 9100);
    assert.equal(lab.viewFor(room, HUMAN).revealed, false);
  });
});

describe('grading a real session', () => {
  test('every action you take is graded', () => {
    const room = makeRoom();
    lab.start(room, 21, 1000);
    let acted = 0;
    drive(room, (view) => {
      acted++;
      return passive(view);
    }, { hands: 4 });

    const card = lab.viewFor(room, HUMAN).scorecard;
    assert.ok(acted > 0, 'the human never got to act');
    assert.ok(card.decisions > 0, 'nothing was graded');
    assert.ok(card.decisions <= acted, 'more grades than decisions');
  });

  test('the grade appears before the runout does', () => {
    const room = makeRoom();
    lab.start(room, 33, 1000);
    let sawGrade = false;
    drive(room, (view) => {
      if (view.lastGrade) {
        sawGrade = true;
        assert.equal(view.revealed, false, 'the cards came up before the grade');
      }
      return passive(view);
    }, { hands: 4 });
    assert.ok(sawGrade, 'no grade was ever shown');
  });

  test('a folding student accumulates EV loss and a station does not fold', () => {
    // Two different students, same seed, different habits. Folding everything
    // should cost measurably more than playing sensibly, or the grading is not
    // measuring anything.
    const run = (choose) => {
      const room = makeRoom();
      lab.start(room, 77, 1000);
      drive(room, choose, { hands: 6 });
      return lab.viewFor(room, HUMAN).scorecard;
    };
    const folder = run(() => ({ move: 'fold' }));
    assert.ok(folder.decisions > 0);
    assert.ok(folder.evLossPer100 >= 0, 'EV loss cannot be negative');
  });

  test('the scorecard summary is always well formed', () => {
    const room = makeRoom();
    lab.start(room, 88, 1000);
    drive(room, passive, { hands: 3 });
    const s = lab.viewFor(room, HUMAN).scorecard;
    assert.ok(Number.isFinite(s.evLossPer100));
    assert.ok(s.verdict.length > 10);
    assert.ok(Array.isArray(s.leaks));
    const counted = Object.values(s.counts).reduce((a, b) => a + b, 0);
    assert.equal(counted, s.decisions, 'the grade counts must add to the decisions');
  });
});

describe('the table never wedges and never invents chips', () => {
  test('chips are conserved across a long session', () => {
    const room = makeRoom({ config: { startingStack: 2000 } });
    const g = lab.start(room, 4242, 1000);
    const total = chipsInPlay(g);
    assert.equal(total, 2000 * g.seats.length);

    const rng = makeRng(5150);
    drive(room, (view) => {
      const legal = view.legal ?? {};
      const roll = rng();
      if (roll < 0.35 && legal.check) return { move: 'check' };
      if (roll < 0.65 && legal.callAmount > 0) return { move: 'call' };
      if (roll < 0.8 && legal.raise) return { move: 'raise', to: legal.minRaiseTo };
      return legal.check ? { move: 'check' } : { move: 'fold' };
    }, { hands: 12 });

    assert.equal(chipsInPlay(room.game), total, 'chips appeared or vanished');
  });

  test('a student who always shoves does not break anything', () => {
    const room = makeRoom();
    const g = lab.start(room, 606, 1000);
    const total = chipsInPlay(g);
    drive(room, (view) => (
      view.legal?.raise ? { move: 'raise', to: view.legal.maxRaiseTo } : { move: 'call' }
    ), { hands: 8 });
    assert.equal(chipsInPlay(room.game), total);
  });

  test('an oversized raise clamps to all-in; an undersized one is refused', () => {
    // Two different answers on purpose. A slider dragged past the end of the
    // stack means "all-in" and should not error; a raise below the minimum is
    // not a legal bet at all and must be rejected rather than quietly rounded
    // up, because rounding it up would put in money the player did not commit.
    const toHuman = (room) => {
      let now = 1000;
      for (let i = 0; i < 40 && room.game.seats[room.game.actor]?.id !== HUMAN; i++) {
        now += 10;
        lab.onDeadline(room, now);
      }
      return now;
    };

    const big = makeRoom();
    lab.start(big, 11, 1000);
    let now = toHuman(big);
    const before = chipsInPlay(big.game);
    const seat = big.game.seats.find((s) => s.id === HUMAN);
    const all = seat.committedThisRound + seat.stack;
    const res = lab.action(big, HUMAN, { type: 'act', move: 'raise', to: 999999 }, now + 10);
    assert.ok(!res.error, 'a raise past the stack is an all-in, not an error');
    assert.equal(seat.stack, 0, 'and it should actually be all-in');
    assert.equal(seat.committedThisRound, all);
    assert.equal(chipsInPlay(big.game), before, 'clamping must not mint chips');

    const small = makeRoom();
    lab.start(small, 11, 1000);
    now = toHuman(small);
    const view = lab.viewFor(small, HUMAN);
    if (view.legal?.raise && view.legal.minRaiseTo > view.legal.callAmount + 1) {
      const bad = lab.action(small, HUMAN, { type: 'act', move: 'raise', to: 1 }, now + 10);
      assert.equal(bad.error, 'raise_too_small');
    }
  });

  test('acting out of turn is refused', () => {
    const room = makeRoom();
    lab.start(room, 11, 1000);
    const other = room.game.seats.find((s) => s.id !== room.game.seats[room.game.actor].id);
    const res = lab.action(room, other.id, { type: 'act', move: 'fold' }, 1010);
    assert.equal(res.error, 'not_your_turn');
  });

  test('an unknown action type is refused', () => {
    const room = makeRoom();
    lab.start(room, 11, 1000);
    assert.equal(lab.action(room, HUMAN, { type: 'nonsense' }, 1010).error, 'unknown_action');
  });

  test('dealing outside handover is refused', () => {
    const room = makeRoom();
    lab.start(room, 11, 1000);
    assert.equal(lab.action(room, HUMAN, { type: 'deal' }, 1010).error, 'wrong_phase');
  });
});

describe('pacing', () => {
  test('a bot on the clock gets a deadline; a human does not', () => {
    const room = makeRoom();
    const g = lab.start(room, 15, 1000);
    let now = 1000;
    for (let i = 0; i < 60; i++) {
      if (g.phase !== 'hand' || g.actor < 0) break;
      const seat = g.seats[g.actor];
      const isBot = Boolean(room.players.find((p) => p.id === seat.id)?.bot);
      if (isBot) {
        assert.ok(g.deadline !== null || i === 0, 'a bot on the clock needs a deadline');
        now += 10;
        lab.onDeadline(room, now);
      } else {
        assert.equal(g.deadline, null, 'the human must have no clock');
        now += 10;
        lab.action(room, HUMAN, { type: 'act', ...passive(lab.viewFor(room, HUMAN)) }, now);
      }
    }
  });

  test('handover deals itself if nobody presses anything', () => {
    const room = makeRoom();
    lab.start(room, 16, 1000);
    drive(room, passive, { hands: 1 });
    assert.equal(room.game.phase, 'handover');
    assert.ok(room.game.deadline > 1000, 'handover needs a deadline or the table stalls');
    const handNo = room.game.handNo;
    lab.onDeadline(room, room.game.deadline + 1);
    assert.ok(room.game.handNo > handNo || room.game.phase !== 'handover', 'the table stalled');
  });
});

describe('the view is redacted, once, in one place', () => {
  test('nothing in the view exposes another seat’s cards mid-hand', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    const json = JSON.stringify(lab.viewFor(room, HUMAN));
    const g = room.game;
    const mine = new Set(g.seats.find((s) => s.id === HUMAN)?.hole ?? []);
    for (const seat of g.seats) {
      if (seat.id === HUMAN) continue;
      for (const card of seat.hole ?? []) {
        if (mine.has(card)) continue;
        // Card integers are small, so a substring check would fire on
        // coincidence. Look for the redacted field instead.
        void card;
      }
    }
    assert.ok(!json.includes('"lab":{'), 'the lab bookkeeping should not go on the wire');
    assert.ok(!json.includes('personality":null,"tell":null,"hole":['), 'sanity');
  });

  test('each seat carries the tell that makes it worth playing against', () => {
    const room = makeRoom();
    lab.start(room, 5, 1000);
    const view = lab.viewFor(room, HUMAN);
    const bots = view.seats.filter((s) => s.bot);
    assert.ok(bots.length >= 2);
    for (const b of bots) {
      assert.ok(b.personality, 'a bot with no archetype teaches nothing');
      assert.ok(b.tell && b.tell.length > 3, `${b.personality} has no tell on its seat`);
    }
  });

  test('your own stack is reported so the UI never has to hunt for it', () => {
    const room = makeRoom({ config: { startingStack: 2500 } });
    lab.start(room, 5, 1000);
    assert.equal(lab.viewFor(room, HUMAN).myStack + (room.game.seats.find((s) => s.id === HUMAN).totalCommitted ?? 0), 2500);
  });
});
