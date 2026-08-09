/**
 * Nightfall tests.
 *
 * Focused on night resolution, because that is where every Werewolf
 * implementation goes wrong: actions must be collected then resolved in one
 * pass, deaths must cascade deterministically, and the win check must run
 * exactly once at the end rather than mid-cascade.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as nightfall from '../src/games/nightfall.js';
import { GAMES } from '../src/games/index.js';

function makeRoom(count, config = {}, seed = 999) {
  const players = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, tok: `t${i}`, name: `P${i}`, seat: i, left: false,
  }));
  const room = {
    code: 'BCDF', gameId: 'nightfall', hostId: 'p0', phase: 'playing',
    players, scores: {}, game: null, lastResult: null, seq: 0,
    config: nightfall.normalizeConfig({ ...nightfall.defaultConfig, ...config }),
  };
  room.game = nightfall.start(room, seed, 1_000_000);
  return room;
}

/** Force a known role layout so tests are about rules, not about the shuffle. */
function setRoles(room, mapping) {
  room.game.roles = { ...mapping };
  return room;
}

const ackAll = (room) => {
  for (const p of room.players) nightfall.action(room, p.id, { type: 'ack' }, 1);
};

describe('nightfall setup', () => {
  test('wolf count follows the official ratio', () => {
    assert.equal(nightfall.wolfCount(5), 1);
    assert.equal(nightfall.wolfCount(7), 1);
    assert.equal(nightfall.wolfCount(8), 2);
    assert.equal(nightfall.wolfCount(11), 2);
    assert.equal(nightfall.wolfCount(12), 3);
    assert.equal(nightfall.wolfCount(18), 4);
  });

  test('every seat is dealt exactly one role at every legal size', () => {
    for (let n = 5; n <= 16; n++) {
      const room = makeRoom(n);
      const roles = Object.values(room.game.roles);
      assert.equal(roles.length, n, `@${n}`);
      assert.equal(roles.filter((r) => r === 'WOLF').length, nightfall.wolfCount(n), `wolves @${n}`);
      assert.ok(roles.every((r) => r in nightfall.ROLE_INFO), `unknown role @${n}`);
    }
  });

  test('there is always at least one non-wolf more than wolves at setup', () => {
    for (let n = 5; n <= 16; n++) {
      const roles = Object.values(makeRoom(n).game.roles);
      const wolves = roles.filter((r) => r === 'WOLF').length;
      assert.ok(roles.length - wolves > wolves, `game starts already won @${n}`);
    }
  });

  test('wolves see each other and nobody else does', () => {
    const room = makeRoom(8);
    const g = room.game;
    const wolves = g.order.filter((id) => g.roles[id] === 'WOLF');
    for (const w of wolves) {
      const view = nightfall.viewFor(room, w);
      assert.deepEqual(view.packmates.sort(), wolves.filter((x) => x !== w).sort());
    }
    const villager = g.order.find((id) => g.roles[id] !== 'WOLF');
    assert.equal(nightfall.viewFor(room, villager).packmates.length, 0);
    assert.equal(nightfall.viewFor(room, villager).reveal, null, 'roles must not leak mid-game');
  });
});

describe('nightfall night resolution', () => {
  function nightRoom() {
    // 5 players: one wolf, seer, doctor, witch, hunter — one of everything.
    const room = makeRoom(5);
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'HUNTER' });
    ackAll(room);
    return room;
  }

  test('a doctor save cancels the kill entirely, and the save is not announced', () => {
    const room = nightRoom();
    nightfall.action(room, 'p2', { type: 'protect', target: 'p4' }, 1);
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: false, poison: null }, 1);
    assert.equal(room.game.alive.p4, true, 'protected player survives');
    assert.deepEqual(room.game.lastNight.deaths, []);
    // Nothing in a non-doctor's view says a save happened.
    const view = nightfall.viewFor(room, 'p1');
    assert.equal(view.lastNight.saved, true);
    assert.deepEqual(view.lastNight.deaths, [], 'only who died is published');
  });

  test('the seer gets an answer even when the target dies the same night', () => {
    const room = nightRoom();
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    assert.equal(room.game.seerResults.p0, true, 'alignment is static and order-independent');
    nightfall.action(room, 'p2', { type: 'protect', target: 'p1' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p3' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: false, poison: null }, 1);
    assert.equal(nightfall.viewFor(room, 'p1').seerResults.p0, true);
  });

  test('seer results reach the seer and nobody else', () => {
    const room = nightRoom();
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    assert.deepEqual(nightfall.viewFor(room, 'p1').seerResults, { p0: true });
    for (const other of ['p0', 'p2', 'p3', 'p4']) {
      assert.deepEqual(nightfall.viewFor(room, other).seerResults, {}, other);
    }
  });

  test('the doctor may not protect the same player two nights running', () => {
    const room = nightRoom();
    room.game.lastProtected = 'p4';
    assert.equal(nightfall.action(room, 'p2', { type: 'protect', target: 'p4' }, 1).error, 'repeat_target');
    assert.equal(nightfall.action(room, 'p2', { type: 'protect', target: 'p3' }, 1).error, undefined);
  });

  test('witch poison kills through the doctor’s protection', () => {
    const room = nightRoom();
    nightfall.action(room, 'p2', { type: 'protect', target: 'p1' }, 1);
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p2' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: false, poison: 'p1' }, 1);
    assert.equal(room.game.alive.p1, false, 'protection is against the wolf attack only');
    assert.equal(room.game.alive.p2, false, 'the wolf kill also lands');
  });

  test('the witch can heal and poison on the same night', () => {
    const room = nightRoom();
    nightfall.action(room, 'p2', { type: 'protect', target: 'p2' }, 1);
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p1' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: true, poison: 'p4' }, 1);
    assert.equal(room.game.alive.p1, true, 'healed');
    assert.equal(room.game.alive.p4, false, 'poisoned');
  });

  test('each potion is once per game', () => {
    const room = nightRoom();
    room.game.witch.healUsed = true;
    assert.equal(nightfall.action(room, 'p3', { type: 'witch', heal: true }, 1).error, 'potion_spent');
    room.game.witch.poisonUsed = true;
    assert.equal(nightfall.action(room, 'p3', { type: 'witch', poison: 'p1' }, 1).error, 'potion_spent');
  });

  test('the witch is shown the wolves’ victim, and only the witch is', () => {
    const room = nightRoom();
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    assert.equal(nightfall.viewFor(room, 'p3').witchVictim, 'p4');
    for (const other of ['p1', 'p2', 'p4']) {
      assert.equal(nightfall.viewFor(room, other).witchVictim, null, other);
    }
  });

  test('wolves cannot eat wolves', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    assert.equal(nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p1' }, 1).error, 'bad_target');
  });

  test('a deadlocked wolf pack kills nobody', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    nightfall.action(room, 'p2', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p3', { type: 'protect', target: 'p2' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    nightfall.action(room, 'p1', { type: 'wolfKill', target: 'p5' }, 1);
    assert.equal(room.game.phase, 'day', 'the night still resolves');
    assert.deepEqual(room.game.lastNight.deaths, [], 'a tie means no kill');
  });

  test('wolf votes are visible to wolves only', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    assert.deepEqual(nightfall.viewFor(room, 'p1').wolfVotes, { p0: 'p4' });
    assert.deepEqual(nightfall.viewFor(room, 'p4').wolfVotes, {}, 'the victim learns nothing');
  });

  test('a villager cannot submit another role’s night action', () => {
    const room = nightRoom();
    assert.equal(nightfall.action(room, 'p4', { type: 'wolfKill', target: 'p1' }, 1).error, 'not_a_wolf');
    assert.equal(nightfall.action(room, 'p4', { type: 'inspect', target: 'p1' }, 1).error, 'not_seer');
    assert.equal(nightfall.action(room, 'p4', { type: 'protect', target: 'p1' }, 1).error, 'not_doctor');
    assert.equal(nightfall.action(room, 'p4', { type: 'witch', heal: true }, 1).error, 'not_witch');
  });
});

describe('nightfall hunter cascade', () => {
  test('a hunter killed at night suspends the game until they shoot', () => {
    const room = makeRoom(5);
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'HUNTER' });
    ackAll(room);
    nightfall.action(room, 'p2', { type: 'protect', target: 'p1' }, 1);
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: false, poison: null }, 1);
    assert.equal(room.game.phase, 'hunter');
    assert.equal(room.game.pendingHunter.shooter, 'p4');
    // The view flattens it to just the shooter id, which is all a client needs.
    assert.equal(nightfall.viewFor(room, 'p1').pendingHunter, 'p4');
  });

  test('the hunter can shoot the last wolf and win it for the village', () => {
    const room = makeRoom(5);
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'HUNTER' });
    ackAll(room);
    nightfall.action(room, 'p2', { type: 'protect', target: 'p1' }, 1);
    nightfall.action(room, 'p1', { type: 'inspect', target: 'p0' }, 1);
    nightfall.action(room, 'p0', { type: 'wolfKill', target: 'p4' }, 1);
    nightfall.action(room, 'p3', { type: 'witch', heal: false, poison: null }, 1);
    nightfall.action(room, 'p4', { type: 'hunterShoot', target: 'p0' }, 1);
    assert.equal(room.game.over?.winner, 'VILLAGE');
    assert.equal(room.game.over?.reason, 'WOLVES_DEAD');
  });

  test('only the dying hunter may take the shot', () => {
    const room = makeRoom(5);
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'HUNTER' });
    ackAll(room);
    room.game.phase = 'hunter';
    room.game.pendingHunter = { shooter: 'p4', resume: 'night' };
    assert.equal(nightfall.action(room, 'p1', { type: 'hunterShoot', target: 'p0' }, 1).error, 'not_hunter');
  });

  test('a hunter lynched by day shoots, then play continues to night', () => {
    const room = makeRoom(7);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'HUNTER', p3: 'VILLAGER',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER',
    });
    ackAll(room);
    room.game.phase = 'day';
    room.game.dayVotes = {};
    for (const id of room.game.order) nightfall.action(room, id, { type: 'dayVote', target: 'p2' }, 1);
    assert.equal(room.game.phase, 'hunter', 'the lynched hunter gets their shot');
    nightfall.action(room, 'p2', { type: 'hunterShoot', target: 'p3' }, 1);
    assert.equal(room.game.alive.p3, false);
    assert.equal(room.game.phase, 'night', 'and then the night begins');
  });
});

describe('nightfall day and win conditions', () => {
  test('a tie hangs nobody', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    room.game.phase = 'day';
    const order = room.game.order;
    order.forEach((id, i) => nightfall.action(room, id, { type: 'dayVote', target: i % 2 ? 'p4' : 'p5' }, 1));
    assert.equal(room.game.lastDay.lynched, null);
    assert.equal(room.game.alive.p4, true);
    assert.equal(room.game.alive.p5, true);
  });

  test('day votes are private until they resolve', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    room.game.phase = 'day';
    nightfall.action(room, 'p0', { type: 'dayVote', target: 'p4' }, 1);
    const view = nightfall.viewFor(room, 'p1');
    assert.deepEqual(view.dayVoted, ['p0'], 'who has voted is public');
    assert.deepEqual(view.dayVotes, {}, 'how they voted is not');
    assert.equal(nightfall.viewFor(room, 'p0').myDayVote, 'p4', 'you can see your own');
  });

  test('the dead do not vote', () => {
    const room = makeRoom(8);
    ackAll(room);
    room.game.phase = 'day';
    room.game.alive.p3 = false;
    assert.equal(nightfall.action(room, 'p3', { type: 'dayVote', target: 'p1' }, 1).error, 'you_are_dead');
  });

  test('wolves win at parity, not only at extinction', () => {
    const room = makeRoom(5);
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'VILLAGER' });
    ackAll(room);
    // Two wolves would be needed for a 2v2; instead drop to 1 wolf vs 1 other.
    room.game.alive.p1 = false;
    room.game.alive.p2 = false;
    room.game.phase = 'day';
    for (const id of ['p0', 'p3', 'p4']) nightfall.action(room, id, { type: 'dayVote', target: 'p3' }, 1);
    assert.equal(room.game.over?.winner, 'WOLF', '1 wolf vs 1 villager is parity');
  });

  test('parity can be turned off for a play-to-the-end variant', () => {
    const room = makeRoom(5, { parityWin: false });
    setRoles(room, { p0: 'WOLF', p1: 'SEER', p2: 'DOCTOR', p3: 'WITCH', p4: 'VILLAGER' });
    ackAll(room);
    room.game.alive.p1 = false;
    room.game.alive.p2 = false;
    room.game.phase = 'day';
    for (const id of ['p0', 'p3', 'p4']) nightfall.action(room, id, { type: 'dayVote', target: 'p3' }, 1);
    assert.equal(room.game.over, null, 'the game continues to the last villager');
  });

  test('the discussion timer closes the vote on whatever is in', () => {
    const room = makeRoom(8);
    setRoles(room, {
      p0: 'WOLF', p1: 'WOLF', p2: 'SEER', p3: 'DOCTOR',
      p4: 'VILLAGER', p5: 'VILLAGER', p6: 'VILLAGER', p7: 'VILLAGER',
    });
    ackAll(room);
    room.game.phase = 'day';
    for (const id of ['p0', 'p1', 'p2']) nightfall.action(room, id, { type: 'dayVote', target: 'p4' }, 1);
    nightfall.onDeadline(room, Date.now());
    assert.equal(room.game.lastDay.lynched, 'p4', 'a plurality of cast votes decides it');
  });

  test('dead players’ roles are revealed only when the option is on', () => {
    const shown = makeRoom(6, { revealRoleOnDeath: true });
    shown.game.alive.p2 = false;
    assert.ok(nightfall.viewFor(shown, 'p0').deadRoles.p2, 'role shown on death');

    const hidden = makeRoom(6, { revealRoleOnDeath: false });
    hidden.game.alive.p2 = false;
    assert.deepEqual(nightfall.viewFor(hidden, 'p0').deadRoles, {}, 'and hidden when off');
  });

  test('a full game reaches a winner from any seed without throwing', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const room = makeRoom(7, {}, seed);
      ackAll(room);
      const g = room.game;
      for (let guard = 0; guard < 200 && !g.over; guard++) {
        if (g.phase === 'night') {
          for (const id of g.order.filter((x) => g.alive[x])) {
            const role = g.roles[id];
            const others = g.order.filter((x) => g.alive[x] && x !== id);
            if (role === 'WOLF') {
              const prey = others.find((x) => g.roles[x] !== 'WOLF');
              nightfall.action(room, id, { type: 'wolfKill', target: prey ?? null }, 1);
            } else if (role === 'SEER') {
              nightfall.action(room, id, { type: 'inspect', target: others[0] }, 1);
            } else if (role === 'DOCTOR') {
              const pick = others.find((x) => x !== g.lastProtected) ?? others[0];
              nightfall.action(room, id, { type: 'protect', target: pick }, 1);
            } else if (role === 'WITCH') {
              nightfall.action(room, id, { type: 'witch', heal: false, poison: null }, 1);
            }
          }
        } else if (g.phase === 'hunter') {
          const shooter = g.pendingHunter.shooter;
          const target = g.order.find((x) => g.alive[x] && x !== shooter);
          nightfall.action(room, shooter, { type: 'hunterShoot', target }, 1);
        } else if (g.phase === 'day') {
          const alive = g.order.filter((x) => g.alive[x]);
          for (const id of alive) nightfall.action(room, id, { type: 'dayVote', target: alive[0] }, 1);
        } else {
          break;
        }
      }
      assert.ok(g.over, `seed ${seed} never terminated (phase ${g.phase})`);
      assert.ok(['VILLAGE', 'WOLF'].includes(g.over.winner), `seed ${seed} bad winner`);
    }
  });
});

describe('nightfall registry', () => {
  test('is registered and every seat gets a view at every size', () => {
    assert.ok(GAMES.nightfall);
    for (let n = 5; n <= 16; n++) {
      const room = makeRoom(n);
      for (const p of room.players) {
        assert.doesNotThrow(() => GAMES.nightfall.viewFor(room, p.id), `@${n}`);
      }
    }
  });
});
