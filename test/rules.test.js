/**
 * Rules-engine tests.
 *
 * These target the specific rules that implementations habitually get wrong,
 * plus the information-leak boundary, which is the one class of bug that
 * silently ruins a game night rather than crashing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as council from '../src/games/council.js';
import * as sabotage from '../src/games/sabotage.js';
import * as oddoneout from '../src/games/oddoneout.js';
import * as spectrum from '../src/games/spectrum.js';
import { GAMES } from '../src/games/index.js';
import { LOCATIONS } from '../src/content/locations.js';
import { SPECTRUMS } from '../src/content/spectrums.js';
import { generateRoomCode, normalizeRoomCode, isValidRoomCode, sanitizeName, CODE_ALPHABET } from '../src/shared/codes.js';
import { makeRng, shuffle } from '../src/shared/rng.js';

function makeRoom(gameId, count, config = {}) {
  const players = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    tok: `t${i}`,
    name: `P${i}`,
    seat: i,
    left: false,
  }));
  const room = {
    code: 'BCDF',
    gameId,
    hostId: 'p0',
    phase: 'playing',
    players,
    scores: {},
    config: { ...GAMES[gameId].defaultConfig, ...config },
    game: null,
    lastResult: null,
    seq: 0,
  };
  room.config = GAMES[gameId].normalizeConfig(room.config);
  room.game = GAMES[gameId].start(room, 12345, 1_000_000);
  return room;
}

// --------------------------------------------------------------- room codes --

describe('room codes', () => {
  test('alphabet has no vowels and no L', () => {
    for (const c of 'AEIOUL') assert.ok(!CODE_ALPHABET.includes(c), `${c} must be excluded`);
  });

  test('generated codes are always valid', () => {
    for (let i = 0; i < 500; i++) assert.ok(isValidRoomCode(generateRoomCode()));
  });

  test('generation is unbiased across the alphabet', () => {
    const counts = new Map();
    for (let i = 0; i < 20000; i++) {
      for (const ch of generateRoomCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const expected = 80000 / CODE_ALPHABET.length;
    for (const ch of CODE_ALPHABET) {
      const n = counts.get(ch) ?? 0;
      // A plain `% 20` on a byte would skew the first 16 letters by ~6%.
      assert.ok(Math.abs(n - expected) / expected < 0.08, `${ch} skewed: ${n} vs ${expected}`);
    }
  });

  test('normalize strips junk without inventing a different room', () => {
    assert.equal(normalizeRoomCode(' bc-df '), 'BCDF');
    assert.equal(normalizeRoomCode('b1c2d3f'), 'BCDF');
    // "O" is not in the alphabet and must be dropped, never folded to D.
    assert.equal(normalizeRoomCode('BOCD'), 'BCD');
  });

  test('names are stripped of zero-width and bidi spoofing characters', () => {
    assert.equal(sanitizeName('  Sam​‮  '), 'Sam');
    assert.equal(sanitizeName('a'.repeat(50)).length, 14);
    assert.equal(sanitizeName(null), '');
  });
});

// ------------------------------------------------------------------- council --

describe('council (Secret Hitler rules)', () => {
  test('role distribution matches the official table for every count', () => {
    const expected = {
      5: [3, 1, 1], 6: [4, 1, 1], 7: [4, 2, 1], 8: [5, 2, 1], 9: [5, 3, 1], 10: [6, 3, 1],
    };
    for (const [count, [stewards, cabal, architect]] of Object.entries(expected)) {
      const room = makeRoom('council', Number(count));
      const roles = Object.values(room.game.roles);
      assert.equal(roles.filter((r) => r === 'STEWARD').length, stewards, `stewards @${count}`);
      assert.equal(roles.filter((r) => r === 'CABAL').length, cabal, `cabal @${count}`);
      assert.equal(roles.filter((r) => r === 'ARCHITECT').length, architect, `architect @${count}`);
    }
  });

  test('policy deck is 6 charters and 11 decrees', () => {
    const room = makeRoom('council', 7);
    assert.equal(room.game.draw.filter((t) => t === 'CHARTER').length, 6);
    assert.equal(room.game.draw.filter((t) => t === 'DECREE').length, 11);
  });

  test('the architect knows the cabal only at 5-6 players', () => {
    for (const count of [5, 6]) {
      const room = makeRoom('council', count);
      const architect = Object.keys(room.game.roles).find((id) => room.game.roles[id] === 'ARCHITECT');
      assert.equal(council.viewFor(room, architect).known.length, 1, `@${count}`);
    }
    for (const count of [7, 8, 9, 10]) {
      const room = makeRoom('council', count);
      const architect = Object.keys(room.game.roles).find((id) => room.game.roles[id] === 'ARCHITECT');
      assert.equal(council.viewFor(room, architect).known.length, 0, `@${count}`);
    }
  });

  test('the cabal always sees its partners and the architect', () => {
    const room = makeRoom('council', 9);
    const cabal = Object.keys(room.game.roles).filter((id) => room.game.roles[id] === 'CABAL');
    // 3 cabal at 9 players: each sees 2 partners + the architect.
    assert.equal(council.viewFor(room, cabal[0]).known.length, 3);
  });

  test('a steward never learns anybody', () => {
    const room = makeRoom('council', 8);
    const steward = Object.keys(room.game.roles).find((id) => room.game.roles[id] === 'STEWARD');
    const view = council.viewFor(room, steward);
    assert.equal(view.known.length, 0);
    assert.equal(view.reveal, null, 'roles must not leak before the game ends');
  });

  test('board powers match the official layout for each board size', () => {
    assert.deepEqual(council.viewFor(makeRoom('council', 5), 'p0').powers,
      [null, null, 'FORESIGHT', 'PURGE', 'PURGE', null]);
    assert.deepEqual(council.viewFor(makeRoom('council', 7), 'p0').powers,
      [null, 'AUDIT', 'SESSION', 'PURGE', 'PURGE', null]);
    assert.deepEqual(council.viewFor(makeRoom('council', 9), 'p0').powers,
      ['AUDIT', 'AUDIT', 'SESSION', 'PURGE', 'PURGE', null]);
  });

  test('a tied vote fails and advances the tracker', () => {
    const room = makeRoom('council', 6);
    const g = room.game;
    for (const p of room.players) council.action(room, p.id, { type: 'ack' });
    const target = council.eligibleDeputies(g)[0];
    council.action(room, g.speaker, { type: 'nominate', target });
    room.players.forEach((p, i) => council.action(room, p.id, { type: 'vote', value: i % 2 ? 'YES' : 'NO' }));
    assert.equal(g.tracker, 1, 'a 3-3 tie must fail');
    assert.equal(g.phase, 'nominate');
  });

  test('three failed governments enact a policy with NO power and reset term limits', () => {
    const room = makeRoom('council', 9); // 9-player board: slot 1 is AUDIT
    const g = room.game;
    for (const p of room.players) council.action(room, p.id, { type: 'ack' });
    g.lastElectedSpeaker = 'p1';
    g.lastElectedDeputy = 'p2';
    // Force a decree on top so chaos would grant AUDIT if powers wrongly fired.
    g.draw = ['DECREE', ...g.draw.filter((_, i) => i > 0)];

    for (let round = 0; round < 3; round++) {
      const target = council.eligibleDeputies(g)[0];
      council.action(room, g.speaker, { type: 'nominate', target });
      for (const p of room.players) council.action(room, p.id, { type: 'vote', value: 'NO' });
    }
    assert.equal(g.decrees, 1, 'the top policy is enacted');
    assert.equal(g.pendingPower, null, 'a chaos policy must NOT grant a power');
    assert.equal(g.phase, 'nominate');
    assert.equal(g.tracker, 0, 'enacting a policy resets the tracker');
    assert.equal(g.lastElectedSpeaker, null, 'chaos wipes term limits');
    assert.equal(g.lastElectedDeputy, null);
  });

  test('term limits bar the last deputy always, and the last speaker only above 5 alive', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    g.lastElectedSpeaker = 'p1';
    g.lastElectedDeputy = 'p2';
    assert.ok(council.termLimited(g, 'p1'), 'last speaker barred at 7 alive');
    assert.ok(council.termLimited(g, 'p2'));
    // Drop to five alive: only the last deputy stays barred.
    g.alive.p5 = false;
    g.alive.p6 = false;
    assert.ok(!council.termLimited(g, 'p1'), 'last speaker eligible again at 5 alive');
    assert.ok(council.termLimited(g, 'p2'));
  });

  test('the architect elected deputy wins only once three decrees are down', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    for (const p of room.players) council.action(room, p.id, { type: 'ack' });
    const architect = Object.keys(g.roles).find((id) => g.roles[id] === 'ARCHITECT');
    g.speaker = room.players.find((p) => p.id !== architect).id;
    g.seatPointer = room.players.findIndex((p) => p.id === g.speaker);

    g.decrees = 2;
    council.action(room, g.speaker, { type: 'nominate', target: architect });
    for (const p of room.players) council.action(room, p.id, { type: 'vote', value: 'YES' });
    assert.equal(g.phase, 'legislate_speaker', 'below three decrees nothing happens');

    const room2 = makeRoom('council', 7);
    const g2 = room2.game;
    for (const p of room2.players) council.action(room2, p.id, { type: 'ack' });
    const architect2 = Object.keys(g2.roles).find((id) => g2.roles[id] === 'ARCHITECT');
    g2.speaker = room2.players.find((p) => p.id !== architect2).id;
    g2.decrees = 3;
    council.action(room2, g2.speaker, { type: 'nominate', target: architect2 });
    for (const p of room2.players) council.action(room2, p.id, { type: 'vote', value: 'YES' });
    assert.equal(g2.over?.winner, 'CABAL');
    assert.equal(g2.over?.reason, 'ARCHITECT_SEATED');
  });

  test('a veto advances the tracker and discards both policies', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    for (const p of room.players) council.action(room, p.id, { type: 'ack' });
    g.decrees = 5; // veto unlocked
    g.phase = 'legislate_deputy';
    g.electedSpeaker = 'p0';
    g.electedDeputy = 'p1';
    g.deputyHand = ['DECREE', 'DECREE'];
    const discardBefore = g.discard.length;

    assert.equal(council.action(room, 'p1', { type: 'proposeVeto' }).error, undefined);
    council.action(room, 'p0', { type: 'vetoConsent', value: true });
    assert.equal(g.tracker, 1, 'a veto is an inactive government');
    assert.equal(g.discard.length, discardBefore + 2);
  });

  test('a refused veto forces the deputy to enact and blocks a second attempt', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    g.decrees = 5;
    g.phase = 'legislate_deputy';
    g.electedSpeaker = 'p0';
    g.electedDeputy = 'p1';
    g.deputyHand = ['CHARTER', 'DECREE'];
    council.action(room, 'p1', { type: 'proposeVeto' });
    council.action(room, 'p0', { type: 'vetoConsent', value: false });
    assert.equal(g.phase, 'legislate_deputy');
    assert.equal(council.action(room, 'p1', { type: 'proposeVeto' }).error, 'veto_refused');
  });

  test('audit reveals party, so the architect audits as cabal', () => {
    const room = makeRoom('council', 9);
    const g = room.game;
    const architect = Object.keys(g.roles).find((id) => g.roles[id] === 'ARCHITECT');
    g.phase = 'power_audit';
    g.electedSpeaker = 'p0';
    council.action(room, 'p0', { type: 'audit', target: architect });
    assert.equal(g.auditResult.party, 'CABAL', 'must not reveal ARCHITECT');
  });

  test('a purged player cannot be audited or nominated', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    g.alive.p3 = false;
    assert.ok(!council.eligibleDeputies(g).includes('p3'));
    g.phase = 'power_audit';
    g.electedSpeaker = 'p0';
    assert.equal(council.action(room, 'p0', { type: 'audit', target: 'p3' }).error, 'bad_target');
  });

  test('purging the architect ends the game for the stewards', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    const architect = Object.keys(g.roles).find((id) => g.roles[id] === 'ARCHITECT');
    g.phase = 'power_purge';
    g.electedSpeaker = 'p0';
    council.action(room, 'p0', { type: 'purge', target: architect });
    assert.equal(g.over?.winner, 'STEWARD');
    assert.equal(g.over?.reason, 'ARCHITECT_PURGED');
  });

  test('the deck conserves tiles across a full legislative session', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    const count = (tile) =>
      g.draw.filter((t) => t === tile).length +
      g.discard.filter((t) => t === tile).length +
      (tile === 'CHARTER' ? g.charters : g.decrees) +
      (g.speakerHand ?? []).filter((t) => t === tile).length +
      (g.deputyHand ?? []).filter((t) => t === tile).length;

    for (const p of room.players) council.action(room, p.id, { type: 'ack' });
    for (let i = 0; i < 6; i++) {
      if (g.phase === 'nominate') {
        const target = council.eligibleDeputies(g)[0];
        council.action(room, g.speaker, { type: 'nominate', target });
        for (const p of room.players) council.action(room, p.id, { type: 'vote', value: 'YES' });
      }
      if (g.phase === 'legislate_speaker') council.action(room, g.electedSpeaker, { type: 'discardPolicy', index: 0 });
      if (g.phase === 'legislate_deputy') council.action(room, g.electedDeputy, { type: 'enactPolicy', index: 0 });
      assert.equal(count('CHARTER'), 6, `charters conserved @${i}`);
      assert.equal(count('DECREE'), 11, `decrees conserved @${i}`);
      if (g.phase === 'over') break;
      // Powers need resolving before play can continue.
      if (g.phase.startsWith('power_')) break;
    }
  });

  test('a player never receives another player’s hand', () => {
    const room = makeRoom('council', 7);
    const g = room.game;
    g.phase = 'legislate_speaker';
    g.electedSpeaker = 'p0';
    g.speakerHand = ['DECREE', 'DECREE', 'CHARTER'];
    assert.deepEqual(council.viewFor(room, 'p0').myHand, ['DECREE', 'DECREE', 'CHARTER']);
    for (const other of ['p1', 'p2', 'p3']) {
      assert.equal(council.viewFor(room, other).myHand, null, `${other} must not see the hand`);
    }
  });
});

// ------------------------------------------------------------------ sabotage --

describe('sabotage (Avalon rules)', () => {
  test('team split matches the official table', () => {
    const expected = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };
    for (const [count, saboteurs] of Object.entries(expected)) {
      const room = makeRoom('sabotage', Number(count));
      const evil = Object.values(room.game.roles).filter((r) => sabotage.ROLE_INFO[r].team === 'SABOTEUR');
      assert.equal(evil.length, saboteurs, `saboteurs @${count}`);
    }
  });

  test('mission team sizes match the rulebook, including the non-monotonic rows', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((m) => sabotage.teamSize(5, m)), [2, 3, 2, 3, 3]);
    assert.deepEqual([0, 1, 2, 3, 4].map((m) => sabotage.teamSize(6, m)), [2, 3, 4, 3, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((m) => sabotage.teamSize(7, m)), [2, 3, 3, 4, 4]);
    assert.deepEqual([0, 1, 2, 3, 4].map((m) => sabotage.teamSize(10, m)), [3, 4, 4, 5, 5]);
  });

  test('only mission four at 7+ players needs two fails', () => {
    for (const n of [5, 6]) {
      for (const m of [0, 1, 2, 3, 4]) assert.equal(sabotage.failsNeeded(n, m), 1, `${n}p m${m}`);
    }
    for (const n of [7, 8, 9, 10]) {
      assert.equal(sabotage.failsNeeded(n, 3), 2, `${n}p mission 4`);
      for (const m of [0, 1, 2, 4]) assert.equal(sabotage.failsNeeded(n, m), 1, `${n}p m${m}`);
    }
  });

  test('a tied approval vote is a rejection', () => {
    const room = makeRoom('sabotage', 6);
    const g = room.game;
    for (const p of room.players) sabotage.action(room, p.id, { type: 'ack' });
    sabotage.action(room, g.order[g.leaderIndex], { type: 'propose', team: g.order.slice(0, 2) });
    g.order.forEach((id, i) => sabotage.action(room, id, { type: 'vote', value: i % 2 ? 'APPROVE' : 'REJECT' }));
    assert.equal(g.rejections, 1, '3-3 must reject');
    assert.equal(g.phase, 'propose');
  });

  test('five consecutive rejections hands the game to the saboteurs', () => {
    const room = makeRoom('sabotage', 5);
    const g = room.game;
    for (const p of room.players) sabotage.action(room, p.id, { type: 'ack' });
    for (let i = 0; i < 5; i++) {
      sabotage.action(room, g.order[g.leaderIndex], { type: 'propose', team: g.order.slice(0, 2) });
      for (const id of g.order) sabotage.action(room, id, { type: 'vote', value: 'REJECT' });
    }
    assert.equal(g.over?.winner, 'SABOTEUR');
    assert.equal(g.over?.reason, 'FIVE_REJECTIONS');
  });

  test('crew are refused a fail card at the server', () => {
    const room = makeRoom('sabotage', 5);
    const g = room.game;
    const crew = g.order.find((id) => sabotage.ROLE_INFO[g.roles[id]].team === 'CREW');
    g.phase = 'mission';
    g.proposal = [crew];
    assert.equal(sabotage.action(room, crew, { type: 'missionCard', value: 'FAIL' }).error, 'crew_must_succeed');
  });

  test('one fail does not sink mission four at 7 players, and the count is public', () => {
    const room = makeRoom('sabotage', 7);
    const g = room.game;
    g.mission = 3;
    g.phase = 'mission';
    const evil = g.order.find((id) => sabotage.ROLE_INFO[g.roles[id]].team === 'SABOTEUR');
    const team = [evil, ...g.order.filter((id) => id !== evil).slice(0, 3)];
    g.proposal = team;
    for (const id of team) {
      sabotage.action(room, id, { type: 'missionCard', value: id === evil ? 'FAIL' : 'SUCCESS' });
    }
    assert.equal(g.results[3], 'SUCCESS', 'one fail is not enough at 7 players');
    assert.equal(g.lastMission.fails, 1, 'the fail count is published');
  });

  test('who played which mission card is never revealed', () => {
    const room = makeRoom('sabotage', 5);
    const g = room.game;
    g.phase = 'mission';
    g.proposal = [g.order[0], g.order[1]];
    sabotage.action(room, g.order[0], { type: 'missionCard', value: 'SUCCESS' });
    const view = sabotage.viewFor(room, g.order[1]);
    assert.deepEqual(view.playedCard, [g.order[0]], 'who has played is public');
    assert.equal(view.myCard, null, 'and nothing else about their card is');
  });

  test('the analyst sees the saboteurs but not the shadow; the ghost sees nobody', () => {
    const room = makeRoom('sabotage', 8); // set includes SHADOW
    const g = room.game;
    const analyst = g.order.find((id) => g.roles[id] === 'ANALYST');
    const shadow = g.order.find((id) => g.roles[id] === 'SHADOW');
    const seen = sabotage.viewFor(room, analyst).known.map((k) => k.id);
    assert.ok(!seen.includes(shadow), 'the shadow is hidden from the analyst');
    assert.equal(seen.length, 2, 'the other two saboteurs are visible');

    const room10 = makeRoom('sabotage', 10); // set includes GHOST
    const g10 = room10.game;
    const ghost = g10.order.find((id) => g10.roles[id] === 'GHOST');
    assert.equal(sabotage.viewFor(room10, ghost).known.length, 0, 'the ghost knows nobody');
    const otherEvil = g10.order.find(
      (id) => sabotage.ROLE_INFO[g10.roles[id]].team === 'SABOTEUR' && id !== ghost,
    );
    assert.ok(
      !sabotage.viewFor(room10, otherEvil).known.some((k) => k.id === ghost),
      'and no saboteur knows the ghost',
    );
    // ...but the analyst can see them.
    const analyst10 = g10.order.find((id) => g10.roles[id] === 'ANALYST');
    assert.ok(sabotage.viewFor(room10, analyst10).known.some((k) => k.id === ghost));
  });

  test('the decoy sees an unordered pair with one label', () => {
    const room = makeRoom('sabotage', 7);
    const g = room.game;
    const decoy = g.order.find((id) => g.roles[id] === 'DECOY');
    const known = sabotage.viewFor(room, decoy).known;
    assert.equal(known.length, 2);
    assert.ok(known.every((k) => k.label === 'Analyst or Mimic'), 'must not say which is which');
  });

  test('naming the analyst steals the win for the saboteurs', () => {
    const room = makeRoom('sabotage', 5);
    const g = room.game;
    const handler = g.order.find((id) => g.roles[id] === 'HANDLER');
    const analyst = g.order.find((id) => g.roles[id] === 'ANALYST');
    g.phase = 'assassinate';
    sabotage.action(room, handler, { type: 'assassinate', target: analyst });
    assert.equal(g.over?.winner, 'SABOTEUR');

    const room2 = makeRoom('sabotage', 5);
    const g2 = room2.game;
    const handler2 = g2.order.find((id) => g2.roles[id] === 'HANDLER');
    const wrong = g2.order.find((id) => g2.roles[id] === 'CREW');
    g2.phase = 'assassinate';
    sabotage.action(room2, handler2, { type: 'assassinate', target: wrong });
    assert.equal(g2.over?.winner, 'CREW');
  });
});

// ----------------------------------------------------------------- oddoneout --

describe('odd one out (Spyfall rules)', () => {
  test('the spy never receives the location', () => {
    const room = makeRoom('oddoneout', 6);
    const g = room.game;
    const spy = g.spies[0];
    const view = oddoneout.viewFor(room, spy);
    assert.equal(view.myLocation, null);
    assert.equal(view.myRole, null);
    const payload = JSON.stringify(view);
    const location = LOCATIONS.find((l) => l.id === g.locationId);
    // The full location list is public, so check the field, not the string.
    assert.equal(view.myLocation, null, `spy payload must not name ${location.name}`);
    assert.ok(payload.includes('"amSpy":true'));
  });

  test('non-spies all get the same location and distinct roles', () => {
    const room = makeRoom('oddoneout', 8);
    const g = room.game;
    const nonSpies = room.players.map((p) => p.id).filter((id) => !g.spies.includes(id));
    const locations = new Set(nonSpies.map((id) => oddoneout.viewFor(room, id).myLocation));
    assert.equal(locations.size, 1);
    const roles = nonSpies.map((id) => oddoneout.viewFor(room, id).myRole);
    assert.equal(new Set(roles).size, roles.length, 'roles must not repeat');
  });

  test('official timer scales with player count', () => {
    assert.equal(oddoneout.timerFor(4), 360);
    assert.equal(oddoneout.timerFor(6), 420);
    assert.equal(oddoneout.timerFor(8), 480);
    assert.equal(oddoneout.timerFor(10), 540);
    assert.equal(oddoneout.timerFor(12), 600);
  });

  test('spy count follows the official guidance', () => {
    assert.equal(oddoneout.defaultSpyCount(6), 1);
    assert.equal(oddoneout.defaultSpyCount(8), 1);
    assert.equal(oddoneout.defaultSpyCount(9), 2);
    assert.equal(oddoneout.defaultSpyCount(12), 2);
  });

  test('an accusation needs unanimity among everyone but the accused', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const accused = 'p4';
    oddoneout.action(room, 'p0', { type: 'accuse', target: accused }, 1_000_000);
    // p0 is an automatic yes; one dissenter must be enough to fail it.
    oddoneout.action(room, 'p1', { type: 'accusationVote', value: 'YES' }, 1_000_000);
    oddoneout.action(room, 'p2', { type: 'accusationVote', value: 'YES' }, 1_000_000);
    oddoneout.action(room, 'p3', { type: 'accusationVote', value: 'NO' }, 1_000_000);
    assert.equal(g.phase, 'questioning', 'one dissenter defeats the accusation');
    assert.ok(g.deadline, 'the clock resumes');
  });

  test('the clock pauses for a vote and resumes at the same value', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const before = g.deadline - 1_000_000;
    oddoneout.action(room, 'p0', { type: 'accuse', target: 'p4' }, 1_030_000);
    assert.equal(g.deadline, null, 'clock stops during the vote');
    const held = g.remainingMs;
    assert.equal(held, before - 30_000);
    oddoneout.action(room, 'p1', { type: 'accusationVote', value: 'NO' }, 1_060_000);
    oddoneout.action(room, 'p2', { type: 'accusationVote', value: 'NO' }, 1_060_000);
    oddoneout.action(room, 'p3', { type: 'accusationVote', value: 'NO' }, 1_060_000);
    // Time spent arguing is not deducted.
    assert.equal(g.deadline - 1_060_000, held);
  });

  test('each player gets one accusation per round', () => {
    const room = makeRoom('oddoneout', 5);
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    oddoneout.action(room, 'p0', { type: 'accuse', target: 'p4' }, 1_000_000);
    for (const id of ['p1', 'p2', 'p3']) {
      oddoneout.action(room, id, { type: 'accusationVote', value: 'NO' }, 1_000_000);
    }
    assert.equal(
      oddoneout.action(room, 'p0', { type: 'accuse', target: 'p3' }, 1_000_000).error,
      'already_accused',
    );
  });

  test('the spy is locked out once someone else stops the clock', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const spy = g.spies[0];
    const other = room.players.find((p) => p.id !== spy).id;
    oddoneout.action(room, other, { type: 'accuse', target: 'p4' }, 1_000_000);
    assert.equal(oddoneout.action(room, spy, { type: 'spyReveal' }, 1_000_000).error, 'too_late');
  });

  test('timer expiry opens sequential ballots starting with the dealer', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    oddoneout.onDeadline(room, 2_000_000);
    assert.equal(g.phase, 'endgame');
    assert.equal(g.ballotQueue[0], g.dealer, 'the dealer is the first suspect');
    assert.equal(g.ballotQueue.length, 5);
  });

  test('nobody convicted at the endgame means the spy walks with 2', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    oddoneout.onDeadline(room, 2_000_000);
    for (let ballot = 0; ballot < 5; ballot++) {
      const suspect = g.ballotQueue[g.ballotIndex];
      for (const p of room.players) {
        if (p.id !== suspect) oddoneout.action(room, p.id, { type: 'endgameVote', value: 'NO' }, 2_000_000);
      }
    }
    assert.equal(g.result.kind, 'spySurvived');
    assert.equal(room.scores[g.spies[0]], 2);
  });

  test('scoring: catching the spy pays 1 to everyone and 2 to the first accuser', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const spy = g.spies[0];
    const accuser = room.players.find((p) => p.id !== spy).id;
    oddoneout.action(room, accuser, { type: 'accuse', target: spy }, 1_000_000);
    for (const p of room.players) {
      if (p.id !== spy && p.id !== accuser) {
        oddoneout.action(room, p.id, { type: 'accusationVote', value: 'YES' }, 1_000_000);
      }
    }
    assert.equal(g.result.kind, 'spyCaught');
    assert.equal(room.scores[accuser], 2, 'first accuser gets 2');
    const bystander = room.players.find((p) => p.id !== spy && p.id !== accuser).id;
    assert.equal(room.scores[bystander], 1);
    assert.equal(room.scores[spy] ?? 0, 0);
  });

  test('scoring: convicting an innocent pays the spy 4', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const spy = g.spies[0];
    const innocent = room.players.find((p) => p.id !== spy).id;
    const accuser = room.players.find((p) => p.id !== spy && p.id !== innocent).id;
    oddoneout.action(room, accuser, { type: 'accuse', target: innocent }, 1_000_000);
    for (const p of room.players) {
      if (p.id !== innocent && p.id !== accuser) {
        oddoneout.action(room, p.id, { type: 'accusationVote', value: 'YES' }, 1_000_000);
      }
    }
    assert.equal(g.result.kind, 'innocentConvicted');
    assert.equal(room.scores[spy], 4);
  });

  test('scoring: a correct location guess pays the spy 4, a wrong one pays everyone else 1', () => {
    const room = makeRoom('oddoneout', 5);
    const g = room.game;
    for (const p of room.players) oddoneout.action(room, p.id, { type: 'ack' }, 1_000_000);
    const spy = g.spies[0];
    oddoneout.action(room, spy, { type: 'spyReveal' }, 1_000_000);
    oddoneout.action(room, spy, { type: 'spyGuess', locationId: g.locationId }, 1_000_000);
    assert.equal(room.scores[spy], 4);

    const room2 = makeRoom('oddoneout', 5);
    const g2 = room2.game;
    for (const p of room2.players) oddoneout.action(room2, p.id, { type: 'ack' }, 1_000_000);
    const spy2 = g2.spies[0];
    const wrong = LOCATIONS.find((l) => l.id !== g2.locationId).id;
    oddoneout.action(room2, spy2, { type: 'spyReveal' }, 1_000_000);
    oddoneout.action(room2, spy2, { type: 'spyGuess', locationId: wrong }, 1_000_000);
    assert.equal(room2.scores[spy2] ?? 0, 0);
    const other = room2.players.find((p) => p.id !== spy2).id;
    assert.equal(room2.scores[other], 1);
  });
});

// ------------------------------------------------------------------ spectrum --

describe('spectrum (Wavelength rules)', () => {
  test('scoring bands are 4 / 3 / 2 / 0 by distance', () => {
    assert.equal(spectrum.scoreFor(50, 50), 4);
    assert.equal(spectrum.scoreFor(50, 52.5), 4);
    assert.equal(spectrum.scoreFor(50, 55), 3);
    assert.equal(spectrum.scoreFor(50, 57.5), 3);
    assert.equal(spectrum.scoreFor(50, 60), 2);
    assert.equal(spectrum.scoreFor(50, 62.5), 2);
    assert.equal(spectrum.scoreFor(50, 65), 0);
  });

  test('the team going second starts on one point', () => {
    const room = makeRoom('spectrum', 6);
    assert.equal(room.game.scores.A, 0);
    assert.equal(room.game.scores.B, 1);
  });

  test('the target reaches the psychic and nobody else', () => {
    const room = makeRoom('spectrum', 6);
    const g = room.game;
    assert.equal(typeof spectrum.viewFor(room, g.psychic).target, 'number');
    for (const p of room.players) {
      if (p.id !== g.psychic) assert.equal(spectrum.viewFor(room, p.id).target, null, p.id);
    }
  });

  test('the psychic cannot move the dial, server-side', () => {
    const room = makeRoom('spectrum', 6);
    const g = room.game;
    g.phase = 'guess';
    assert.equal(spectrum.action(room, g.psychic, { type: 'dial', value: 40 }, 1).error, 'psychic_cannot_guess');
  });

  test('the opposing team scores nothing when the psychic team hits the bullseye', () => {
    const room = makeRoom('spectrum', 6);
    const g = room.game;
    g.phase = 'bet';
    g.target = 50;
    g.dial = 50; // bullseye
    const other = g.activeTeam === 'A' ? 'B' : 'A';
    const before = g.scores[other];
    for (const id of g.teams[other]) spectrum.action(room, id, { type: 'bet', value: 'LEFT' }, 1);
    assert.equal(g.lastResult.points, 4);
    assert.equal(g.scores[other], before, 'no bonus against a bullseye');
  });

  test('a correct left/right call pays one point otherwise', () => {
    const room = makeRoom('spectrum', 6);
    const g = room.game;
    g.phase = 'bet';
    g.target = 40;
    g.dial = 50; // target is LEFT of the dial, and only worth 2
    const other = g.activeTeam === 'A' ? 'B' : 'A';
    const before = g.scores[other];
    for (const id of g.teams[other]) spectrum.action(room, id, { type: 'bet', value: 'LEFT' }, 1);
    assert.equal(g.lastResult.points, 2);
    assert.equal(g.scores[other], before + 1);
  });

  test('small groups fall back to co-op', () => {
    assert.equal(makeRoom('spectrum', 4).game.mode, 'coop');
    assert.equal(makeRoom('spectrum', 6).game.mode, 'teams');
  });

  test('the target always leaves room for the full band', () => {
    for (let seed = 1; seed < 300; seed++) {
      const room = makeRoom('spectrum', 6);
      room.game = spectrum.start(room, seed, 1000);
      assert.ok(room.game.target >= 12.5 && room.game.target <= 87.5, `seed ${seed}`);
    }
  });
});

// ------------------------------------------------------------------ content --

describe('content decks', () => {
  test('every location has a unique id and exactly eight roles', () => {
    const ids = new Set();
    for (const loc of LOCATIONS) {
      assert.equal(loc.roles.length, 8, `${loc.name} needs 8 roles`);
      assert.equal(new Set(loc.roles).size, 8, `${loc.name} has duplicate roles`);
      assert.ok(!ids.has(loc.id));
      ids.add(loc.id);
    }
    assert.ok(LOCATIONS.length >= 40, 'need at least 40 locations to launch');
  });

  test('location names are unique', () => {
    assert.equal(new Set(LOCATIONS.map((l) => l.name)).size, LOCATIONS.length);
  });

  test('spectrum pairs are distinct at both poles', () => {
    for (const pair of SPECTRUMS) {
      assert.notEqual(pair.low, pair.high, `${pair.id} has identical poles`);
      assert.ok(pair.low && pair.high);
    }
    assert.ok(SPECTRUMS.length >= 120, 'need at least 120 spectrum pairs');
    assert.equal(new Set(SPECTRUMS.map((p) => `${p.low}|${p.high}`)).size, SPECTRUMS.length);
  });
});

// -------------------------------------------------------------------- shared --

describe('shared utilities', () => {
  test('the rng is deterministic for a given seed', () => {
    const a = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(42));
    const b = shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(42));
    assert.deepEqual(a, b, 'same seed must replay a round exactly');
    assert.notDeepEqual(a, shuffle([1, 2, 3, 4, 5, 6, 7, 8], makeRng(43)));
  });

  test('shuffle does not mutate its input', () => {
    const input = [1, 2, 3, 4, 5];
    shuffle(input, makeRng(7));
    assert.deepEqual(input, [1, 2, 3, 4, 5]);
  });

  test('every registered game round-trips its config and starts at every legal size', () => {
    for (const [id, game] of Object.entries(GAMES)) {
      const normalized = game.normalizeConfig({ ...game.defaultConfig, bogus: 'x' });
      assert.ok(!('bogus' in normalized), `${id} must drop unknown config keys`);
      for (let n = game.meta.minPlayers; n <= Math.min(game.meta.maxPlayers, 10); n++) {
        const room = makeRoom(id, n);
        assert.ok(room.game, `${id} failed to start at ${n} players`);
        for (const p of room.players) {
          assert.doesNotThrow(() => game.viewFor(room, p.id), `${id} viewFor threw at ${n}`);
        }
      }
    }
  });
});
