/**
 * The syllabus.
 *
 * A number on its own teaches nothing. "35.4%" is not a lesson; "you need 25%
 * to call and you have 35%, so this call makes money" is a lesson, and "that
 * is pot odds, and it is the same calculation every time you face a bet" is
 * the thing you can still use next week.
 *
 * So every decision in the Lab is tagged with the CONCEPT it exercises, and
 * the concept is what gets taught, tracked and drilled. The numbers become
 * evidence for a named idea rather than a readout.
 *
 * Each concept carries:
 *   id        stable key, used by the mastery tracker
 *   name      what it is called at a real table
 *   rank      curriculum order — you cannot understand MDF before pot odds
 *   needs     prerequisite ids, so the course can refuse to run ahead
 *   idea      ONE sentence. If it needs two, it is two concepts.
 *   rule      the thing to actually do, in the imperative
 *   why       the reasoning underneath, for the learner who asks
 *   trap      the specific mistake this concept exists to prevent
 *   applies   (spot, analysis) -> false | weight, where weight ranks which
 *             concept is most at stake when several fit
 *
 * `applies` returns a WEIGHT rather than a boolean because most spots exercise
 * three or four ideas at once, and a coach that lists all of them is back to
 * being a readout. The highest weight becomes the lesson; the rest stay
 * available behind a tap.
 */

import { CATEGORY } from './cards.js';

/**
 * Curriculum stages. The ordering is the standard one used by every reputable
 * training site, and it is not arbitrary — each stage needs the one before it.
 * You cannot reason about minimum defence frequency until you can compute a
 * price, and you cannot compute a price until you know what equity is.
 */
export const STAGES = [
  { id: 'foundations', name: 'Foundations', blurb: 'What a hand is worth, and what it costs to keep playing.' },
  { id: 'position', name: 'Position and ranges', blurb: 'Who acts last, and which hands belong in the pot at all.' },
  { id: 'postflop', name: 'Playing the flop', blurb: 'Betting, folding and the arithmetic of a draw.' },
  { id: 'pressure', name: 'Pressure', blurb: 'Bluffing, defending, and the frequencies that make both work.' },
  { id: 'stacks', name: 'Stack depth', blurb: 'How deep money changes every decision above.' },
];

const has = (analysis, draw) => analysis.hand?.draws?.some((d) => d.includes(draw));

export const CONCEPTS = [
  // ------------------------------------------------------- foundations --
  {
    id: 'equity',
    stage: 'foundations',
    rank: 1,
    name: 'Equity',
    needs: [],
    idea: 'Your equity is the share of the pot your hand wins if nobody folds and every card comes out.',
    rule: 'Judge a hand by how often it wins against what they can actually hold, not by how it looks.',
    why: 'Two cards have no value on their own. A pair of eights is huge against one opponent and close to '
      + 'worthless against three who all called a raise. Equity is the only measure that accounts for who you are up against.',
    trap: 'Falling in love with a hand because it is pretty. Suited cards win about 2% more often than the same cards offsuit.',
    applies: (spot, a) => (a.equity ? 0.2 : 0),
  },
  {
    id: 'potOdds',
    stage: 'foundations',
    rank: 2,
    name: 'Pot odds',
    needs: ['equity'],
    idea: 'The price the pot is laying you: what you must call, against what you stand to win.',
    rule: 'Call when your equity beats the price. The price is the call divided by the pot after your call.',
    why: 'Calling 100 into a pot of 300 risks 100 to win 300, so you need to be right 100/400 = 25% of the time. '
      + 'That is the whole calculation, and it is the same every single time you face a bet.',
    trap: 'Using the pot BEFORE their bet. That reads 33% where the answer is 25%, and it talks you out of calls that make money.',
    applies: (spot, a) => (spot.toCall > 0 ? 1 : 0),
  },
  {
    id: 'outs',
    stage: 'foundations',
    rank: 3,
    name: 'Counting outs',
    needs: ['potOdds'],
    idea: 'An out is a card that turns a losing hand into a winning one.',
    rule: 'Count the cards that actually improve you, then divide by the cards you have not seen — 47 on the flop, 46 on the turn.',
    why: 'Nine hearts complete a flush draw. On the flop there are 47 unseen cards, so the next card is a heart '
      + '9/47 = 19% of the time. That number, against the price, is the entire decision.',
    trap: 'Counting a card twice, or counting a card that gives someone else a better hand.',
    applies: (spot, a) => {
      if (!(a.outs?.strongOuts > 0 && spot.toCall > 0)) return 0;
      // A draw that is clearly short of the price is the cleanest lesson this
      // game offers: count, divide, compare, fold. Teach it loudly there, and
      // quietly when the answer is closer.
      const oneCard = a.outs.strongOuts / (spot.board.length === 4 ? 46 : 47);
      return oneCard < a.required * 0.75 ? 2.0 : 1.1;
    },
  },
  {
    id: 'oneCard',
    stage: 'foundations',
    rank: 4,
    name: 'One card, not two',
    needs: ['outs'],
    idea: 'Calling a flop bet buys you the turn. It does not buy you the river.',
    rule: 'Use outs ÷ 47 on the flop. Only double it when the money is already all in.',
    why: 'The famous "rule of 4" multiplies your outs by four to get your chance of hitting by the river — but that is '
      + 'only true if you get to see both cards for free. Facing a bet on the flop you are buying ONE card, and you '
      + 'will be charged again on the turn.',
    trap: 'The most expensive misconception in poker. Nine outs is 35% by the river and 19% right now, and the gap between '
      + 'those two numbers is where a whole session goes.',
    applies: (spot, a) => {
      if (!(a.outs?.strongOuts > 0 && spot.toCall > 0 && spot.board.length === 3)) return 0;
      // At its most acute when the two-card number clears the price and the
      // one-card number does not — the exact spot the misconception invents.
      const twoClears = a.outs.strongOuts / 47 < a.required && (a.outs.strongOuts * 2) / 47 > a.required;
      return twoClears ? 2.4 : 1.2;
    },
  },
  {
    id: 'impliedOdds',
    stage: 'foundations',
    rank: 5,
    name: 'Implied odds',
    needs: ['oneCard'],
    idea: 'The money you expect to win LATER when your draw gets there, on top of what is in the pot now.',
    rule: 'Only count implied odds when they can actually pay you: deep stacks, a hidden draw, and an opponent who calls.',
    why: 'A flush draw that is 4% short of the immediate price can still be a call if hitting it wins you another '
      + 'half-stack. But it has to be a draw they cannot see coming, against someone with chips who does not fold.',
    trap: 'Using implied odds as a licence to call anything. Against a short stack, or with an obvious draw, they are close to zero.',
    applies: (spot, a) => {
      if (!(a.outs?.strongOuts > 0 && spot.toCall > 0)) return 0;
      const short = a.outs.strongOuts / 47 < a.required;
      return short && spot.board.length < 5 ? 1.8 : 0;
    },
  },

  // ---------------------------------------------------------- position --
  {
    id: 'position',
    stage: 'position',
    rank: 6,
    name: 'Position',
    needs: ['equity'],
    idea: 'Acting last means you see every decision before you make yours.',
    rule: 'Play more hands in position and fewer out of it. Treat marginal spots out of position as folds.',
    why: 'Out of position you realise about 80% of your raw equity, and in position about 115%. The cards are the '
      + 'same; what changes is that you can control the size of the pot when you act last and cannot when you do not.',
    trap: 'Playing the same range from every seat. It is the single most common reason a losing player loses.',
    applies: (spot, a) => (Math.abs(a.realisation - 1) > 0.08 ? 1.3 : 0),
    // Position applies on every street; it is the one idea that never stops
    // being the answer.
  },
  {
    id: 'openingRanges',
    stage: 'position',
    rank: 7,
    name: 'Opening ranges',
    needs: ['position'],
    idea: 'Which hands are worth raising first-in depends almost entirely on your seat.',
    rule: 'Open about 17% under the gun and about 43% on the button. Raise to 2.5 big blinds, never limp.',
    why: 'Under the gun there are five players who can wake up with a better hand. On the button there are two, and '
      + 'you will act last for the rest of the hand. That is why the button opens more than twice as many hands.',
    trap: 'Limping. Calling the big blind gives up the pot you could have taken uncontested and builds a pot out of '
      + 'position with a range you never defined.',
    applies: (spot, a) => (spot.board.length === 0 && spot.toCall === 0 && spot.position !== 'BB' ? 2.2 : 0),
  },
  {
    id: 'blindDefence',
    stage: 'position',
    rank: 8,
    name: 'Defending the big blind',
    needs: ['potOdds', 'openingRanges'],
    idea: 'You have already paid a big blind, so you are getting a price nobody else at the table is getting.',
    rule: 'Against a 2.5x open you need 27% to break even. Defend wide — around 57% against a button, 29% against under the gun.',
    why: 'The pot is 4 big blinds and the call is 1.5, so almost any two cards clear the price on raw equity. What stops '
      + 'you defending everything is that you play the rest of the hand out of position and collect only about 80% of it.',
    trap: 'Over-folding. It is the biggest leak in small-stakes poker, and it is invisible — you never see the pots you '
      + 'gave away without a fight.',
    applies: (spot, a) => (spot.board.length === 0 && spot.position === 'BB' && spot.toCall > 0 ? 2.4 : 0),
  },
  {
    id: 'domination',
    stage: 'position',
    rank: 9,
    name: 'Domination',
    needs: ['openingRanges'],
    idea: 'A hand is dominated when the hands that call it share its high card and out-kick it.',
    rule: 'Be suspicious of offsuit broadway hands from early seats. KTo makes top pair and loses to every better kicker.',
    why: 'When KTo flops top pair it is up against AK, KQ and KJ, and it beats none of them. The times it wins are the '
      + 'times everyone folds anyway. That is a hand that only ever wins small pots and loses big ones.',
    trap: 'Confusing "makes a pair often" with "makes money". Ace-rag offsuit makes top pair constantly and is a fold from every seat.',
    applies: (spot, a) => {
      if (spot.board.length !== 0) return 0;
      const cls = a.hand?.class ?? '';
      return /^[AKQJT][AKQJT]o$/.test(cls) || /^A[2-9]o$/.test(cls) ? 1.6 : 0;
    },
  },

  // ---------------------------------------------------------- postflop --
  {
    id: 'valueBetting',
    stage: 'postflop',
    rank: 10,
    name: 'Value betting',
    needs: ['equity'],
    idea: 'A value bet is one you want called, because worse hands will call it.',
    rule: 'Bet when a worse hand can call. If only better hands continue, check.',
    why: 'The money in poker comes from bets that get called by second best. Ask one question before betting: '
      + 'name a worse hand that calls. If you cannot name one, you are not value betting, you are bluffing.',
    trap: 'Betting a medium hand into a range that only continues with better. That folds out everything you beat and '
      + 'gets called by everything that beats you.',
    applies: (spot, a) => (spot.board.length >= 3 && spot.canCheck && a.equity?.equity >= 0.62 ? 1.9 : 0),
  },
  {
    id: 'showdownValue',
    stage: 'postflop',
    rank: 11,
    name: 'Showdown value',
    needs: ['valueBetting'],
    idea: 'A hand that beats bluffs but loses to value belongs in a checking range.',
    rule: 'Check hands that are too good to fold and not good enough to bet.',
    why: 'Middle pair wins a lot of pots at showdown and none of them by betting. Betting it makes worse hands fold '
      + 'and better hands call — the exact opposite of what a bet is for.',
    trap: 'Betting third pair on the river "to find out where you are". You find out by checking, for free.',
    applies: (spot, a) => {
      if (spot.board.length < 3 || !spot.canCheck) return 0;
      const eq = a.equity?.equity ?? 0;
      const drawing = (a.outs?.strongOuts ?? 0) >= 8;
      return eq > 0.42 && eq < 0.62 && !drawing ? 1.7 : 0;
    },
  },
  {
    id: 'semiBluff',
    stage: 'postflop',
    rank: 12,
    name: 'Semi-bluffing',
    needs: ['outs', 'valueBetting'],
    idea: 'Betting a draw wins two ways: they fold now, or you hit later.',
    rule: 'Bet your good draws rather than calling with them. A flush draw with two overcards is a bet, not a call.',
    why: 'A pure bluff needs them to fold. A semi-bluff does not — when it gets called you still have nine outs. '
      + 'That second way of winning is what makes it the most profitable bet in poker.',
    trap: 'Only betting made hands. If you bet strong hands and call with draws, everyone at the table can read you.',
    applies: (spot, a) => {
      if (spot.board.length < 3) return 0;
      const drawing = (a.outs?.strongOuts ?? 0) >= 8;
      return drawing && spot.canRaise && (a.equity?.equity ?? 0) < 0.6 ? 2.0 : 0;
    },
  },
  {
    id: 'boardTexture',
    stage: 'postflop',
    rank: 13,
    name: 'Board texture',
    needs: ['equity'],
    idea: 'A flop that connects with many hands is dangerous; one that connects with few is safe to bet.',
    rule: 'Bet small and often on dry, disconnected boards. Bet bigger and less often on wet, coordinated ones.',
    why: 'On A-7-2 rainbow almost nothing improves, so a small bet does the job. On J-T-9 with two hearts, half the '
      + 'deck changes the hand — a small bet just prices in every draw.',
    trap: 'Using one bet size on every board. Your sizing should describe the board, not your hand.',
    applies: (spot, a) => (spot.board.length >= 3 && spot.canCheck ? 0.9 : 0),
  },

  // ---------------------------------------------------------- pressure --
  {
    id: 'foldEquity',
    stage: 'pressure',
    rank: 14,
    name: 'Fold equity',
    needs: ['potOdds'],
    idea: 'The value of a bet that wins the pot without a showdown.',
    rule: 'Before bluffing, ask how often it must work. A pot-sized bluff needs to work half the time.',
    why: 'Risking 100 to win a pot of 100 breaks even at 50% folds. Risking 50 to win 100 breaks even at 33%. '
      + 'Smaller bluffs need to work less often, which is why cheap bluffs are the ones that print.',
    trap: 'Bluffing without asking the question. Most losing bluffs are bets that would need to work 70% of the time.',
    applies: (spot, a) => (spot.board.length >= 3 && spot.canRaise
      && (a.equity?.equity ?? 0) < 0.4 && (a.outs?.strongOuts ?? 0) < 8 ? 1.5 : 0),
  },
  {
    id: 'mdf',
    stage: 'pressure',
    rank: 15,
    name: 'Minimum defence frequency',
    needs: ['foldEquity'],
    idea: 'How much of your range you must continue with so that betting any two cards does not print money.',
    rule: 'Against a half-pot bet defend about two thirds of your range. Against a pot-sized bet, half.',
    why: 'If you fold too often, their bluffs become free money regardless of what they hold. MDF is the frequency '
      + 'at which you are no longer exploitable by a bet of that size.',
    trap: 'Applying it to one hand. MDF is a property of your whole range — it tells you how many hands to continue '
      + 'with, not whether THIS hand is a call.',
    applies: (spot, a) => (spot.toCall > 0 && spot.board.length >= 3 ? 1.4 : 0),
  },
  {
    id: 'bluffCatching',
    stage: 'pressure',
    rank: 16,
    name: 'Bluff-catching',
    needs: ['mdf'],
    idea: 'Calling with a hand that beats only their bluffs.',
    rule: 'Against a river bet, you only need the price. Ask how many bluffs they have, not whether you have a good hand.',
    why: 'Your hand beats every bluff and loses to every value bet, so its absolute strength is irrelevant. '
      + 'The only question is the ratio of bluffs to value in the range that bets there.',
    trap: 'Folding a bluff-catcher because it "is only one pair". One pair is exactly what a bluff-catcher is.',
    applies: (spot, a) => {
      if (!(spot.toCall > 0 && spot.board.length === 5)) return 0;
      const made = a.hand?.madeCategory;
      return made !== undefined && made <= CATEGORY.TWO_PAIR ? 2.1 : 0.8;
    },
  },

  // ------------------------------------------------------------ stacks --
  {
    id: 'spr',
    stage: 'stacks',
    rank: 17,
    name: 'Stack-to-pot ratio',
    needs: ['potOdds'],
    idea: 'The stack behind, divided by the pot, decides how strong a hand needs to be to play for everything.',
    rule: 'At an SPR under 3, top pair is usually committing. Above 10, you need two pair or better.',
    why: 'SPR tells you how many bets are left. With one bet behind, a strong pair is enough. With four bets behind, '
      + 'the money goes in only when someone has a genuinely big hand — and it will not be the pair.',
    trap: 'Playing every flop the same way regardless of stack depth. The same top pair is a shove at SPR 2 and a '
      + 'one-street hand at SPR 12.',
    applies: (spot, a) => (Number.isFinite(a.spr) && a.spr < 4 && spot.board.length >= 3 ? 1.6 : 0.4),
  },
  {
    id: 'realisation',
    stage: 'stacks',
    rank: 18,
    name: 'Equity realisation',
    needs: ['position', 'spr'],
    idea: 'You do not collect all of your equity — you collect the part you get to the river with.',
    rule: 'Discount your equity out of position and add to it in position, before comparing it to the price.',
    why: 'Raw equity assumes the hand gets checked down, which never happens. Out of position you will be bet off '
      + 'hands that were ahead, so about a fifth of the equity you are counting never arrives.',
    trap: 'Comparing raw equity to the price and calling. The comparison has to be made with the equity you will '
      + 'actually realise, which out of position is meaningfully lower.',
    applies: (spot, a) => (a.realisation < 0.92 && spot.toCall > 0 ? 1.75 : 0),
  },
];

export const CONCEPT_BY_ID = Object.fromEntries(CONCEPTS.map((c) => [c.id, c]));

/** Curriculum order, which is also the order the course screen lists them in. */
export const ORDERED = [...CONCEPTS].sort((a, b) => a.rank - b.rank);

/**
 * Which idea is most at stake in this spot.
 *
 * Returns the concepts that apply, best first. The caller teaches the head of
 * the list and keeps the tail available — showing all of them at once is how
 * you get back to a wall of statistics with no lesson in it.
 */
export function conceptsFor(spot, analysis) {
  const scored = [];
  for (const c of CONCEPTS) {
    let weight = 0;
    try {
      weight = c.applies(spot, analysis) || 0;
    } catch {
      weight = 0; // a detector must never be able to break the coach
    }
    if (weight > 0) scored.push({ concept: c, weight });
  }
  scored.sort((a, b) => b.weight - a.weight || a.concept.rank - b.concept.rank);
  return scored;
}

/** The single idea to teach here, or null if the spot is not teaching anything. */
export function primaryConcept(spot, analysis) {
  return conceptsFor(spot, analysis)[0]?.concept ?? null;
}

/** Prerequisites first, so a course never introduces an idea out of order. */
export function unlockOrder() {
  const done = new Set();
  const out = [];
  const visit = (c) => {
    if (done.has(c.id)) return;
    done.add(c.id);
    for (const need of c.needs) {
      const dep = CONCEPT_BY_ID[need];
      if (dep) visit(dep);
    }
    out.push(c);
  };
  for (const c of ORDERED) visit(c);
  return out;
}

/**
 * Mastery, per concept.
 *
 * Not a pass/fail and not a raw average. A learner who got a concept wrong ten
 * hands ago and right five times since has learned it, and a score that
 * remembers the ten forever tells them otherwise — so this is an exponential
 * moving average, which forgets at a rate you can state: after n more
 * decisions, an old result is worth (1 - ALPHA)^n of what it was.
 */
const ALPHA = 0.25;

export function emptyMastery() {
  return {};
}

/**
 * Record one graded decision against a concept.
 * `quality` is 0..1 — 1 for the best line, 0 for a blunder.
 */
export function recordMastery(mastery, conceptId, quality) {
  const prior = mastery[conceptId] ?? { score: 0.5, seen: 0, right: 0 };
  const q = Math.max(0, Math.min(1, quality));
  mastery[conceptId] = {
    score: prior.score + ALPHA * (q - prior.score),
    seen: prior.seen + 1,
    right: prior.right + (q >= 0.75 ? 1 : 0),
  };
  return mastery;
}

/** Bands, so the UI never has to invent its own thresholds. */
export const MASTERY_BANDS = [
  { id: 'new', label: 'Not seen yet', min: -1 },
  { id: 'shaky', label: 'Shaky', min: 0 },
  { id: 'getting', label: 'Getting there', min: 0.55 },
  { id: 'solid', label: 'Solid', min: 0.75 },
  { id: 'sharp', label: 'Sharp', min: 0.9 },
];

export function bandFor(entry) {
  // Three decisions is the floor for saying anything at all. Below that the
  // score is one lucky guess away from claiming mastery.
  if (!entry || entry.seen < 3) return MASTERY_BANDS[0];
  return [...MASTERY_BANDS].reverse().find((b) => entry.score >= b.min) ?? MASTERY_BANDS[1];
}

/**
 * What to work on next.
 *
 * The weakest concept whose prerequisites you have already got to grips with —
 * because drilling minimum defence frequency at somebody who cannot compute a
 * price is how training apps lose people.
 */
export function nextUp(mastery) {
  const ready = unlockOrder().filter((c) => {
    const entry = mastery[c.id];
    if (bandFor(entry).id === 'sharp') return false;
    return c.needs.every((n) => {
      const dep = mastery[n];
      return dep && dep.score >= 0.55;
    });
  });
  if (!ready.length) return null;
  // Weakest first, but an unseen concept counts as 0.5 so the course keeps
  // introducing new ideas instead of grinding one weakness forever.
  return ready.sort((a, b) => {
    const sa = mastery[a.id]?.score ?? 0.5;
    const sb = mastery[b.id]?.score ?? 0.5;
    return sa - sb || a.rank - b.rank;
  })[0];
}

/** A compact progress summary for the course screen. */
export function progress(mastery) {
  const rows = ORDERED.map((c) => {
    const entry = mastery[c.id];
    return {
      id: c.id,
      name: c.name,
      stage: c.stage,
      rank: c.rank,
      seen: entry?.seen ?? 0,
      score: entry?.score ?? null,
      band: bandFor(entry),
    };
  });
  const started = rows.filter((r) => r.seen >= 3);
  return {
    rows,
    stages: STAGES.map((s) => {
      const inStage = rows.filter((r) => r.stage === s.id);
      const solid = inStage.filter((r) => r.band.id === 'solid' || r.band.id === 'sharp').length;
      return { ...s, total: inStage.length, solid };
    }),
    solid: started.filter((r) => r.band.id === 'solid' || r.band.id === 'sharp').length,
    total: rows.length,
    next: nextUp(mastery),
  };
}
