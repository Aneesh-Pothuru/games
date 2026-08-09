/**
 * The syllabus.
 *
 * A trainer's concept layer fails in two directions and both are quiet. It can
 * teach the wrong idea — naming "showdown value" on a preflop decision, which
 * is the right shape of spot and completely the wrong lesson — or it can teach
 * an idea the student has no prerequisites for, which is how a course loses
 * somebody in week one.
 *
 * So these tests are mostly about ORDER and APPLICABILITY rather than about
 * content. The prose is checked only for the properties that make it teaching
 * rather than decoration: every concept states a transferable idea, an
 * actionable rule, and the specific mistake it exists to prevent.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONCEPTS, CONCEPT_BY_ID, MASTERY_BANDS, ORDERED, STAGES,
  bandFor, conceptsFor, emptyMastery, nextUp, primaryConcept, progress,
  recordMastery, unlockOrder,
} from '../src/games/poker/concepts.js';
import { analyse } from '../src/games/poker/coach.js';
import { parseCard } from '../src/games/poker/cards.js';

const C = (s) => s.trim().split(/\s+/).map(parseCard);

/** A complete spot, so a detector is never asked about an impossible node. */
function spot(over = {}) {
  const board = over.board ? C(over.board) : [];
  const toCall = over.toCall ?? 0;
  return {
    hole: C(over.hole ?? 'Ah Kh'),
    board,
    street: ['preflop', '', '', 'flop', 'turn', 'river'][board.length] || 'preflop',
    pot: over.pot ?? 200,
    toCall,
    minRaiseTo: toCall + 20,
    maxRaiseTo: 2000,
    canCheck: over.canCheck ?? toCall === 0,
    canRaise: over.canRaise ?? true,
    bigBlind: 20,
    stack: over.stack ?? 1800,
    position: over.position ?? 'BTN',
    openerPosition: 'BTN',
    opponents: 1,
    villainWidth: 0.35,
  };
}

const teaches = (over) => {
  const s = spot(over);
  return primaryConcept(s, analyse(s))?.id;
};

describe('the syllabus itself', () => {
  test('every concept is complete', () => {
    for (const c of CONCEPTS) {
      assert.ok(c.id && c.name, `${c.id} is unnamed`);
      assert.ok(STAGES.some((s) => s.id === c.stage), `${c.id} is in no stage`);
      assert.equal(typeof c.rank, 'number');
      assert.ok(Array.isArray(c.needs));
      assert.equal(typeof c.applies, 'function');
    }
  });

  test('the prose is teaching, not decoration', () => {
    for (const c of CONCEPTS) {
      // One sentence. If it needs two it is two concepts.
      assert.ok(c.idea.length > 30 && c.idea.length < 200, `${c.id} idea: ${c.idea.length} chars`);
      assert.match(c.idea, /\.$/, `${c.id} idea should be a sentence`);
      // The rule has to be actionable — something you can do at a table.
      assert.ok(c.rule.length > 30, `${c.id} has no actionable rule`);
      // And the trap is what the concept exists to prevent.
      assert.ok(c.trap.length > 40, `${c.id} names no trap`);
      assert.ok(c.why.length > 80, `${c.id} does not explain itself`);
    }
  });

  test('ranks are unique and ids are unique', () => {
    assert.equal(new Set(CONCEPTS.map((c) => c.id)).size, CONCEPTS.length);
    assert.equal(new Set(CONCEPTS.map((c) => c.rank)).size, CONCEPTS.length);
  });

  test('every prerequisite exists and comes earlier', () => {
    // A concept that depends on one taught later is a course that cannot be
    // followed in its own order.
    for (const c of CONCEPTS) {
      for (const need of c.needs) {
        const dep = CONCEPT_BY_ID[need];
        assert.ok(dep, `${c.id} needs ${need}, which does not exist`);
        assert.ok(dep.rank < c.rank, `${c.id} (${c.rank}) needs ${need} (${dep.rank}), taught later`);
      }
    }
  });

  test('the dependency graph has no cycles and covers everything', () => {
    const order = unlockOrder();
    assert.equal(order.length, CONCEPTS.length);
    const seen = new Set();
    for (const c of order) {
      for (const need of c.needs) {
        assert.ok(seen.has(need), `${c.id} unlocked before its prerequisite ${need}`);
      }
      seen.add(c.id);
    }
  });

  test('it starts with equity and pot odds, because everything needs them', () => {
    assert.equal(ORDERED[0].id, 'equity');
    assert.equal(ORDERED[1].id, 'potOdds');
    // Minimum defence frequency is a generalisation of the price. Teaching it
    // to somebody who cannot compute a price is how trainers lose people.
    assert.ok(CONCEPT_BY_ID.mdf.rank > CONCEPT_BY_ID.potOdds.rank);
    assert.ok(CONCEPT_BY_ID.bluffCatching.rank > CONCEPT_BY_ID.mdf.rank);
    assert.ok(CONCEPT_BY_ID.openingRanges.rank > CONCEPT_BY_ID.position.rank,
      'ranges are indexed by position, so position comes first');
  });
});

describe('what a spot teaches', () => {
  test('a preflop spot never teaches a postflop idea', () => {
    // The bug this exists for: "showdown value" fired on a big blind checking
    // its option, because the detector only asked whether a check was legal.
    const postflopOnly = ['valueBetting', 'showdownValue', 'semiBluff', 'boardTexture', 'foldEquity'];
    const cases = [
      { hole: 'Ah Kh', position: 'UTG', pot: 30, toCall: 20 },
      { hole: '5d Jd', position: 'BB', pot: 40, toCall: 0, canCheck: true },
      { hole: '7d 2d', position: 'BB', pot: 75, toCall: 30 },
      { hole: 'Ac Ad', position: 'CO', pot: 30, toCall: 20 },
    ];
    for (const c of cases) {
      const s = spot(c);
      const fired = conceptsFor(s, analyse(s)).map((x) => x.concept.id);
      for (const id of postflopOnly) {
        assert.ok(!fired.includes(id), `${id} fired preflop on ${c.hole} from ${c.position}`);
      }
    }
  });

  test('the classic spots teach the classic lessons', () => {
    assert.equal(teaches({ hole: 'Ah Kh', board: 'Qh 7h 2c', pot: 300, toCall: 100 }), 'oneCard');
    assert.equal(teaches({ hole: '7d 2d', position: 'BB', pot: 75, toCall: 30 }), 'blindDefence');
    assert.equal(teaches({ hole: 'Kc Td', position: 'UTG', pot: 30, toCall: 0, canCheck: false }), 'openingRanges');
    assert.equal(teaches({ hole: '9c 9d', board: 'Ah 7d 2c 4s Js', position: 'BB', pot: 600, toCall: 200 }), 'bluffCatching');
    assert.equal(teaches({ hole: '8c 8d', board: 'Ah 7d 2c', position: 'BB', pot: 200, toCall: 0 }), 'showdownValue');
    assert.equal(teaches({ hole: 'Ac Kd', board: 'Ah 7d 2c', pot: 200, toCall: 0 }), 'valueBetting');
  });

  test('every spot teaches exactly one thing, with the rest available', () => {
    const s = spot({ hole: 'Ah Kh', board: 'Qh 7h 2c', pot: 300, toCall: 100 });
    const all = conceptsFor(s, analyse(s));
    assert.ok(all.length >= 3, 'a real spot exercises several ideas');
    assert.equal(primaryConcept(s, analyse(s)).id, all[0].concept.id);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].weight >= all[i].weight, 'concepts are not ranked');
    }
  });

  test('a detector that throws cannot break the coach', () => {
    // Every detector runs against every spot, including ones the analysis did
    // not fully populate. One bad read must not take the panel down.
    const broken = { ...CONCEPTS[0], applies: () => { throw new Error('boom'); } };
    const saved = CONCEPTS[0].applies;
    CONCEPTS[0].applies = broken.applies;
    try {
      const s = spot();
      assert.doesNotThrow(() => conceptsFor(s, analyse(s)));
    } finally {
      CONCEPTS[0].applies = saved;
    }
  });

  test('every concept is reachable by some spot', () => {
    // A concept nothing can ever trigger is a lesson that never gets taught.
    const boards = ['', 'Qh 7h 2c', 'Ah 7d 2c', 'Kh 7d 2s 9c', 'Ah 7d 2c 4s Js', '2c 2d 2h'];
    const holes = ['Ah Kh', 'Ac Ad', '7d 2d', '9c 8c', 'Kc Td', '8c 8d', '5h 4h', 'Qs Jd'];
    const seats = ['UTG', 'CO', 'BTN', 'SB', 'BB'];
    const seen = new Set();
    for (const board of boards) {
      for (const hole of holes) {
        for (const position of seats) {
          for (const toCall of [0, 60, 300]) {
            for (const stack of [400, 1800]) {
              const s = spot({ hole, board, position, toCall, stack, pot: 200 + toCall });
              for (const { concept } of conceptsFor(s, analyse(s))) seen.add(concept.id);
            }
          }
        }
      }
    }
    const unreachable = CONCEPTS.filter((c) => !seen.has(c.id)).map((c) => c.id);
    assert.deepEqual(unreachable, [], `no spot can teach: ${unreachable.join(', ')}`);
  });
});

describe('mastery', () => {
  test('a fresh learner has nothing recorded and nothing claimed', () => {
    const m = emptyMastery();
    assert.deepEqual(m, {});
    assert.equal(bandFor(undefined).id, 'new');
    const p = progress(m);
    assert.equal(p.solid, 0);
    assert.equal(p.rows.length, CONCEPTS.length);
  });

  test('three decisions is the floor for claiming anything', () => {
    // Below that the score is one lucky guess away from claiming mastery.
    const m = emptyMastery();
    recordMastery(m, 'equity', 1);
    recordMastery(m, 'equity', 1);
    assert.equal(bandFor(m.equity).id, 'new', 'two right answers is not evidence');
    recordMastery(m, 'equity', 1);
    assert.notEqual(bandFor(m.equity).id, 'new');
  });

  test('it forgets old mistakes once you have shown you learned', () => {
    // A score that remembers a mistake from ten hands ago forever tells a
    // learner they have not improved when they have.
    const m = emptyMastery();
    for (let i = 0; i < 5; i++) recordMastery(m, 'potOdds', 0);
    const low = m.potOdds.score;
    for (let i = 0; i < 12; i++) recordMastery(m, 'potOdds', 1);
    assert.ok(m.potOdds.score > low + 0.5, `stuck at ${m.potOdds.score}`);
    assert.ok(['solid', 'sharp'].includes(bandFor(m.potOdds).id), bandFor(m.potOdds).id);
  });

  test('the score is always a probability and the bands are ordered', () => {
    const m = emptyMastery();
    for (const q of [0, 1, 0.5, 0.25, 1, 1, 0, 0.7]) recordMastery(m, 'equity', q);
    assert.ok(m.equity.score >= 0 && m.equity.score <= 1);
    for (let i = 1; i < MASTERY_BANDS.length; i++) {
      assert.ok(MASTERY_BANDS[i].min > MASTERY_BANDS[i - 1].min);
    }
  });

  test('out-of-range quality is clamped rather than trusted', () => {
    const m = emptyMastery();
    recordMastery(m, 'equity', 99);
    recordMastery(m, 'equity', -5);
    assert.ok(m.equity.score >= 0 && m.equity.score <= 1);
  });

  test('what to work on next never runs ahead of the prerequisites', () => {
    const m = emptyMastery();
    // Nothing learned yet: the first suggestion must have no unmet needs.
    const first = nextUp(m);
    assert.ok(first, 'a fresh learner should have somewhere to start');
    assert.deepEqual(first.needs.filter((n) => !m[n]), first.needs.length ? [] : [],
      'suggested a concept whose prerequisites are unlearned');
    assert.equal(first.needs.length, 0, 'the first suggestion must need nothing');
  });

  test('it moves on once an idea is sharp', () => {
    const m = emptyMastery();
    const start = nextUp(m).id;
    for (let i = 0; i < 25; i++) recordMastery(m, start, 1);
    assert.equal(bandFor(m[start]).id, 'sharp');
    assert.notEqual(nextUp(m).id, start, 'it kept drilling a mastered idea');
  });

  test('it prefers the weakest idea you are ready for', () => {
    const m = emptyMastery();
    for (let i = 0; i < 6; i++) recordMastery(m, 'equity', 1);
    for (let i = 0; i < 6; i++) recordMastery(m, 'potOdds', 0.1);
    for (let i = 0; i < 6; i++) recordMastery(m, 'outs', 1);
    assert.equal(nextUp(m).id, 'potOdds');
  });

  test('progress groups by stage and counts what is solid', () => {
    const m = emptyMastery();
    for (let i = 0; i < 20; i++) recordMastery(m, 'equity', 1);
    const p = progress(m);
    assert.equal(p.stages.length, STAGES.length);
    const foundations = p.stages.find((s) => s.id === 'foundations');
    assert.ok(foundations.total >= 4);
    assert.ok(foundations.solid >= 1);
    assert.ok(p.rows.every((r) => r.band?.label), 'every row needs a band');
    assert.ok(p.rows.every((r, i, arr) => i === 0 || arr[i - 1].rank <= r.rank), 'rows out of order');
  });
});
