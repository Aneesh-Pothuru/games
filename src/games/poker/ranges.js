/**
 * Preflop ranges, 6-max, 100bb, 2.5x opens.
 *
 * These approximate solver output rather than reproducing it. A real solve is
 * a mixed strategy — most hands on the edge of a range are played some
 * fraction of the time — and no chart can express that. What a chart CAN do is
 * put you within a fraction of a big blind of the solution while being
 * memorable, which is the trade every published chart makes.
 *
 * The percentages beside each range are the share of all 1326 hands, and they
 * are asserted in the tests: a chart that drifts from its own stated width is
 * the most common way range data rots.
 *
 * Position matters more than any other preflop input. UTG opens about a sixth
 * of hands and the button opens well over twice that, for one reason: the
 * button acts last on every later street and therefore realises far more of
 * whatever equity it starts with.
 */

import { parseRange } from './notation.js';

/** Seat order for 6-max, earliest first. BB never opens; it defends. */
export const POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

export const POSITION_NAME = {
  UTG: 'Under the gun',
  HJ: 'Hijack',
  CO: 'Cutoff',
  BTN: 'Button',
  SB: 'Small blind',
  BB: 'Big blind',
};

/**
 * Raise-first-in, 6-max, 100bb, no ante, 2.5bb opens. Solver output, and the
 * stated widths are asserted in the tests so the charts cannot drift.
 *
 * Nothing here limps. The only seat that limps in a solved game is the small
 * blind when it is folded to, which is a different node entirely — see the
 * note on SB below.
 */
const RFI_TEXT = {
  UTG: '66+, A3s+, K8s+, Q9s+, J9s+, T9s, ATo+, KJo+, QJo',                     // 17.0%
  HJ: '55+, A2s+, K6s+, Q8s+, J9s+, T9s, 98s, 87s, 76s, ATo+, KTo+, QTo+',      // 21.4%
  CO: '33+, A2s+, K3s+, Q6s+, J8s+, T7s+, 97s+, 87s, 76s, A8o+, KTo+, QTo+, JTo', // 27.8%
  BTN: '22+, A2s+, K2s+, Q3s+, J4s+, T6s+, 96s+, 85s+, 75s+, 64s+, 53s+, A4o+, K8o+, Q9o+, J9o+, T8o+, 98o', // 43.3%
  // A solved small blind plays three actions, not two — raise 24.3%, LIMP
  // 38.0%, fold 37.7% — and its limping range is deliberately trap-loaded (AA
  // and TT limp while KK/QQ/JJ raise). A limp tree is a lot to teach and worth
  // very little to a student, so this is the raise-or-fold simplification.
  //
  // It is WIDER than the solver's 24.3% raising range, not narrower, which
  // surprises people. The reason is that removing the limp does not remove the
  // hands: the better half of a 38% limping range still wants to play, and with
  // only two buttons left the good ones become raises and the rest become
  // folds. 40.9% raise / 59.1% fold is where that lands, and the rules text
  // says plainly that it is a simplification.
  SB: '22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 86s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o', // 40.9%
};

/**
 * The share of hands each seat opens, for the coach to quote. Every one of
 * these is asserted against the parsed width of the chart beside it, to a
 * tenth of a percent — see test/ranges.test.js.
 */
export const RFI_PERCENT = { UTG: 17.0, HJ: 21.4, CO: 27.8, BTN: 43.3, SB: 40.9 };

export const RFI = Object.fromEntries(
  Object.entries(RFI_TEXT).map(([pos, text]) => [pos, parseRange(text)]),
);

/**
 * Big blind defence.
 *
 * The big blind defends far wider than any other seat, and it is not a matter
 * of taste — it is the price. Facing a 2.5bb open the pot is 4bb and the call
 * is 1.5bb, so the break-even equity is 1.5/5.5 = 27.3%. Almost any two cards
 * clear that against a button's opening range. The blind is already invested;
 * folding forfeits money that is on the table.
 *
 * The correction, which is why the BB does not defend 100%: out of position it
 * realises only about 80% of its raw equity. That is the whole reason the
 * defence is wide rather than universal.
 */
const BB_DEFEND_TEXT = {
  // vs a button open — the widest, because the button opens the widest.
  BTN: {
    threeBet: '88+, ATs+, A4s-A6s, K9s+, Q9s+, J8s+, T8s+, 97s+, 87s, 76s, 65s, 54s, AQo+, KQo',
    call: '22-77, A7s-A9s, A2s-A3s, K2s-K8s, Q2s-Q8s, J2s-J7s, T2s-T7s, 94s-96s, 84s-86s, 73s-75s, 62s-64s, 52s-53s, 42s+, 32s, A3o-AJo, K6o-KJo, Q8o+, J8o+, T8o+, 98o, 87o, 76o, 65o, 54o',
  },
  CO: {
    threeBet: '99+, AJs+, A9s, A4s-A5s, KTs+, Q9s+, J9s+, T9s, 65s, 54s, AQo+',
    call: '22-88, ATs, A6s-A8s, A2s-A3s, K2s-K9s, Q3s-Q8s, J6s-J8s, T7s-T8s, 96s+, 85s+, 74s+, 63s-64s, 52s-53s, 43s, A8o-AJo, A5o, KTo+, QTo+, JTo, T9o',
  },
  HJ: {
    threeBet: 'TT+, AQs+, A9s, A4s-A5s, KTs+, K5s, QTs+, JTs, 65s, 54s, AKo',
    call: '22-99, ATs-AJs, A6s-A8s, A2s-A3s, K6s-K9s, K2s-K4s, Q5s-Q9s, J7s-J9s, T7s+, 96s+, 85s+, 74s+, 63s-64s, 53s, 43s, A9o-AQo, KTo+, QTo+, JTo',
  },
  UTG: {
    threeBet: 'JJ+, AQs+, A4s-A5s, KJs+, QJs, JTs, 65s, 54s, AKo',
    call: '22-TT, A6s-AJs, A2s-A3s, K2s-KTs, Q5s-QTs, J8s-J9s, T7s+, 96s+, 85s+, 74s+, 63s-64s, 53s, 43s, 32s, ATo-AQo, KJo+, QJo, JTo',
  },
  SB: {
    threeBet: '88+, ATs+, A4s-A5s, KTs+, QJs, J5s, T5s, 95s, 87s, 76s, 65s, 54s, AQo+, A6o, K5o-K6o, Q6o, J7o-J8o, T7o',
    call: '22-77, A6s-A9s, A2s-A3s, K2s-K9s, Q2s-QTs, J6s+, J2s-J4s, T6s+, T2s-T4s, 96s+, 92s-94s, 84s-86s, 73s-75s, 62s-64s, 52s-53s, 42s+, 32s, A7o-AJo, A2o-A5o, K7o+, Q7o+, J9o+, T8o+, 97o+, 86o+, 76o, 65o, 54o',
  },
};

/**
 * How much of its range the big blind defends against each seat. Not a fixed
 * number — it tracks how wide the opener is.
 *
 * And it is far wider than the "minimum defence frequency" would suggest.
 * MDF assumes the bluffs have no equity, and preflop that is badly false: the
 * worst hand a button opens still has about 30% against you. At 2.5bb MDF says
 * defend 37.5% and the solver defends 56.9%. Quoting MDF here teaches
 * over-folding, which is already the biggest leak in small-stakes poker.
 */
export const BB_DEFEND_PERCENT = { UTG: 28.8, HJ: 31.5, CO: 35.4, BTN: 56.9, SB: 64.7 };

export const BB_DEFENCE = Object.fromEntries(
  Object.entries(BB_DEFEND_TEXT).map(([pos, r]) => [pos, {
    threeBet: parseRange(r.threeBet),
    call: parseRange(r.call),
  }]),
);

/**
 * Facing an open from a seat in front of you, when you are not the big blind.
 * Narrower than BB defence at every position, because you are not already
 * invested and you have players still to act behind you.
 */
const VS_OPEN_TEXT = {
  // 5.6%. Polarised rather than linear: the top of the range plus the suited
  // wheel aces, which are here as blockers. A5s holds an ace, so it removes a
  // slice of exactly the hands that would continue against a 3-bet.
  threeBet: 'TT+, AQs+, A4s-A5s, KQs, AKo, AQo',
  // 10.6%, and it belongs to the BUTTON ALONE, because only the button closes
  // the action. Every other seat is 3-bet or fold: flatting from the hijack or
  // the cutoff invites a squeeze from the three players still behind you, and
  // you then fold having already put in 2.5bb. preflopPlan enforces this — it
  // hands back an empty calling range everywhere but the button.
  //
  // Nothing here overlaps the 3-betting range. An overlap is not a mixed
  // strategy, it is a chart that gives two answers to one question.
  call: '22-99, A9s-AJs, KTs-KJs, QTs-QJs, JTs, T9s, 98s, 87s, 76s, 65s, 54s, ATo-AJo, KQo',
};

export const VS_OPEN = {
  threeBet: parseRange(VS_OPEN_TEXT.threeBet),
  call: parseRange(VS_OPEN_TEXT.call),
};

/** 3-bet or fold. Shared by every seat that does not close the action. */
const NO_FLATTING = new Set();

/** Facing a 3-bet. Very tight, and it 4-bets rather than calling out of position. */
export const VS_THREE_BET = {
  fourBet: parseRange('QQ+, AKs, AKo, A5s-A4s'),
  call: parseRange('99-JJ, AQs, AJs, KQs, QJs, JTs, T9s, AQo'),
};

/**
 * Push/fold, for the stack depths a tournament reaches. Below about 15bb
 * there is no postflop left to play, so raise-to-2.5x stops making sense and
 * the only two options are all-in or fold.
 */
export const SHOVE = {
  10: {
    UTG: parseRange('44+, A7s+, KTs+, QJs, ATo+, KQo'),
    HJ: parseRange('33+, A4s+, K9s+, QTs+, JTs, A9o+, KJo+'),
    CO: parseRange('22+, A2s+, K7s+, Q9s+, J9s+, T9s, A7o+, KTo+, QJo'),
    BTN: parseRange('22+, A2s+, K5s+, Q8s+, J8s+, T8s+, 98s, A2o+, K9o+, QTo+, JTo'),
    SB: parseRange('22+, A2s+, K2s+, Q6s+, J7s+, T7s+, 97s+, 87s, A2o+, K7o+, Q9o+, J9o+, T9o'),
  },
  15: {
    UTG: parseRange('66+, A9s+, KJs+, AJo+'),
    HJ: parseRange('55+, A7s+, KTs+, QJs, ATo+, KQo'),
    CO: parseRange('33+, A5s+, K9s+, QTs+, JTs, A9o+, KJo+'),
    BTN: parseRange('22+, A2s+, K7s+, Q9s+, J9s+, T9s, A7o+, KTo+, QJo'),
    SB: parseRange('22+, A2s+, K5s+, Q8s+, J8s+, T8s+, A5o+, K9o+, QTo+, JTo'),
  },
};

/**
 * The leaks worth naming, because a student who can name a mistake stops
 * making it. Each is expensive, common, and mechanically detectable.
 */
export const LEAKS = {
  limping: {
    name: 'Limping',
    why: 'Calling the big blind gives up the pot you could have taken uncontested, and builds a pot out of position with a range you never got to define.',
  },
  overFoldingBB: {
    name: 'Over-folding the big blind',
    why: 'Facing a 2.5x open you need 27% to break even and you are already 1bb invested. Folding hands that clear that is handing over money every orbit.',
  },
  coldCall3Bet: {
    name: 'Cold-calling a 3-bet',
    why: 'You end up in a low-SPR pot, out of position, against a range that has already told you it is strong. Most of these hands are a 4-bet or a fold.',
  },
  earlyOffsuitBroadway: {
    name: 'Offsuit broadways from early position',
    // The hands named here are folded by the UTG chart and opened by the BTN
    // chart, and the tests assert exactly that. Naming a hand the chart opens
    // would have the coach contradict itself inside one screen.
    why: 'KTo and QTo look like hands and are dominated by everything that continues against them. They are folds under the gun and opens on the button — the seat decides, not the cards.',
  },
  callingOOP: {
    name: 'Calling 3-bets out of position',
    why: 'Out of position you realise about 80% of your equity. A hand that is a marginal call in position is a clear fold from the blinds.',
  },
  minRaising: {
    name: 'Min-raising',
    why: 'A 2x raise gives the big blind a price they cannot fold to, so you inflate the pot without narrowing the field. It is the worst of both.',
  },
  chasingWithoutOdds: {
    name: 'Chasing without the price',
    why: 'A flop call buys one card, not two. Compare your outs against o/47, and only add the two-card number when the money is already all in.',
  },
};

/** Which of the charts above applies to the spot in front of you. */
export function preflopPlan({ position, facing, openerPosition }) {
  if (!facing) {
    // The small blind opens larger than everyone else. It is the one seat that
    // is guaranteed to be out of position for the rest of the hand against the
    // only player left, so it buys more fold equity up front rather than play a
    // bloated pot from the wrong side of it.
    const sizing = position === 'SB' ? 3 : 2.5;
    return { kind: 'rfi', raise: RFI[position] ?? null, sizing };
  }
  if (facing === 'open') {
    if (position === 'BB') {
      const chart = BB_DEFENCE[openerPosition] ?? BB_DEFENCE.BTN;
      return { kind: 'defend', ...chart, sizing: 3.5 };
    }
    const closesAction = position === 'BTN';
    return {
      kind: 'vsOpen',
      threeBet: VS_OPEN.threeBet,
      call: closesAction ? VS_OPEN.call : NO_FLATTING,
      sizing: closesAction ? 3 : 4,
    };
  }
  if (facing === '3bet') return { kind: 'vs3bet', ...VS_THREE_BET, sizing: 2.3 };
  return { kind: 'unknown' };
}
