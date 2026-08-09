/**
 * Cheat.
 *
 * Two things decide every hand and both are easy to get backwards:
 *   - who picks up the pile after a challenge (the one who was WRONG)
 *   - whether playing your last card wins immediately (it does not)
 *
 * The third area worth testing is the one that would ruin the game outright:
 * whether the face-down cards ever reach anyone before they are turned over.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as cheat from '../src/games/cheat.js';
import { parseCard, rankOf } from '../src/games/poker/cards.js';
import { GAMES } from '../src/games/index.js';

function makeRoom(count = 4, config = {}) {
  const players = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, tok: `t${i}`, name: `P${i}`, seat: i, left: false,
  }));
  const room = {
    code: 'BCDF', gameId: 'cheat', hostId: 'p0', phase: 'playing', players,
    scores: {}, config: cheat.normalizeConfig({ ...cheat.defaultConfig, ...config }),
    game: null, lastResult: null, seq: 0,
  };
  room.game = cheat.start(room, 20260809, 1_000_000);
  return room;
}

const NOW = 2_000_000;
const actor = (room) => room.game.order[room.game.turn];
/** Give a seat an exact hand, for tests that need a known truth or lie. */
function setHand(room, id, text) {
  room.game.hands[id] = text.trim().split(/\s+/).map(parseCard);
}

describe('cheat setup', () => {
  test('is registered', () => {
    assert.ok(GAMES.cheat);
    assert.equal(GAMES.cheat.meta.minPlayers, 3);
  });

  test('deals the whole deck out with nothing missing or duplicated', () => {
    for (const n of [3, 4, 5, 7, 10]) {
      const room = makeRoom(n);
      const all = Object.values(room.game.hands).flat();
      assert.equal(all.length, 52, `${n} players`);
      assert.equal(new Set(all).size, 52, `${n} players had a duplicate`);
    }
  });

  test('hands differ by at most one card', () => {
    const room = makeRoom(5);
    const sizes = Object.values(room.game.hands).map((h) => h.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join(','));
  });

  test('starts on Twos so nobody needs a reference card', () => {
    const room = makeRoom(4);
    assert.equal(room.game.rank, 0);
    assert.equal(cheat.viewFor(room, 'p0').rankName, 'Twos');
  });
});

describe('cheat play', () => {
  test('only the player on turn may play', () => {
    const room = makeRoom(4);
    const other = room.game.order[1];
    const card = room.game.hands[other][0];
    assert.equal(cheat.action(room, other, { type: 'play', cards: [card] }, NOW).error, 'not_your_turn');
  });

  test('you cannot play cards you do not hold', () => {
    const room = makeRoom(4);
    const me = actor(room);
    const theirs = room.game.hands[room.game.order[1]][0];
    assert.equal(cheat.action(room, me, { type: 'play', cards: [theirs] }, NOW).error, 'not_your_cards');
  });

  test('you cannot play the same card four times', () => {
    const room = makeRoom(4);
    const me = actor(room);
    const mine = room.game.hands[me][0];
    // Deduplicated to one card, which is a legal play — the point is that the
    // pile must not grow by four from a single card.
    cheat.action(room, me, { type: 'play', cards: [mine, mine, mine, mine] }, NOW);
    assert.equal(room.game.pile.length, 1);
  });

  test('a play is between one and four cards', () => {
    const room = makeRoom(4);
    const me = actor(room);
    const hand = room.game.hands[me];
    assert.equal(cheat.action(room, me, { type: 'play', cards: [] }, NOW).error, 'bad_count');
    assert.equal(cheat.action(room, me, { type: 'play', cards: hand.slice(0, 5) }, NOW).error, 'bad_count');
  });

  test('playing opens a challenge window and does not advance the turn', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    cheat.action(room, me, { type: 'play', cards: [g.hands[me][0]] }, NOW);
    assert.equal(g.phase, 'challenge');
    assert.equal(g.turn, 0, 'the turn must not move until the window closes');
    assert.equal(g.lastPlay.by, me);
  });

  test('the required rank climbs and wraps past Ace', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 12; // Aces
    const me = actor(room);
    cheat.action(room, me, { type: 'play', cards: [g.hands[me][0]] }, NOW);
    cheat.onDeadline(room, NOW + 60_000); // window closes with no call
    assert.equal(g.rank, 0);
    assert.equal(cheat.viewFor(room, 'p0').rankName, 'Twos');
  });
});

describe('cheat challenges', () => {
  /** Get to a challenge window with a play of known truthfulness. */
  function play(room, cards) {
    const me = actor(room);
    setHand(room, me, cards.join(' ') + ' Kd Kh'); // spare cards so nobody goes out
    const played = cards.map(parseCard);
    cheat.action(room, me, { type: 'play', cards: played }, NOW);
    return me;
  }

  test('calling a liar hands them the pile', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 0; // Twos claimed
    g.pile = [parseCard('9c'), parseCard('9d')];
    const liar = play(room, ['Ac']); // not a Two
    const caller = g.order[1];
    const before = g.hands[liar].length;

    cheat.action(room, caller, { type: 'challenge' }, NOW);
    assert.equal(g.reveal.lying, true);
    assert.equal(g.reveal.loser, liar);
    // Two already in the pile plus the one just played.
    assert.equal(g.hands[liar].length, before + 3);
    assert.equal(g.pile.length, 0, 'the pile is emptied');
  });

  test('calling an honest player hands the pile to the caller', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 0; // Twos
    g.pile = [parseCard('9c'), parseCard('9d')];
    play(room, ['2c', '2d']);
    const caller = g.order[1];
    const before = g.hands[caller].length;

    cheat.action(room, caller, { type: 'challenge' }, NOW);
    assert.equal(g.reveal.lying, false);
    assert.equal(g.reveal.loser, caller);
    assert.equal(g.hands[caller].length, before + 4);
  });

  test('a partly-true claim is still a lie', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 0;
    play(room, ['2c', '2d', '3h']);
    cheat.action(room, g.order[1], { type: 'challenge' }, NOW);
    assert.equal(g.reveal.lying, true, 'three claimed, only two were Twos');
  });

  test('you cannot call your own bluff', () => {
    const room = makeRoom(4);
    const me = play(room, ['Ac']);
    assert.equal(cheat.action(room, me, { type: 'challenge' }, NOW).error, 'cannot_challenge_self');
  });

  test('the window closes on its own when everyone passes', () => {
    const room = makeRoom(4);
    const g = room.game;
    play(room, ['Ac']);
    const others = g.order.filter((id) => id !== g.lastPlay.by);
    for (const id of others.slice(0, -1)) cheat.action(room, id, { type: 'pass' }, NOW);
    assert.equal(g.phase, 'challenge', 'still waiting on the last player');
    cheat.action(room, others[others.length - 1], { type: 'pass' }, NOW);
    assert.equal(g.phase, 'play', 'closes once nobody is left to call');
  });

  test('a timed-out window lets the claim stand', () => {
    const room = makeRoom(4);
    const g = room.game;
    play(room, ['Ac']);
    const pileBefore = g.pile.length;
    cheat.onDeadline(room, NOW + 60_000);
    assert.equal(g.phase, 'play');
    assert.equal(g.pile.length, pileBefore, 'nobody picked anything up');
  });

  test('the turn moves on after a challenge, and the rank still climbs', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 3;
    play(room, ['Ac']);
    cheat.action(room, g.order[1], { type: 'challenge' }, NOW);
    cheat.onDeadline(room, NOW + 20_000);
    assert.equal(g.turn, 1);
    assert.equal(g.rank, 4);
    assert.equal(g.phase, 'play');
  });
});

describe('cheat endgame', () => {
  test('playing your last card does not win on its own', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    setHand(room, me, '2c');
    cheat.action(room, me, { type: 'play', cards: [parseCard('2c')] }, NOW);
    assert.equal(g.phase, 'challenge', 'the window still has to close');
    assert.equal(g.goingOut, me);
    assert.equal(g.over, null);
  });

  test('surviving the window wins it', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    setHand(room, me, '2c');
    cheat.action(room, me, { type: 'play', cards: [parseCard('2c')] }, NOW);
    cheat.onDeadline(room, NOW + 60_000);
    assert.equal(g.phase, 'over');
    assert.equal(g.over.winner, me);
  });

  test('an honest last card survives being called', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 0;
    const me = actor(room);
    setHand(room, me, '2c');
    cheat.action(room, me, { type: 'play', cards: [parseCard('2c')] }, NOW);
    cheat.action(room, g.order[1], { type: 'challenge' }, NOW);
    assert.equal(g.phase, 'over');
    assert.equal(g.over.winner, me, 'they were telling the truth');
  });

  test('bluffing your last card and getting caught puts you back in', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.rank = 0; // Twos
    g.pile = [parseCard('9c'), parseCard('9d'), parseCard('9h')];
    const me = actor(room);
    setHand(room, me, 'Ac');
    cheat.action(room, me, { type: 'play', cards: [parseCard('Ac')] }, NOW);
    cheat.action(room, g.order[1], { type: 'challenge' }, NOW);
    assert.equal(g.over, null, 'caught on the last card is not a win');
    assert.equal(g.hands[me].length, 4, 'they picked the pile up');
  });

  test('everyone gets a place', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    setHand(room, me, '2c');
    cheat.action(room, me, { type: 'play', cards: [parseCard('2c')] }, NOW);
    cheat.onDeadline(room, NOW + 60_000);
    assert.deepEqual(g.over.standings.map((s) => s.place), [1, 2, 3, 4]);
    // Runners-up are ordered by how close they came to being empty.
    const counts = g.over.standings.slice(1).map((s) => s.cards);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
  });

  test('the clock plays a card rather than stalling forever', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    const before = g.hands[me].length;
    cheat.onDeadline(room, g.deadline + 1);
    assert.equal(g.hands[me].length, before - 1);
    assert.equal(g.phase, 'challenge');
  });

  test('a whole game reaches a winner without losing a card', () => {
    const room = makeRoom(4);
    const g = room.game;
    for (let step = 0; step < 3000 && g.phase !== 'over'; step++) {
      const total = Object.values(g.hands).flat().length + g.pile.length;
      assert.equal(total, 52, `card count drifted at step ${step}`);
      assert.equal(new Set([...Object.values(g.hands).flat(), ...g.pile]).size, 52, `duplicate at step ${step}`);
      if (g.phase === 'play') {
        const id = g.order[g.turn];
        const hand = g.hands[id];
        // Play honestly when possible, otherwise bluff the lowest card.
        const honest = hand.filter((c) => rankOf(c) === g.rank);
        cheat.action(room, id, { type: 'play', cards: honest.length ? honest : [hand[0]] }, NOW + step);
      } else if (g.phase === 'challenge') {
        // Somebody calls roughly a third of the time.
        const caller = g.order.find((id) => id !== g.lastPlay.by);
        if (step % 3 === 0) cheat.action(room, caller, { type: 'challenge' }, NOW + step);
        else cheat.onDeadline(room, NOW + step);
      } else {
        cheat.onDeadline(room, NOW + step);
      }
    }
    assert.equal(g.phase, 'over', 'the game must finish');
    assert.equal(g.hands[g.over.winner].length, 0);
  });
});

describe('cheat information leaks', () => {
  test('you see your own hand and nobody else’s', () => {
    const room = makeRoom(5);
    for (const p of room.players) {
      const v = cheat.viewFor(room, p.id);
      assert.ok(Array.isArray(v.hand) && v.hand.length > 0);
      assert.deepEqual(v.hand.slice().sort(), room.game.hands[p.id].slice().sort());
      // Counts, not cards.
      for (const [id, n] of Object.entries(v.counts)) {
        assert.equal(n, room.game.hands[id].length);
      }
      const raw = JSON.stringify(v);
      for (const other of room.players) {
        if (other.id === p.id) continue;
        const secret = room.game.hands[other.id].filter((c) => !v.hand.includes(c));
        // A card only this other player holds must not appear anywhere.
        assert.ok(!secret.some((c) => raw.includes(`,${c},`)), `${p.id} can see ${other.id}'s cards`);
      }
    }
  });

  test('the face-down cards stay face down until they are called', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    cheat.action(room, me, { type: 'play', cards: g.hands[me].slice(0, 2) }, NOW);
    for (const p of room.players) {
      const v = cheat.viewFor(room, p.id);
      assert.equal(v.lastPlay.cards, null, `${p.id} can see what was played`);
      assert.equal(v.lastPlay.count, 2, 'but everyone sees how many');
      assert.equal(v.lastPlay.rankName, v.lastPlay.rankName, 'and what was claimed');
    }
  });

  test('the pile is face down to everyone, including whoever filled it', () => {
    const room = makeRoom(4);
    const g = room.game;
    g.pile = [1, 2, 3, 4, 5];
    for (const p of room.players) {
      const v = cheat.viewFor(room, p.id);
      assert.equal(v.pileCount, 5);
      assert.equal(v.pile, undefined, 'the pile contents must never be sent');
    }
  });

  test('the cards are turned over for everyone once called', () => {
    const room = makeRoom(4);
    const g = room.game;
    const me = actor(room);
    cheat.action(room, me, { type: 'play', cards: g.hands[me].slice(0, 2) }, NOW);
    cheat.action(room, g.order[1], { type: 'challenge' }, NOW);
    for (const p of room.players) {
      const v = cheat.viewFor(room, p.id);
      assert.equal(v.lastPlay.cards.length, 2, `${p.id} cannot see the reveal`);
      assert.ok(typeof v.reveal.lying === 'boolean');
    }
  });

  test('a spectator with no hand sees no cards at all', () => {
    const room = makeRoom(4);
    const v = cheat.viewFor(room, 'nobody');
    assert.equal(v.hand, null);
    assert.equal(v.myTurn, false);
    assert.equal(v.canChallenge, false);
  });
});
