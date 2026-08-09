/**
 * THE LAB — hold'em against AI opponents, with a coach reading over your
 * shoulder.
 *
 * A separate game from multiplayer hold'em rather than a mode inside it. The
 * rules engine is shared and untouched; what differs is that most of the seats
 * are bots, one human decision drives the whole table, and every action you
 * take gets a number attached to it.
 *
 * The teaching loop, in the order the evidence says it works:
 *   1. you see the spot and the numbers, but NOT what the bots hold
 *   2. you commit — no undo, no peeking at the answer first
 *   3. immediate feedback: EV of what you did, EV of the best line, the gap
 *   4. only then the runout, explicitly labelled as irrelevant to the grade
 *
 * Step 4 is the one that matters most and is the easiest to get wrong. People
 * rate identical decisions as better when the outcome happened to be good, and
 * poker is the purest machine ever built for learning the wrong lesson from a
 * win. So the grade lands before the cards do.
 */

import { makeRng, randInt, shuffle } from '../../shared/rng.js';
import { clampInt, oneOf } from '../engine.js';
import * as holdem from './index.js';
import { PERSONALITIES, PERSONALITY_IDS, applyResult, decide, makeBot } from './bots.js';
import { analyse, emptyScorecard, grade, qualityOf, record, summarise } from './coach.js';
import { emptyMastery, progress, recordMastery } from './concepts.js';
import { POSITION_NAME, POSITIONS } from './ranges.js';

export const meta = {
  id: 'pokerlab',
  name: 'The Lab',
  tagline: 'Hold’em against bots, with the maths shown.',
  blurb:
    'Play no-limit hold’em against opponents that each have one exploitable habit, with a coach that shows your equity, the price you are getting, and what the best line was — graded in big blinds, before you see the cards.',
  minPlayers: 1,
  maxPlayers: 4,
  familiar: 'Poker trainer',
  emblem: 'g-pokerlab',
  lengthMinutes: 'as long as you like',
  solo: true,
};

/**
 * Coaching modes.
 *
 * `learn` is the default and it is the one that actually teaches. You see only
 * what exists at a real table, you commit, and THEN you get the numbers and
 * the reasoning. The evidence for that ordering is unusually strong: feedback
 * reliably helps only when the learner attempted the problem first, and being
 * shown the answer before committing turns "play poker" into "read a
 * dashboard", which is a different skill and does not transfer to a table
 * where the dashboard is absent.
 *
 * `guided` shows the numbers while you decide. It is genuinely useful for a
 * first session — you cannot commit to an answer in a language you do not
 * speak yet — and it is what most poker software does. It is not the default,
 * because staying in it is how people plateau.
 */
export const COACH_MODES = ['learn', 'guided', 'off'];

/**
 * When the table holds still for you.
 *
 * Feedback that scrolls past while the next card is being dealt is feedback
 * nobody read. So after a graded decision the table STOPS and waits for you to
 * acknowledge the coaching before anything else happens — the bots do not act,
 * the street does not turn, nothing moves until you have seen it.
 *
 * `mistakes` exists because acknowledging forty correct decisions in a session
 * is friction with no lesson in it, and friction is what makes people stop
 * practising. It is not the default: you asked to be stopped, and being
 * stopped on a decision you got right is where you find out WHY it was right.
 */
export const PAUSE_MODES = ['always', 'mistakes', 'never'];

/** Grades that count as "worth stopping for" under `mistakes`. */
const WORTH_STOPPING = new Set(['leak', 'mistake', 'blunder']);

export const defaultConfig = {
  startingStack: 2000,
  actionSeconds: 0, // no clock: this is practice, thinking is the point
  table: 'mixed',
  coach: 'learn',
  pause: 'always',
};

export function normalizeConfig(config) {
  return {
    startingStack: clampInt(config.startingStack, 500, 20000, 2000),
    actionSeconds: 0,
    table: oneOf(config.table, ['mixed', 'loose', 'tough'], 'mixed'),
    // 'full' and 'quiet' were the old names; keep them working rather than
    // silently resetting a room that was configured before this existed.
    coach: oneOf(
      { full: 'guided', quiet: 'off' }[config.coach] ?? config.coach,
      COACH_MODES,
      'learn',
    ),
    pause: oneOf(config.pause, PAUSE_MODES, 'always'),
  };
}

/** Bot pacing. Long enough to read the table, short enough not to wait on it. */
const BOT_THINK_MS = 900;
const HANDOVER_MS = 60_000; // you deal the next hand when you are ready
const ACK_MS = 180_000;     // a held table releases itself after three minutes

const TABLES = {
  mixed: ['mercy', 'kaz', 'rocky'],
  loose: ['mercy', 'blaze', 'vera'],
  tough: ['sol', 'kaz', 'vera'],
};

// -------------------------------------------------------------------- start --

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const humans = room.players.filter((p) => !p.bot);
  const wanted = TABLES[room.config.table] ?? TABLES.mixed;
  const ids = shuffle(PERSONALITY_IDS.filter((p) => wanted.includes(p)), rng);

  // Seat bots for every chair the humans did not take.
  const seatCount = Math.max(2, Math.min(4, humans.length + wanted.length));
  const bots = [];
  for (let i = 0; humans.length + bots.length < seatCount; i++) {
    const personality = ids[i % ids.length];
    const id = `bot:${personality}:${i}`;
    bots.push({
      id,
      tok: id,
      name: PERSONALITIES[personality].name,
      seat: humans.length + i,
      left: false,
      bot: true,
      personality,
    });
  }
  // The lobby's player list is what the hand engine deals to, so the bots have
  // to live there — they are seats at the table, not an overlay on top of one.
  room.players = [...humans, ...bots];

  const game = holdem.start(room, seed, now);
  game.lab = {
    bots: Object.fromEntries(bots.map((b, i) => [b.id, makeBot(b.id, b.personality, (seed ^ (i * 2654435761)) >>> 0)])),
    humanIds: humans.map((p) => p.id),
    scorecards: Object.fromEntries(humans.map((p) => [p.id, emptyScorecard()])),
    // What each student has actually learned, per named concept, rather than
    // one undifferentiated "you lose 8bb/100". A score you cannot act on is
    // not feedback.
    mastery: Object.fromEntries(humans.map((p) => [p.id, emptyMastery()])),
    advice: null,
    // The analysis that produced the last grade, kept so the feedback screen
    // can show what each line was worth. It is sent UNREDACTED whatever the
    // mode — the whole point of learn mode is that the numbers arrive the
    // moment you have committed, not that they never arrive.
    lastAdvice: null,
    lastGrade: null,
    // Who the table is waiting on to acknowledge their feedback. While this is
    // set, nothing advances — not the bots, not the street, not the deal.
    awaiting: null,
    // Held back until the hand is over, so the runout never colours the grade.
    pending: [],
    revealBots: false,
  };
  // The lobby assigns this too, but everything below reads room.game and runs
  // before start() has returned.
  room.game = game;
  // The button decides who acts first, and about half the time that is a bot.
  // Leaving the deadline null there means the lobby schedules no alarm, no bot
  // ever acts, and the very first hand stalls before the flop with nobody at
  // the table to press anything. Put the table on its own clock from the deal.
  scheduleNext(room, now);
  return game;
}

// ------------------------------------------------------------------ helpers --

const isBot = (room, id) => room.players.find((p) => p.id === id)?.bot === true;

/** Which seat, in poker terms, relative to the button. */
function positionOf(g, seatIndex) {
  const live = g.seats.filter((s) => s.inHand).length;
  const fromButton = (seatIndex - g.buttonIndex + g.seats.length) % g.seats.length;
  if (fromButton === 0) return 'BTN';
  if (fromButton === 1) return live === 2 ? 'BB' : 'SB';
  if (fromButton === 2) return 'BB';
  return POSITIONS[Math.max(0, POSITIONS.length - 1 - fromButton)] ?? 'UTG';
}

function viewForBot(room, g, seat, index) {
  const v = holdem.viewFor(room, seat.id);
  return {
    hole: seat.hole,
    board: g.board,
    street: g.street,
    pot: v.potTotal,
    toCall: v.legal?.callAmount ?? Math.max(0, g.round.currentBet - seat.committedThisRound),
    minRaiseTo: v.legal?.minRaiseTo || g.round.currentBet + g.round.lastFullRaiseSize,
    maxRaiseTo: v.legal?.maxRaiseTo || seat.committedThisRound + seat.stack,
    canCheck: g.round.currentBet <= seat.committedThisRound,
    canRaise: seat.committedThisRound + seat.stack > g.round.currentBet,
    bigBlind: v.blinds.bb,
    position: positionOf(g, index),
    seatsIn: g.seats.filter((s) => s.inHand && !s.folded).length,
    handNo: g.handNo,
  };
}

/** The advice panel for whoever is on the clock, recomputed when the spot changes. */
function refreshAdvice(room, now) {
  const g = room.game;
  if (g.phase !== 'hand' || g.actor < 0) {
    g.lab.advice = null;
    return;
  }
  const seat = g.seats[g.actor];
  // The analysis is still computed in `learn` mode — it has to be, because the
  // grade that lands the moment you act is derived from it. What changes is
  // how much of it viewFor is willing to put on the wire before you commit.
  if (isBot(room, seat.id) || room.config.coach === 'off') {
    g.lab.advice = null;
    return;
  }
  const v = holdem.viewFor(room, seat.id);
  if (!v.legal) {
    g.lab.advice = null;
    return;
  }
  const index = g.seats.indexOf(seat);
  g.lab.advice = analyse({
    hole: seat.hole,
    board: g.board,
    street: g.street,
    pot: v.potTotal,
    toCall: v.legal.callAmount,
    minRaiseTo: v.legal.minRaiseTo,
    maxRaiseTo: v.legal.maxRaiseTo,
    canCheck: v.legal.check,
    canRaise: v.legal.raise,
    bigBlind: v.blinds.bb,
    stack: seat.stack,
    position: positionOf(g, index),
    opponents: g.seats.filter((s) => s.inHand && !s.folded && s.id !== seat.id).length,
    villainWidth: averageWidth(room, g),
  });
}

/** How wide the remaining opponents are, so equity is measured against them. */
function averageWidth(room, g) {
  const live = g.seats.filter((s) => s.inHand && !s.folded && isBot(room, s.id));
  if (!live.length) return 0.35;
  let total = 0;
  for (const s of live) {
    const bot = g.lab.bots[s.id];
    const rfi = bot?.p?.rfi?.BTN ?? 0.4;
    total += Math.min(0.9, rfi * 1.6);
  }
  return total / live.length;
}

// ------------------------------------------------------------------ actions --

export function action(room, playerId, act, now) {
  const g = room.game;
  if (act.type === 'act') {
    const seat = g.seats[g.actor];
    if (!seat || seat.id !== playerId) return { error: 'not_your_turn' };

    // Grade BEFORE the action resolves, while the spot still exists.
    let graded = null;
    const advice = g.lab.advice;
    if (advice) {
      graded = grade(advice, { move: act.move, to: act.to });
      record(g.lab.scorecards[playerId] ?? emptyScorecard(), graded);
      // Credit the concept the spot was actually teaching. The lesson is
      // chosen from the spot, not from what the player did, so a fold and a
      // call in the same spot advance the same idea — one of them further.
      const learning = g.lab.mastery[playerId];
      if (learning && advice.lesson) {
        recordMastery(learning, advice.lesson.id, qualityOf(graded));
      }
    }

    const outcome = holdem.action(room, playerId, act, now);
    if (outcome.error) return outcome;

    g.lab.lastGrade = graded;
    g.lab.lastAdvice = graded ? advice : null;
    // Hold the table. Only mid-hand: when the action ends the hand there is
    // already a "Next hand" gate on the handover screen, and making somebody
    // tap twice to get past one piece of feedback is not more teaching, it is
    // just another tap.
    if (graded && g.phase === 'hand' && shouldPause(room, graded)) {
      g.lab.awaiting = playerId;
    }
    return afterAnyAction(room, now, outcome);
  }

  if (act.type === 'deal') {
    if (g.phase !== 'handover') return { error: 'wrong_phase' };
    g.lab.awaiting = null;
    g.lab.revealBots = false;
    g.lab.lastGrade = null;
    g.lab.lastAdvice = null;
    const outcome = holdem.action(room, playerId, act, now) ?? {};
    return afterAnyAction(room, now, outcome);
  }

  // "I have read it." The only thing that releases a held table.
  if (act.type === 'ack') {
    if (g.lab.awaiting !== playerId) return { error: 'nothing_to_acknowledge' };
    g.lab.awaiting = null;
    return afterAnyAction(room, now, {});
  }

  // The runout is deliberately hidden until you ask for it, so the grade
  // always lands first.
  if (act.type === 'reveal') {
    g.lab.revealBots = true;
    return {};
  }

  return { error: 'unknown_action' };
}

/**
 * Bots act on the alarm rather than inside this call, so the table paces
 * itself and you watch each decision land instead of seeing four at once.
 */
/** Is this grade worth stopping the table for? */
function shouldPause(room, graded) {
  const mode = room.config.pause ?? 'always';
  if (mode === 'never') return false;
  if (mode === 'mistakes') return WORTH_STOPPING.has(graded.grade);
  return true;
}

function scheduleNext(room, now) {
  const g = room.game;
  if (g.lab.awaiting) {
    // Held. A long fuse rather than no clock at all, so a closed tab releases
    // the table eventually instead of leaving it stopped forever — but long
    // enough that reading the feedback is never a race.
    g.deadline = now + ACK_MS;
    return;
  }
  if (g.phase === 'hand' && g.actor >= 0 && isBot(room, g.seats[g.actor].id)) {
    g.deadline = now + BOT_THINK_MS;
  } else if (g.phase === 'handover') {
    g.deadline = now + HANDOVER_MS;
    settleTilt(room);
  } else {
    // A human on the clock has no deadline at all. Thinking is the point, and
    // a trainer that times you out is teaching you to guess.
    g.deadline = null;
  }
  refreshAdvice(room, now);
}

function afterAnyAction(room, now, outcome) {
  scheduleNext(room, now);
  return outcome;
}

export function onDeadline(room, now) {
  const g = room.game;

  // Nobody acknowledged. Release rather than stay stopped forever.
  if (g.lab.awaiting) {
    g.lab.awaiting = null;
    return afterAnyAction(room, now, {});
  }

  if (g.phase === 'handover') {
    // Nobody dealt for a full minute; deal anyway so the table never stalls.
    const outcome = holdem.onDeadline(room, now) ?? {};
    g.lab.revealBots = false;
    g.lab.lastGrade = null;
    g.lab.lastAdvice = null;
    return afterAnyAction(room, now, outcome);
  }

  if (g.phase !== 'hand' || g.actor < 0) return {};
  const seat = g.seats[g.actor];
  if (!isBot(room, seat.id)) {
    // A human has no clock in the lab. Thinking is the whole point.
    g.deadline = null;
    return {};
  }

  const bot = g.lab.bots[seat.id];
  const index = g.seats.indexOf(seat);
  const move = decide(bot, viewForBot(room, g, seat, index));
  const outcome = holdem.action(room, seat.id, { type: 'act', move: move.move, to: move.to }, now);
  if (outcome.error) {
    // A bot must never wedge the table. Fall back to the safest legal action.
    const fallback = holdem.action(room, seat.id, { type: 'act', move: 'fold' }, now);
    return afterAnyAction(room, now, fallback ?? {});
  }
  seat.lastReason = move.why;
  return afterAnyAction(room, now, outcome);
}

function settleTilt(room) {
  const g = room.game;
  for (const seat of g.seats) {
    const bot = g.lab.bots[seat.id];
    if (!bot) continue;
    const won = g.result?.won?.[seat.id] ?? 0;
    applyResult(bot, { lostChips: Math.max(0, seat.totalCommitted - won), stack: seat.stack + seat.totalCommitted });
  }
}

// --------------------------------------------------------------------- view --

/**
 * How much of the analysis a mode is willing to show BEFORE you act.
 *
 * `learn` sends the name of the concept and nothing else — no equity, no
 * price, no recommended action, no option list. A curious player cannot read
 * the answer out of the network tab, because the answer was never sent.
 */
function forMode(advice, mode) {
  if (!advice) return null;
  if (mode !== 'learn') return advice;
  return {
    prompt: true,
    street: advice.street,
    position: advice.position,
    // Feed-up only: what this decision is testing, never what the answer is.
    lesson: advice.lesson
      ? { id: advice.lesson.id, name: advice.lesson.name, stage: advice.lesson.stage }
      : null,
  };
}

export function viewFor(room, viewerId) {
  const g = room.game;
  const base = holdem.viewFor(room, viewerId);
  const lab = g.lab;
  const me = g.seats.find((s) => s.id === viewerId);

  return {
    ...base,
    game: 'pokerlab',
    lab: true,
    // The bots' cards stay down until the hand is over AND you have asked —
    // the grade lands first, always.
    seats: base.seats.map((s) => {
      const player = room.players.find((p) => p.id === s.id);
      const bot = lab.bots[s.id];
      return {
        ...s,
        bot: Boolean(player?.bot),
        personality: player?.personality ?? null,
        tell: bot ? PERSONALITIES[player.personality]?.tell : null,
        reason: g.phase !== 'hand' ? (g.seats.find((x) => x.id === s.id)?.lastReason ?? null) : null,
        hole: lab.revealBots || s.id === viewerId ? s.hole : null,
      };
    }),
    // THE REDACTION THAT MAKES IT A TRAINER RATHER THAN A CALCULATOR.
    //
    // In `learn` mode the numbers do not go on the wire until you have acted.
    // Not hidden by CSS, not collapsed behind a tap — absent, the same way a
    // real table is absent of them. What you do get is the name of the idea
    // the spot is testing, which is the "where am I going" half of feedback
    // and costs nothing pedagogically because it does not contain the answer.
    // Nothing about the NEXT decision while you are still being held on the
    // last one. When your action closes a betting round you can be on the
    // clock again instantly, and `lab.advice` still describes the spot you
    // just played — sending it would caption the new decision with the old
    // one's numbers.
    advice: !lab.awaiting && g.actor >= 0 && g.seats[g.actor]?.id === viewerId
      ? forMode(lab.advice, room.config.coach)
      : null,
    coach: room.config.coach,
    pause: room.config.pause,
    // No visible clock while the table is held. The fuse exists so a closed
    // tab cannot stop the room forever; showing it as a countdown would turn
    // "read this" into "read this quickly", which is the opposite of the
    // point — a trainer that times you out is teaching you to guess.
    deadline: lab.awaiting ? null : base.deadline,
    // The table is stopped, waiting on YOU. The client turns this into the
    // one button on screen.
    awaiting: lab.awaiting === viewerId,
    lastGrade: lab.lastGrade,
    lastAdvice: lab.lastAdvice,
    revealed: lab.revealBots,
    scorecard: summarise(lab.scorecards[viewerId] ?? emptyScorecard()),
    // Where you are sitting, in poker words. Preflop this is the most useful
    // sentence available beside your cards, and the shared hold'em row had
    // "Waiting for the flop" there instead.
    myPosition: me ? POSITION_NAME[positionOf(g, g.seats.indexOf(me))] ?? null : null,
    course: progress(lab.mastery?.[viewerId] ?? emptyMastery()),
    myStack: me?.stack ?? 0,
  };
}

export const rulesText = [
  {
    h: 'What this is',
    p: 'No-limit hold’em against three bots, with the maths shown while you decide. Same rules as the real game — the difference is that every choice you make gets a number attached to it.',
  },
  {
    h: 'The numbers',
    p: 'Your equity against what they can actually hold, the price the pot is laying you, your outs, and the stack-to-pot ratio. Equity is sampled and shows its error bar; pot odds are arithmetic and do not.',
  },
  {
    h: 'The grade',
    p: 'After you act you get the EV of your choice against the EV of the best one, in big blinds. Under 0.05 is the same decision. Over 1 is a blunder. If two lines are within a hair, it says so instead of inventing a winner.',
  },
  {
    h: 'Why the cards stay down',
    p: 'You get graded before you see the runout. People rate the same decision as better when it happened to win, and poker is the best machine ever built for learning the wrong lesson. Judge the choice, then look.',
  },
  {
    h: 'The opponents',
    p: 'Each bot has one exploitable habit and it is written on their seat. Mercy never folds, so stop bluffing her. Rocky folds his blind, so raise every button. Blaze bluffs constantly, so call him down. Sol has no leak at all.',
  },
  {
    h: 'Progress',
    p: 'EV lost per hundred decisions. It settles after a few hundred hands, where win rate needs tens of thousands — it is the only number short of a lifetime that tells you whether you are getting better.',
  },
];
