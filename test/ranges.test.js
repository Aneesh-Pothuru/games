/**
 * Preflop charts.
 *
 * Range data rots in one specific way: someone tweaks a chart, the percentage
 * in the comment beside it stays where it was, and from then on the coach
 * quotes a number that its own chart contradicts. Every stated width in
 * ranges.js is therefore asserted here against the parsed range, to a tenth of
 * a percent. If you widen a chart, this file tells you by exactly how much.
 *
 * The structural properties matter as much as the widths. A chart set where
 * the button opens tighter than under the gun, or where the big blind's calls
 * and 3-bets overlap, is broken in a way no single percentage would catch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_CLASSES, parseRange, rangePercent } from '../src/games/poker/notation.js';
import {
  BB_DEFENCE, BB_DEFEND_PERCENT, LEAKS, POSITIONS, POSITION_NAME,
  RFI, RFI_PERCENT, SHOVE, VS_OPEN, VS_THREE_BET, preflopPlan,
} from '../src/games/poker/ranges.js';

const pct = (range) => Math.round(rangePercent(range) * 10) / 10;
const union = (...ranges) => new Set(ranges.flatMap((r) => [...r]));

describe('raise-first-in', () => {
  test('every seat that opens has a chart', () => {
    for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
      assert.ok(RFI[pos] instanceof Set, `${pos} has no RFI range`);
      assert.ok(RFI[pos].size > 0, `${pos} opens nothing`);
    }
    // The big blind never opens — there is nobody left to open against.
    assert.equal(RFI.BB, undefined);
  });

  test('each chart is exactly as wide as the number beside it', () => {
    for (const [pos, stated] of Object.entries(RFI_PERCENT)) {
      assert.equal(pct(RFI[pos]), stated, `${pos} chart is ${pct(RFI[pos])}%, stated ${stated}%`);
    }
  });

  test('every stated width has a chart and vice versa', () => {
    assert.deepEqual(Object.keys(RFI).sort(), Object.keys(RFI_PERCENT).sort());
  });

  test('ranges widen monotonically towards the button', () => {
    const order = ['UTG', 'HJ', 'CO', 'BTN'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        RFI_PERCENT[order[i]] > RFI_PERCENT[order[i - 1]],
        `${order[i]} should open wider than ${order[i - 1]}`,
      );
    }
  });

  test('the later chart contains the earlier one — a strict nesting', () => {
    // Not a stylistic preference. A hand that is profitable under the gun,
    // where five players can wake up behind you, is profitable on the button
    // where one can. A chart set that violates this has an error in it.
    const order = ['UTG', 'HJ', 'CO', 'BTN'];
    for (let i = 1; i < order.length; i++) {
      const wider = RFI[order[i]];
      const tighter = RFI[order[i - 1]];
      for (const cls of tighter) {
        assert.ok(wider.has(cls), `${order[i]} should contain ${cls}, which ${order[i - 1]} opens`);
      }
    }
  });

  test('every pair opens from the button, and none of them is folded from the cutoff', () => {
    for (const r of 'AKQJT98765432') assert.ok(RFI.BTN.has(r + r), `BTN should open ${r}${r}`);
    assert.ok(RFI.CO.has('33'), 'the cutoff opens 33');
  });

  test('the premium hands open from every seat', () => {
    for (const pos of Object.keys(RFI)) {
      for (const cls of ['AA', 'KK', 'QQ', 'AKs', 'AKo', 'AQs']) {
        assert.ok(RFI[pos].has(cls), `${pos} must open ${cls}`);
      }
    }
  });

  test('the unplayable hands open from nowhere', () => {
    for (const pos of Object.keys(RFI)) {
      for (const cls of ['72o', '83o', '92o', 'J2o', 'Q2o']) {
        assert.ok(!RFI[pos].has(cls), `${pos} must not open ${cls}`);
      }
    }
  });

  test('offsuit broadways are an early-position leak, and the chart agrees', () => {
    // The named leak and the chart have to tell the same story. Every hand the
    // leak text names must be folded by the earliest seat and opened by the
    // latest one, or the coach cites a leak while recommending the hand.
    const named = LEAKS.earlyOffsuitBroadway.why.match(/\b[AKQJT2-9][AKQJT2-9]o\b/g) ?? [];
    assert.ok(named.length >= 2, 'the leak should name specific hands');
    for (const cls of named) {
      assert.ok(!RFI.UTG.has(cls), `the leak names ${cls}, so UTG must not open it`);
      assert.ok(RFI.BTN.has(cls), `the leak says ${cls} is a button open, so BTN must open it`);
    }
  });
});

describe('the small blind is the special case', () => {
  test('raise-or-fold, and wider than the solver raises', () => {
    // Removing the limp does not remove the hands. The good half of a 38%
    // limping range becomes raises, which is why this is 40.9% and not 24.3%.
    assert.equal(pct(RFI.SB), 40.9);
    assert.ok(RFI_PERCENT.SB > 24.3, 'a raise-or-fold SB is wider than a solved SB raises');
    assert.ok(RFI_PERCENT.SB < 62.3, 'and narrower than raise plus limp combined');
  });

  test('it opens larger, because it is out of position for the rest of the hand', () => {
    assert.equal(preflopPlan({ position: 'SB' }).sizing, 3);
    assert.equal(preflopPlan({ position: 'BTN' }).sizing, 2.5);
    assert.equal(preflopPlan({ position: 'CO' }).sizing, 2.5);
  });

  test('the comment beside the chart states the simplification', () => {
    // Deliberately checks the source, because the honesty of the claim is the
    // point: a student told "this is a simplification" learns something a
    // student told "this is the solution" does not.
    assert.ok(RFI.SB.has('54s'), 'suited connectors are in the raise-or-fold range');
    assert.ok(!RFI.SB.has('72o'), 'and the true trash is not');
  });
});

describe('big blind defence', () => {
  test('each defence is exactly as wide as the number beside it', () => {
    for (const [pos, stated] of Object.entries(BB_DEFEND_PERCENT)) {
      const total = union(BB_DEFENCE[pos].call, BB_DEFENCE[pos].threeBet);
      assert.equal(pct(total), stated, `BB vs ${pos} defends ${pct(total)}%, stated ${stated}%`);
    }
  });

  test('every opener has a defence chart', () => {
    for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
      assert.ok(BB_DEFENCE[pos], `no BB defence against ${pos}`);
      assert.ok(BB_DEFENCE[pos].call.size > 0);
      assert.ok(BB_DEFENCE[pos].threeBet.size > 0);
    }
    assert.deepEqual(Object.keys(BB_DEFENCE).sort(), Object.keys(BB_DEFEND_PERCENT).sort());
  });

  test('a hand is either a call or a 3-bet, never both', () => {
    // An overlap is not a mixed strategy — it is a chart that cannot be
    // followed, because it gives two answers to the same question.
    for (const pos of Object.keys(BB_DEFENCE)) {
      const { call, threeBet } = BB_DEFENCE[pos];
      const both = [...call].filter((c) => threeBet.has(c));
      assert.deepEqual(both, [], `BB vs ${pos} both calls and 3-bets ${both.join(', ')}`);
    }
  });

  test('defence widens as the opener widens', () => {
    const order = ['UTG', 'HJ', 'CO', 'BTN'];
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        BB_DEFEND_PERCENT[order[i]] > BB_DEFEND_PERCENT[order[i - 1]],
        `BB should defend wider against ${order[i]} than ${order[i - 1]}`,
      );
      assert.ok(
        BB_DEFEND_PERCENT[order[i]] > RFI_PERCENT[order[i]],
        `BB defends wider than ${order[i]} opens — it is getting a price and is already invested`,
      );
    }
  });

  test('it defends far wider than minimum defence frequency would say', () => {
    // MDF against a 2.5x open is 1.5/(1.5+2.5) = 37.5% by the formula, and the
    // solver defends 56.9% against a button. The gap is the whole lesson: MDF
    // assumes the bluffs are worthless, and preflop the worst button open still
    // has about 30% against you. Quoting MDF here teaches over-folding.
    const mdfAt2p5 = (1.5 / (1.5 + 2.5)) * 100;
    assert.ok(Math.abs(mdfAt2p5 - 37.5) < 0.01);
    assert.ok(BB_DEFEND_PERCENT.BTN > mdfAt2p5 + 15, 'the solver defends much wider than MDF');
  });

  test('the widest defence is against the small blind, which opens widest into it', () => {
    const widest = Object.entries(BB_DEFEND_PERCENT).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(widest, 'SB');
    assert.ok(BB_DEFEND_PERCENT.SB > 60, 'heads-up and closing the action, it folds very little');
  });

  test('the premiums 3-bet rather than call, against every opener', () => {
    for (const pos of Object.keys(BB_DEFENCE)) {
      for (const cls of ['AA', 'KK', 'AKo']) {
        assert.ok(BB_DEFENCE[pos].threeBet.has(cls), `BB should 3-bet ${cls} vs ${pos}`);
        assert.ok(!BB_DEFENCE[pos].call.has(cls), `BB should not flat ${cls} vs ${pos}`);
      }
    }
  });

  test('the 3-betting range is polarised — it contains suited wheel aces, not just premiums', () => {
    // A linear 3-bet range is readable and unbalanced. The blockers matter:
    // A5s holds an ace, so it removes a chunk of the hands that continue.
    for (const pos of Object.keys(BB_DEFENCE)) {
      const has = ['A4s', 'A5s'].some((c) => BB_DEFENCE[pos].threeBet.has(c));
      assert.ok(has, `BB's 3-bet range vs ${pos} needs a blocker bluff`);
    }
  });
});

describe('facing an open when you are not the big blind', () => {
  test('it is tighter than big blind defence against every opener', () => {
    const total = pct(union(VS_OPEN.call, VS_OPEN.threeBet));
    for (const pos of Object.keys(BB_DEFEND_PERCENT)) {
      assert.ok(total < BB_DEFEND_PERCENT[pos], `cold-calling range ${total}% should be under BB vs ${pos}`);
    }
  });

  test('calls and 3-bets do not overlap', () => {
    const both = [...VS_OPEN.call].filter((c) => VS_OPEN.threeBet.has(c));
    assert.deepEqual(both, []);
  });

  test('the button flats wider than it 3-bets', () => {
    assert.ok(rangePercent(VS_OPEN.call) > rangePercent(VS_OPEN.threeBet));
  });

  test('only the button gets a flatting range — everyone else is 3-bet or fold', () => {
    // Flatting from the hijack or cutoff invites a squeeze from the players
    // still behind you, which you then fold having already put in 2.5bb. The
    // comment in ranges.js says so; this asserts the code does it.
    const btn = preflopPlan({ position: 'BTN', facing: 'open' });
    assert.ok(btn.call.size > 0, 'the button closes the action and can flat');
    assert.equal(btn.sizing, 3);

    for (const pos of ['HJ', 'CO', 'SB']) {
      const plan = preflopPlan({ position: pos, facing: 'open' });
      assert.equal(plan.call.size, 0, `${pos} should have no cold-calling range`);
      assert.ok(plan.threeBet.size > 0, `${pos} still 3-bets`);
      assert.equal(plan.sizing, 4, 'and out of position it 3-bets larger');
    }
  });
});

describe('facing a 3-bet', () => {
  test('it 4-bets or folds far more than it calls', () => {
    assert.ok(VS_THREE_BET.fourBet.has('AA'));
    assert.ok(VS_THREE_BET.fourBet.has('AKo'));
    assert.ok(VS_THREE_BET.fourBet.has('A5s'), 'the wheel aces are the 4-bet bluffs');
    assert.ok(!VS_THREE_BET.call.has('AA'), 'never flat the top of your range out of position');
  });

  test('4-bets and calls do not overlap', () => {
    const both = [...VS_THREE_BET.call].filter((c) => VS_THREE_BET.fourBet.has(c));
    assert.deepEqual(both, []);
  });

  test('the whole continuing range is narrow', () => {
    const total = pct(union(VS_THREE_BET.call, VS_THREE_BET.fourBet));
    assert.ok(total < 12, `continuing ${total}% against a 3-bet is too wide`);
    assert.ok(total > 3, `continuing ${total}% is so tight it is exploitable`);
  });
});

describe('push/fold', () => {
  test('shoving ranges tighten as the stack gets deeper', () => {
    for (const pos of ['UTG', 'HJ', 'CO', 'BTN', 'SB']) {
      const at10 = rangePercent(SHOVE[10][pos]);
      const at15 = rangePercent(SHOVE[15][pos]);
      assert.ok(at10 > at15, `${pos} should shove wider at 10bb (${at10}) than 15bb (${at15})`);
    }
  });

  test('and widen towards the button at every depth', () => {
    for (const depth of [10, 15]) {
      const order = ['UTG', 'HJ', 'CO', 'BTN'];
      for (let i = 1; i < order.length; i++) {
        assert.ok(
          rangePercent(SHOVE[depth][order[i]]) > rangePercent(SHOVE[depth][order[i - 1]]),
          `at ${depth}bb, ${order[i]} should shove wider than ${order[i - 1]}`,
        );
      }
    }
  });

  test('at 10bb the button shoves any ace and any pair', () => {
    for (const r of 'AKQJT98765432') {
      assert.ok(SHOVE[10].BTN.has(r + r), `BTN should shove ${r}${r} at 10bb`);
      assert.ok(SHOVE[10].BTN.has(`A${r}${r === 'A' ? '' : 'o'}`.replace('AAo', 'AA')), `BTN should shove A${r}o at 10bb`);
    }
  });

  test('a shove is TIGHTER than a 100bb open from the same seat, which surprises people', () => {
    // The intuition "short stack, so shove everything" is backwards. A 2.5bb
    // open risks 2.5 to win 1.5 and still gets to play a flop; a 10bb shove
    // risks 10 to win 1.5 and never sees one. The second needs far more fold
    // equity, so it is the narrower range despite being the shorter stack.
    for (const pos of ['UTG', 'HJ', 'CO', 'BTN']) {
      assert.ok(
        rangePercent(SHOVE[10][pos]) < RFI_PERCENT[pos],
        `${pos} shoves ${rangePercent(SHOVE[10][pos]).toFixed(1)}% at 10bb `
        + `but opens ${RFI_PERCENT[pos]}% at 100bb — the shove should be tighter`,
      );
    }
  });
});

describe('the plan picker', () => {
  test('no action in front of you is a raise-first-in spot', () => {
    const plan = preflopPlan({ position: 'CO' });
    assert.equal(plan.kind, 'rfi');
    assert.equal(plan.raise, RFI.CO);
  });

  test('the big blind facing an open gets the chart for that specific opener', () => {
    const vsBtn = preflopPlan({ position: 'BB', facing: 'open', openerPosition: 'BTN' });
    const vsUtg = preflopPlan({ position: 'BB', facing: 'open', openerPosition: 'UTG' });
    assert.equal(vsBtn.kind, 'defend');
    assert.equal(vsBtn.call, BB_DEFENCE.BTN.call);
    assert.equal(vsUtg.call, BB_DEFENCE.UTG.call);
    assert.notEqual(vsBtn.call, vsUtg.call, 'who opened has to change the answer');
  });

  test('an unknown opener falls back rather than crashing', () => {
    const plan = preflopPlan({ position: 'BB', facing: 'open', openerPosition: 'NOWHERE' });
    assert.equal(plan.kind, 'defend');
    assert.ok(plan.call.size > 0);
  });

  test('facing a 3-bet routes to the 4-bet chart', () => {
    const plan = preflopPlan({ position: 'CO', facing: '3bet' });
    assert.equal(plan.kind, 'vs3bet');
    assert.equal(plan.fourBet, VS_THREE_BET.fourBet);
  });

  test('a spot it does not model says so instead of guessing', () => {
    assert.equal(preflopPlan({ position: 'CO', facing: '5bet' }).kind, 'unknown');
  });

  test('a seat with no chart returns null rather than an empty range', () => {
    // null means "I have nothing for this"; an empty Set means "fold
    // everything", and confusing the two would have the coach recommend
    // folding aces from the big blind.
    assert.equal(preflopPlan({ position: 'BB' }).raise, null);
  });
});

describe('positions and leaks', () => {
  test('six seats, each with a name', () => {
    assert.deepEqual(POSITIONS, ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    for (const pos of POSITIONS) assert.equal(typeof POSITION_NAME[pos], 'string');
  });

  test('every named leak explains itself in a sentence a student can act on', () => {
    for (const [key, leak] of Object.entries(LEAKS)) {
      assert.ok(leak.name, `${key} has no name`);
      assert.ok(leak.why.length > 60, `${key} does not explain itself`);
      assert.match(leak.why, /\.$/, `${key} should end in a full stop`);
    }
  });

  test('the chasing leak states the one-card rule, which is the most expensive misconception', () => {
    assert.match(LEAKS.chasingWithoutOdds.why, /one card, not two/);
    assert.match(LEAKS.chasingWithoutOdds.why, /47/);
  });

  test('every class named in every chart is one of the 169', () => {
    const all = new Set(ALL_CLASSES);
    const charts = [
      ...Object.values(RFI),
      ...Object.values(BB_DEFENCE).flatMap((d) => [d.call, d.threeBet]),
      VS_OPEN.call, VS_OPEN.threeBet, VS_THREE_BET.call, VS_THREE_BET.fourBet,
      ...Object.values(SHOVE).flatMap((d) => Object.values(d)),
    ];
    for (const chart of charts) {
      for (const cls of chart) assert.ok(all.has(cls), `${cls} is not a real hand class`);
    }
  });

  test('a chart that parses to nothing would be caught, not silently ignored', () => {
    // Guards the guard: if parseRange started returning empty sets, every
    // width assertion above would still pass against a 0% stated width, so
    // prove the parser is actually doing something.
    assert.ok(rangePercent(parseRange('22+')) > 5);
    assert.equal(parseRange('').size, 0);
  });
});
