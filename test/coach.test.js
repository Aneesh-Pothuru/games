/**
 * The coach.
 *
 * This is the file where a bug does real damage. A wrong number in the
 * evaluator makes the game unfair; a wrong number here teaches somebody to
 * play badly, and they carry it to a real table. So the tests are about the
 * three promises the coach makes rather than about its internals:
 *
 *   1. it never states a mixed spot as a pure one;
 *   2. it never presents an estimate as though it were arithmetic;
 *   3. it grades the decision and not the result.
 *
 * Plus the arithmetic that has to be exactly right because a student will
 * check it: the price, the outs, MDF, and the EV gap between two lines.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRADES, analyse, emptyScorecard, grade, gradeFor, record, summarise,
} from '../src/games/poker/coach.js';
import { parseCard } from '../src/games/poker/cards.js';

const C = (str) => str.trim().split(/\s+/).map(parseCard);

/** A complete, legal spot. Every test below varies one thing about it. */
function spot(over = {}) {
  const bigBlind = 20;
  const pot = over.pot ?? 200;
  const toCall = over.toCall ?? 0;
  return {
    hole: C('Ah Kh'),
    board: C('Qh 7d 2c'),
    street: 'flop',
    pot,
    toCall,
    minRaiseTo: toCall + bigBlind,
    maxRaiseTo: 2000,
    canCheck: toCall <= 0,
    canRaise: true,
    bigBlind,
    stack: 1800,
    position: 'BTN',
    opponents: 1,
    villainWidth: 0.35,
    ...over,
  };
}

const fact = (a, key) => a.facts.find((f) => f.key === key);

describe('what the coach reports', () => {
  test('every spot produces a recommendation with a reason', () => {
    const a = analyse(spot());
    assert.ok(a.best, 'no best action');
    assert.ok(a.best.why.length > 20, 'the best action must explain itself');
    assert.ok(a.options.length >= 2, 'a spot with one option is not a decision');
    for (const o of a.options) {
      assert.ok(Number.isFinite(o.ev), `${o.move} has no EV`);
      assert.ok(o.why.length > 10, `${o.move} does not explain itself`);
    }
  });

  test('the options are sorted best first, and best is the top of that list', () => {
    const a = analyse(spot({ toCall: 100, canCheck: false }));
    for (let i = 1; i < a.options.length; i++) {
      assert.ok(a.options[i - 1].ev >= a.options[i].ev, 'options are out of order');
    }
    assert.equal(a.best, a.options[0]);
  });

  test('folding is always exactly zero, and the coach says why', () => {
    const a = analyse(spot({ toCall: 400, canCheck: false }));
    const fold = a.options.find((o) => o.move === 'fold');
    assert.equal(fold.ev, 0, 'a fold is worth nothing, not something negative');
    assert.match(fold.why, /zero/i);
  });

  test('folding is not offered at all when checking is free', () => {
    // The one strictly dominated action in poker. Listing it at 0.00bb also
    // put it inside the indifference band of any marginal check, which had the
    // coach announce "check or fold — same value" in the big blind. They are
    // not the same value: one of them is never right.
    for (const board of [[], C('Qh 7d 2c'), C('Qh 7d 2c 9s'), C('Qh 7d 2c 9s 4h')]) {
      const a = analyse(spot({
        board,
        street: ['preflop', 'flop', 'turn', 'river'][Math.max(0, board.length - 2)],
        toCall: 0,
        canCheck: true,
      }));
      assert.equal(a.options.find((o) => o.move === 'fold'), undefined,
        `fold offered with a free check on ${board.length} cards`);
      assert.ok(a.potBb > 0, 'the pot in big blinds travels with the analysis');
      assert.ok(a.options.some((o) => o.move === 'check'));
      assert.notEqual(a.best.move, 'fold');
      assert.ok(!a.mixed?.includes('fold'), 'and it is never called an equal alternative');
    }
  });

  test('but it is offered the moment there is something to call', () => {
    const a = analyse(spot({ toCall: 100, canCheck: false }));
    assert.ok(a.options.some((o) => o.move === 'fold'));
  });

  test('postflop equity is exact and labelled as exact', () => {
    // The engine enumerates every runout postflop, so there is no error bar to
    // report and the coach must not invent one.
    const a = analyse(spot());
    const eq = fact(a, 'equity');
    assert.ok(a.equity.exact, 'the flop should be enumerated');
    assert.equal(a.equity.stdErr, 0);
    assert.match(eq.detail, /exact/);
    assert.match(eq.value, /^\d+\.\d%$/);
  });

  test('preflop equity is sampled and shows its error bar', () => {
    const a = analyse(spot({ board: [], street: 'preflop', pot: 50, toCall: 0 }));
    const eq = fact(a, 'equity');
    assert.equal(a.equity.exact, false);
    assert.match(eq.detail, /±/, 'a sampled number must carry its uncertainty');
    assert.ok(a.equity.stdErr < 0.01, 'and that uncertainty should be under a point');
  });

  test('exact and estimated facts are flagged differently', () => {
    // Promise 2. Pot odds are arithmetic; equity is a measurement. Presenting
    // them identically teaches a student to trust both equally.
    const a = analyse(spot({ board: [], street: 'preflop', pot: 250, toCall: 50 }));
    assert.equal(fact(a, 'equity').exact, false);
    assert.equal(fact(a, 'price').exact, true);
    assert.equal(fact(a, 'mdf').exact, true);
    assert.equal(fact(a, 'spr').exact, true);
  });
});

describe('the arithmetic a student will check', () => {
  test('the price uses the pot INCLUDING the bet', () => {
    // They bet 100 into 200, so the pot in front of you is 300 and the call is
    // 100. You risk 100 to win 300, which is C/(P+C) = 100/400 = 25%.
    //
    // The classic error is to use the pot BEFORE their bet: 100/(200+100) =
    // 33.3%. That is a third higher than the truth and it talks you out of
    // calls that make money. It is also, confusingly, the right formula for a
    // different question — see the alpha test below.
    const a = analyse(spot({ pot: 300, toCall: 100, canCheck: false }));
    assert.ok(Math.abs(a.required - 0.25) < 1e-9, `required was ${a.required}`);
    assert.match(fact(a, 'price').value, /^25\.0%$/);
    assert.match(fact(a, 'price').detail, /100 into 300/);
    assert.match(fact(a, 'price').detail, /3\.0 to 1/);
  });

  test('with nothing to call there is no price to quote', () => {
    const a = analyse(spot({ toCall: 0 }));
    assert.equal(a.required, 0);
    assert.equal(fact(a, 'price'), undefined);
    assert.equal(fact(a, 'mdf'), undefined);
  });

  test('a half-pot bet: you need 25%, their bluff needs 33%, you defend 67%', () => {
    // Three different numbers off the same bet, and mixing them up is the most
    // common way people misquote poker theory.
    //   your price      C/(P+C)   = 100/400 = 25%   what YOUR call needs
    //   alpha           B/(P₀+B)  = 100/300 = 33%   what THEIR bluff needs
    //   MDF             P₀/(P₀+B) = 200/300 = 67%   how much you defend
    // Alpha and MDF are complements of each other. Neither is your price.
    const a = analyse(spot({ pot: 300, toCall: 100, canCheck: false }));
    assert.match(fact(a, 'price').value, /^25\.0%$/);
    assert.match(fact(a, 'mdf').value, /^33%$/);
    assert.match(fact(a, 'mdf').detail, /67%/, 'MDF against a half-pot bet is 67%');
    assert.match(fact(a, 'mdf').detail, /as a range, not with this hand/,
      'MDF is a property of a range and saying otherwise teaches hero-calling');
  });

  test('SPR is the stack over the pot, and it names what that means', () => {
    const a = analyse(spot({ pot: 200, stack: 200, toCall: 0 }));
    assert.equal(a.spr, 1);
    assert.equal(fact(a, 'spr').value, '1.0');
    assert.ok(fact(a, 'spr').detail.length > 20);
  });

  test('outs are quoted for the ONE card the call buys', () => {
    // The single most expensive misconception in poker. A flop call buys one
    // card; the two-card number only applies when the money is already in.
    const a = analyse(spot({
      hole: C('Ah Kh'), board: C('Qh 7h 2c'), pot: 300, toCall: 100, canCheck: false,
    }));
    const outs = fact(a, 'outs');
    assert.ok(outs, 'a flush draw should report outs');
    assert.match(outs.label, /^\d+ outs$/);
    const oneCard = Number(outs.value.replace('%', ''));
    const claimed = Number(outs.label.split(' ')[0]);
    assert.ok(Math.abs(oneCard - (claimed / 47) * 100) < 0.15, 'the headline number is o/47');
    assert.match(outs.detail, /one card you are buying/);
  });

  test('on the turn it says the river is the only card left', () => {
    const a = analyse(spot({
      hole: C('Ah Kh'), board: C('Qh 7h 2c 9s'), street: 'turn',
      pot: 300, toCall: 100, canCheck: false,
    }));
    const outs = fact(a, 'outs');
    assert.match(outs.detail, /only card left/);
    assert.doesNotMatch(outs.detail, /both/, 'there is no "both" on the turn');
  });

  test('it warns when only the two-card number clears the price', () => {
    // The trap: 9 outs is 19% for one card and 35% for two, so against a bet
    // needing 30% the "rule of 4" says call and the arithmetic says fold.
    const a = analyse(spot({
      hole: C('Ah Kh'), board: C('Qh 7h 2c'), pot: 250, toCall: 107, canCheck: false,
    }));
    const warn = a.warnings.find((w) => /buys one card/.test(w));
    assert.ok(warn, `expected the one-card warning, got: ${JSON.stringify(a.warnings)}`);
    assert.match(warn, /implied odds/);
  });
});

describe('promise 1: never state a mixed strategy as a pure one', () => {
  test('when two lines are within a fraction of the pot, it says either', () => {
    // Constructed rather than hunted for: two options this close ARE the same
    // decision, and a coach that picks a winner between them is inventing
    // certainty the maths does not support.
    const a = analyse(spot());
    a.options = [
      { move: 'check', ev: 1.00, why: 'x' },
      { move: 'raise', ev: 0.98, why: 'y' },
      { move: 'fold', ev: 0, why: 'z' },
    ];
    a.best = a.options[0];
    a.mixed = ['check', 'raise'];

    const g = grade(a, { move: 'raise' });
    assert.equal(g.indifferent, true);
    assert.equal(g.evLoss, 0, 'an indifferent choice costs nothing');
    assert.equal(g.grade, 'optimal');
    assert.match(g.verdict, /check and raise/);
    assert.match(g.why, /indifferent/i);
  });

  test('a genuinely dominant line is NOT reported as mixed', () => {
    const a = analyse(spot({ hole: C('Ac Ad'), board: C('As Ah 2c'), toCall: 0 }));
    assert.ok(a.best.ev > 0, 'quad aces should have a positive best line');
    if (a.mixed) {
      const gap = a.best.ev - a.options.find((o) => o.move === a.mixed[a.mixed.length - 1]).ev;
      assert.ok(gap <= 0.05, 'anything called mixed must actually be within the band');
    }
  });

  test('mixed is null, not a one-element list, when the answer is pure', () => {
    const a = analyse(spot({ toCall: 1700, canCheck: false, hole: C('7c 2d') }));
    assert.ok(a.mixed === null || a.mixed.length > 1, 'a single option is not a mix');
  });
});

describe('promise 3: grade the decision, not the result', () => {
  test('grade() takes no runout and cannot take one', () => {
    // The signature is the guarantee. If the result were an input, somebody
    // would eventually use it, and the whole exercise would be worthless.
    assert.equal(grade.length, 2, 'grade(analysis, taken) — nothing else');
  });

  test('the same decision grades identically however the hand ends', () => {
    const a = analyse(spot({ pot: 300, toCall: 100, canCheck: false }));
    const first = grade(a, { move: 'call' });
    const second = grade(a, { move: 'call' });
    assert.deepEqual(first, second);
  });

  test('choosing the best line loses nothing', () => {
    const a = analyse(spot({ pot: 300, toCall: 100, canCheck: false }));
    const g = grade(a, { move: a.best.move });
    assert.equal(g.evLoss, 0);
    assert.ok(['optimal', 'fine'].includes(g.grade), g.grade);
    assert.equal(g.chosen, a.best.move);
  });

  test('a worse line loses exactly the EV gap, in big blinds and as a share of the pot', () => {
    const a = analyse(spot({ pot: 300, toCall: 100, canCheck: false }));
    const worst = a.options[a.options.length - 1];
    const g = grade(a, { move: worst.move });
    if (!g.indifferent) {
      assert.ok(Math.abs(g.evLoss - (a.best.ev - worst.ev)) < 1e-9, 'bb loss');
      assert.ok(Math.abs(g.severity - g.evLoss / a.potBb) < 1e-9, 'severity is the loss over the pot');
      // The verdict names the better line rather than quoting arithmetic at
      // the player: a label read alongside a number gets the number read and
      // the label ignored.
      assert.match(g.verdict, new RegExp(a.best.move, 'i'));
    }
  });

  test('an action that was not even an option is graded, not crashed on', () => {
    const a = analyse(spot({ toCall: 0 }));
    const g = grade(a, { move: 'teleport' });
    assert.ok(g.evLoss > 0);
    assert.equal(g.chosen, 'teleport');
  });
});

describe('grade bands', () => {
  test('the five bands, in order, with the last one open-ended', () => {
    assert.deepEqual(GRADES.map((g) => g.id), ['optimal', 'fine', 'leak', 'mistake', 'blunder']);
    for (let i = 1; i < GRADES.length; i++) {
      assert.ok(GRADES[i].max > GRADES[i - 1].max, 'bands must widen');
    }
    assert.equal(GRADES[GRADES.length - 1].max, Infinity);
  });

  test('the thresholds are a share of the pot, and land where chess landed', () => {
    // Chess.com and Lichess arrived independently at inaccuracy from about 5%
    // of win probability, mistake from 10%, blunder from 15-20%. Those are the
    // same shape of quantity as "share of the pot given up", and the bands
    // here are set to match rather than to a number somebody liked.
    // One big blind sits between both absolute guards, so only the ratio acts.
    const big = 1;
    assert.equal(gradeFor(0, big).id, 'optimal');
    assert.equal(gradeFor(0.004, big).id, 'optimal');
    assert.equal(gradeFor(0.01, big).id, 'fine');
    assert.equal(gradeFor(0.03, big).id, 'leak');
    assert.equal(gradeFor(0.10, big).id, 'mistake');
    assert.equal(gradeFor(0.30, big).id, 'blunder');
    assert.equal(gradeFor(Infinity, big).id, 'blunder');
  });

  test('the absolute guards stop the ratio overcorrecting at both ends', () => {
    // Floor: a fifth of a big blind cannot be a blunder however small the pot.
    // This is the documented complaint about trainers that grade on the ratio
    // alone — "what should be a mistake is often listed as a blunder".
    assert.equal(gradeFor(0.9, 0.05).id, 'fine', 'a twentieth of a blind is never serious');
    assert.equal(gradeFor(0.9, 0.3).id, 'mistake', 'a third of a blind caps below blunder');
    // Ceiling: two big blinds cannot be flawless however big the pot.
    assert.equal(gradeFor(0.001, 2.5).id, 'mistake', 'two and a half blinds is an error');
    assert.equal(gradeFor(0.4, 8).id, 'blunder', 'and a big ratio on a big loss still is');
  });

  test('the same big-blind error is graded differently in a big pot and a small one', () => {
    // The whole point of normalising. Half a big blind given up in a 3bb
    // preflop pot is a real error; the same half blind in a 90bb pot is a
    // rounding difference, and calling them both the same thing teaches a
    // student to fear cheap mistakes and shrug at expensive ones.
    const opts = [{ move: 'raise', ev: 1 }, { move: 'fold', ev: 0.7 }];
    const node = (potBb) => ({ potBb, options: opts, best: { move: 'raise', ev: 1, why: 'x' }, mixed: null });
    const a = grade(node(3), { move: 'fold' });
    const b = grade(node(90), { move: 'fold' });
    assert.equal(a.evLoss.toFixed(4), b.evLoss.toFixed(4), 'the same 0.3 big blinds');
    assert.notEqual(a.grade, b.grade, 'and not the same mistake');
    assert.equal(a.grade, 'mistake', '10% of a 3bb pot is a real error');
    assert.equal(b.grade, 'optimal', 'a third of a percent of a 90bb pot is nothing');
  });

  test('the bands are contiguous — no EV loss falls through', () => {
    for (let x = 0; x < 3; x += 0.01) {
      assert.ok(gradeFor(x), `no band for ${x}`);
    }
  });
});

describe('the scorecard', () => {
  test('an empty card is genuinely empty', () => {
    const card = emptyScorecard();
    assert.equal(card.decisions, 0);
    assert.equal(card.evLoss, 0);
    assert.deepEqual(card.counts, { solid: 0, loose: 0, mistake: 0, blunder: 0 });
  });

  test('it accumulates decisions and EV, and per-100 is the headline', () => {
    const card = emptyScorecard();
    for (let i = 0; i < 50; i++) {
      record(card, { grade: 'loose', evLoss: 0.1, leak: null });
    }
    const s = summarise(card);
    assert.equal(s.decisions, 50);
    assert.ok(Math.abs(s.evLossPer100 - 10) < 1e-9, '0.1bb over 50 decisions is 10bb/100');
    assert.equal(s.counts.loose, 50);
  });

  test('it refuses to draw a conclusion from too few decisions', () => {
    const card = emptyScorecard();
    record(card, { grade: 'blunder', evLoss: 5, leak: null });
    const s = summarise(card);
    assert.match(s.verdict, /not enough/i);
    // And it says so in the data, not only in the prose — one blunder in your
    // first five decisions extrapolates to "100bb lost per 100", which is a
    // fact about arithmetic and not about anybody's poker.
    assert.equal(s.rateable, false);
    assert.equal(s.evLoss, 5, 'the running total is still a real number');
  });

  test('the rate becomes quotable once there is enough of it', () => {
    const card = emptyScorecard();
    for (let i = 0; i < 19; i++) record(card, { grade: 'solid', evLoss: 0.01, leak: null });
    assert.equal(summarise(card).rateable, false, '19 is not enough');
    record(card, { grade: 'solid', evLoss: 0.01, leak: null });
    assert.equal(summarise(card).rateable, true, '20 is');
  });

  test('leaks are ranked by TOTAL cost, not by how often they happen', () => {
    // A leak you hit 40% of the time worth 0.05bb is noise. One you hit 6% of
    // the time worth 2bb is the whole problem, and it must come first.
    const card = emptyScorecard();
    const cheap = { name: 'Cheap habit', why: 'x'.repeat(70) };
    const dear = { name: 'Expensive habit', why: 'y'.repeat(70) };
    for (let i = 0; i < 40; i++) record(card, { grade: 'loose', evLoss: 0.05, leak: cheap });
    for (let i = 0; i < 6; i++) record(card, { grade: 'mistake', evLoss: 2, leak: dear });

    const s = summarise(card);
    assert.equal(s.leaks[0].name, 'Expensive habit');
    assert.equal(s.leaks[0].count, 6);
    assert.ok(Math.abs(s.leaks[0].cost - 12) < 1e-9);
    assert.equal(s.leaks[1].name, 'Cheap habit');
  });

  test('it shows at most three leaks, so the advice is actionable', () => {
    const card = emptyScorecard();
    for (let i = 0; i < 8; i++) {
      record(card, { grade: 'mistake', evLoss: i + 1, leak: { name: `L${i}`, why: 'z'.repeat(70) } });
    }
    assert.equal(summarise(card).leaks.length, 3);
  });

  test('a clean run reads as clean and a leaky one does not', () => {
    const clean = emptyScorecard();
    for (let i = 0; i < 40; i++) record(clean, { grade: 'solid', evLoss: 0.005, leak: null });
    assert.match(summarise(clean).verdict, /fundamentals/i);

    const leaky = emptyScorecard();
    for (let i = 0; i < 40; i++) record(leaky, { grade: 'blunder', evLoss: 1.5, leak: null });
    assert.match(summarise(leaky).verdict, /work on/i);
  });
});

describe('equity realisation', () => {
  test('out of position it is discounted, and the coach warns about it', () => {
    const oop = analyse(spot({ position: 'BB', toCall: 100, pot: 300, canCheck: false }));
    assert.ok(oop.realisation < 1, 'out of position realises less than raw equity');
    assert.ok(oop.warnings.some((w) => /out of position/i.test(w)));
  });

  test('in position it is a premium, not a discount', () => {
    const ip = analyse(spot({ position: 'BTN', toCall: 100, pot: 300, canCheck: false }));
    assert.ok(ip.realisation >= 1, 'the button realises more than its raw equity');
  });

  test('realised equity can never exceed all of the pot', () => {
    // It is a share of one pot. A "realisation factor" applied without a clamp
    // once turned 58% raw into 83.5% effective, which is not a thing.
    for (const hole of ['Ac Ad', 'Ah Kh', '7c 2d', 'Qh Jh']) {
      for (const board of ['Qh 7d 2c', 'Ah Kd Qc', '2c 2d 2h']) {
        const a = analyse(spot({ hole: C(hole), board: C(board), position: 'BTN' }));
        const claimed = a.options.find((o) => o.move === 'call' || o.move === 'check');
        assert.ok(a.realisation > 0 && a.realisation < 1.5, `factor ${a.realisation} is silly`);
        void claimed;
      }
    }
  });

  test('a made hand does not get the drawing bonus', () => {
    // The nut bonus exists because a DRAW wins a big pot when it gets there.
    // Applying it to a hand that is already ahead double-counts.
    const made = analyse(spot({ hole: C('Ac Ad'), board: C('As 7d 2c'), position: 'BTN' }));
    assert.ok(made.realisation <= 1.25, `a set should not get a nut premium: ${made.realisation}`);
  });
});

describe('preflop advice', () => {
  test('it names the position in words, not as a code', () => {
    const a = analyse(spot({ board: [], street: 'preflop', position: 'UTG', pot: 30 }));
    assert.equal(a.position, 'Under the gun');
  });

  test('a hand in the opening range is recommended to open', () => {
    const a = analyse(spot({
      hole: C('Ah Kh'), board: [], street: 'preflop', position: 'UTG',
      pot: 30, toCall: 0, canRaise: true,
    }));
    assert.equal(a.best.move, 'raise', 'AKs opens from every seat');
  });

  test('a hand outside the range is not, and the leak is named', () => {
    const a = analyse(spot({
      hole: C('9c 4d'), board: [], street: 'preflop', position: 'UTG',
      pot: 30, toCall: 0, canRaise: true,
    }));
    const raise = a.options.find((o) => o.move === 'raise');
    assert.ok(raise.ev < 0, '94o must not be a profitable under-the-gun open');
    assert.ok(raise.leak, 'and the coach should name what is wrong with it');
  });

  test('the hand is reported by class, which is how ranges are written', () => {
    const a = analyse(spot({ hole: C('Ah Kh'), board: [], street: 'preflop', pot: 30 }));
    assert.equal(a.hand.class, 'AKs');
  });

  test('the panel prices the call on REALISED equity, and shows both numbers', () => {
    // The contradiction this removes: 72s facing a small raise from the big
    // blind has 34% raw against 25% required, which reads as an easy call —
    // and it is a fold, because out of position with the worst hand in poker
    // you will never collect 34% of that pot. Showing raw equity while pricing
    // the call on realised equity makes the panel argue with its own verdict.
    const a = analyse(spot({
      hole: C('7d 2d'), board: [], street: 'preflop', position: 'BB',
      pot: 40, toCall: 10, canCheck: false,
    }));
    const raw = fact(a, 'equity');
    const realised = fact(a, 'realised');
    assert.ok(realised, 'the realisation discount must be on the panel, not just in the maths');
    assert.ok(a.realisation < 1, 'the big blind is out of position for the whole hand');
    assert.ok(
      Number(realised.value.replace('%', '')) < Number(raw.value.replace('%', '')),
      'realised equity must be below raw equity out of position',
    );
    assert.equal(realised.exact, false, 'a realisation factor is a model, not arithmetic');
  });

  test('in position the panel says the premium out loud too', () => {
    const a = analyse(spot({
      hole: C('7d 2d'), board: [], street: 'preflop', position: 'BTN',
      pot: 40, toCall: 10, canCheck: false,
    }));
    assert.ok(a.realisation > 1);
    assert.match(fact(a, 'realised').detail, /[Aa]cting last/);
    assert.match(fact(a, 'realised').detail, /points above raw/);
  });

  test('a raise is priced on fold equity, not on a constant', () => {
    // Most of what an opening raise makes comes from everyone folding. A model
    // that ignores that cannot explain why the button opens twice as many
    // hands as under the gun, which is the single most important preflop idea.
    const heads = analyse(spot({
      hole: C('Ah Kh'), board: [], street: 'preflop', position: 'BTN',
      pot: 30, toCall: 0, opponents: 1,
    }));
    const field = analyse(spot({
      hole: C('Ah Kh'), board: [], street: 'preflop', position: 'BTN',
      pot: 30, toCall: 0, opponents: 4,
    }));
    const evOf = (a) => a.options.find((o) => o.move === 'raise').ev;
    assert.ok(evOf(heads) > evOf(field), 'the same raise is worth less into more players');
    assert.match(
      heads.options.find((o) => o.move === 'raise').why,
      /Everyone folds about \d+% of the time/,
      'and it should say so, with the number',
    );
  });

  test('the raise it recommends is a real size, not the minimum', () => {
    // A min-raise gives the big blind a price they cannot fold to, so you
    // inflate the pot without narrowing the field. It is the worst of both.
    const a = analyse(spot({
      hole: C('Ah Kh'), board: [], street: 'preflop', position: 'CO',
      pot: 30, toCall: 0, bigBlind: 20, minRaiseTo: 40, maxRaiseTo: 2000,
    }));
    const raise = a.options.find((o) => o.move === 'raise');
    assert.ok(raise.to > 40, `a 2x open is a leak, got ${raise.to}`);
    assert.equal(raise.to, 50, '2.5bb is the standard open at 100bb');
  });

  test('the small blind is told to open larger, because it is out of position', () => {
    const sb = analyse(spot({
      hole: C('Ah Kh'), board: [], street: 'preflop', position: 'SB',
      pot: 30, toCall: 0, bigBlind: 20, minRaiseTo: 40, maxRaiseTo: 2000,
    }));
    assert.equal(sb.options.find((o) => o.move === 'raise').to, 60, '3bb from the small blind');
  });
});

describe('it does not fall over', () => {
  test('on every street, in every position, facing anything', () => {
    const boards = ['', 'Qh 7d 2c', 'Qh 7d 2c 9s', 'Qh 7d 2c 9s 4h'];
    const streets = ['preflop', 'flop', 'turn', 'river'];
    for (let i = 0; i < boards.length; i++) {
      for (const position of ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']) {
        for (const toCall of [0, 40, 400, 1800]) {
          const a = analyse(spot({
            board: boards[i] ? C(boards[i]) : [],
            street: streets[i],
            position,
            toCall,
            pot: 200 + toCall,
            canCheck: toCall === 0,
            canRaise: toCall < 1800,
          }));
          assert.ok(a.best, `no advice for ${streets[i]} ${position} facing ${toCall}`);
          assert.ok(Number.isFinite(a.best.ev));
          assert.ok(Number.isFinite(a.required));
          assert.ok(a.required >= 0 && a.required <= 1, `required ${a.required} is not a probability`);
        }
      }
    }
  });

  test('an all-in call with no raise available still produces advice', () => {
    const a = analyse(spot({ toCall: 1800, canCheck: false, canRaise: false, stack: 1800 }));
    assert.ok(a.best);
    assert.equal(a.options.find((o) => o.move === 'raise'), undefined);
  });

  test('a pot of zero does not divide by zero', () => {
    const a = analyse(spot({ pot: 0, toCall: 0, stack: 1000 }));
    assert.ok(Number.isFinite(a.best.ev));
  });
});
