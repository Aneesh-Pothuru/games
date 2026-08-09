/**
 * TEXAS HOLD'EM — no-limit, freezeout tournament.
 *
 * A tournament rather than a cash game on purpose: cash needs rebuys, table
 * stakes across sessions, and a way to leave with your chips, none of which
 * mean anything in a party lobby. A freezeout has a start, an end, and a
 * winner, which is the shape every other game here already has.
 *
 * Rules implemented from the TDA 2024 rulebook. The three that software
 * usually gets wrong, and where they live:
 *   - side pots derived from totalCommitted        -> pots.js
 *   - a short all-in does not re-open the betting  -> betting.js
 *   - the wheel is the LOWEST straight             -> cards.js
 *
 * Bets are made as absolute "raise to" totals, never increments.
 */

import { makeRng, randInt, shuffle } from '../../shared/rng.js';
import { clampInt } from '../engine.js';
import { bestFive, describe, evaluate, freshDeck } from './cards.js';
import {
  applyAction,
  legalActions,
  needsToAct,
  nextActor,
  openRound,
  postChips,
  roundComplete,
} from './betting.js';
import { awardPots, buildPots } from './pots.js';

export const meta = {
  id: 'holdem',
  name: 'Texas Hold’em',
  tagline: 'Two cards each. Five on the table. Last stack wins.',
  blurb:
    'No-limit hold’em as a freezeout: everyone starts level, blinds climb, and you are out when your chips are. Side pots, minimum raises and short all-ins all follow tournament rules, so the maths is never the argument.',
  minPlayers: 2,
  maxPlayers: 9,
  familiar: 'Poker',
  emblem: 'g-holdem',
  lengthMinutes: '25–45 min',
};

/**
 * A standard turbo ladder. Every level is a clean multiple so mental pot maths
 * stays possible, and each roughly 1.5×s the last — slower than that and a
 * phone tournament never ends.
 */
const LEVELS = [
  { sb: 10, bb: 20 },
  { sb: 15, bb: 30 },
  { sb: 25, bb: 50 },
  { sb: 50, bb: 100 },
  { sb: 75, bb: 150 },
  { sb: 100, bb: 200 },
  { sb: 150, bb: 300 },
  { sb: 200, bb: 400 },
  { sb: 300, bb: 600 },
  { sb: 400, bb: 800 },
  { sb: 600, bb: 1200 },
  { sb: 1000, bb: 2000 },
  { sb: 1500, bb: 3000 },
  { sb: 2500, bb: 5000 },
  { sb: 4000, bb: 8000 },
];

/** Long enough to read the showdown, short enough that nobody asks to speed up. */
const HANDOVER_MS = 9000;
const LOG_MAX = 40;

export const defaultConfig = { startingStack: 2000, blindMinutes: 6, actionSeconds: 45 };

export function normalizeConfig(config) {
  return {
    startingStack: clampInt(config.startingStack, 500, 50000, 2000),
    // 0 means the blinds never move — for a group that wants to play one long
    // deep-stacked session rather than reach a winner.
    blindMinutes: clampInt(config.blindMinutes, 0, 30, 6),
    actionSeconds: clampInt(config.actionSeconds, 15, 120, 45),
  };
}

// -------------------------------------------------------------------- setup --

function newSeat(id, stack) {
  return {
    id,
    stack,
    place: null,
    hole: [],
    inHand: false,
    folded: true,
    allIn: false,
    hasActed: false,
    committedThisRound: 0,
    totalCommitted: 0,
    lastAction: null,
  };
}

export function start(room, seed, now) {
  const rng = makeRng(seed);
  // A random seat draw, like a real table. Lobby order would put the host on
  // the button every single first hand.
  const ids = shuffle(room.players.map((p) => p.id), rng);

  const g = {
    seed,
    handNo: 0,
    level: 0,
    levelEndsAt: room.config.blindMinutes > 0 ? now + room.config.blindMinutes * 60_000 : null,
    seats: ids.map((id) => newSeat(id, room.config.startingStack)),
    buttonIndex: randInt(0, ids.length - 1, rng),
    sbIndex: -1,
    bbIndex: -1,
    round: { currentBet: 0, lastFullRaiseSize: 0, minBet: 0 },
    street: 'preflop',
    board: [],
    deck: [],
    deckPos: 0,
    actor: -1,
    phase: 'hand',
    result: null,
    log: [],
    deadline: null,
    over: null,
  };

  beginHand(g, room, now);
  return g;
}

// --------------------------------------------------------------- hand cycle --

const draw = (g) => g.deck[g.deckPos++];

/** Next seat index that is in the current hand, searching left from `from`. */
function nextInHand(g, from) {
  const n = g.seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (g.seats[i].inHand) return i;
  }
  return from;
}

/** Next seat index still contesting the pot. */
function nextLive(g, from) {
  const n = g.seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (g.seats[i].inHand && !g.seats[i].folded) return i;
  }
  return from;
}

function note(g, seat, entry) {
  g.log.push({ id: seat?.id ?? null, street: g.street, ...entry });
  if (g.log.length > LOG_MAX) g.log.splice(0, g.log.length - LOG_MAX);
}

function beginHand(g, room, now) {
  const alive = g.seats.filter((s) => s.stack > 0);
  if (alive.length <= 1) return finishTournament(g);

  // Blinds only ever move between hands. Raising them mid-hand would change
  // the minimum raise underneath a player who is already facing a bet.
  if (room.config.blindMinutes > 0 && g.levelEndsAt && now >= g.levelEndsAt) {
    g.level = Math.min(g.level + 1, LEVELS.length - 1);
    g.levelEndsAt = now + room.config.blindMinutes * 60_000;
  }

  g.handNo++;
  const rng = makeRng((g.seed + g.handNo * 2654435761) >>> 0);
  g.deck = shuffle(freshDeck(), rng);
  g.deckPos = 0;
  g.board = [];
  g.street = 'preflop';
  g.result = null;
  g.log = [];
  g.phase = 'hand';

  for (const s of g.seats) {
    s.inHand = s.stack > 0;
    s.folded = !s.inHand;
    s.allIn = false;
    s.hole = [];
    s.lastAction = null;
    s.committedThisRound = 0;
    s.totalCommitted = 0;
    s.hasActed = false;
  }

  g.buttonIndex = nextInHand(g, g.buttonIndex);
  const heads = g.seats.filter((s) => s.inHand).length === 2;

  // Heads-up, the button posts the small blind and acts first before the flop —
  // and acts LAST on every street after it. Getting this backwards is the
  // classic heads-up bug.
  const sbIndex = heads ? g.buttonIndex : nextInHand(g, g.buttonIndex);
  const bbIndex = nextInHand(g, sbIndex);

  // Deal two rounds starting left of the button, as at a real table.
  const dealtIn = g.seats.filter((s) => s.inHand).length;
  for (let round = 0; round < 2; round++) {
    let i = g.buttonIndex;
    for (let dealt = 0; dealt < dealtIn; dealt++) {
      i = nextInHand(g, i);
      g.seats[i].hole.push(draw(g));
    }
  }

  const { sb, bb } = LEVELS[g.level];
  g.round = openRound(g.seats, { currentBet: bb, minBet: bb });
  postChips(g.seats[sbIndex], sb);
  postChips(g.seats[bbIndex], bb);
  g.seats[sbIndex].lastAction = { kind: 'sb', amount: g.seats[sbIndex].committedThisRound };
  g.seats[bbIndex].lastAction = { kind: 'bb', amount: g.seats[bbIndex].committedThisRound };
  // Blinds are posted, not acted. Both keep hasActed=false, which is what gives
  // the big blind their option to raise when the pot is merely limped to them.
  g.sbIndex = sbIndex;
  g.bbIndex = bbIndex;

  const first = heads ? g.buttonIndex : nextInHand(g, bbIndex);
  seatActor(g, room, first, now);

  // A table where the blinds alone put everyone all-in never gets an action.
  if (roundComplete(g.round, g.seats)) return advanceStreet(g, room, now);
  return { events: [{ kind: 'handStarted', handNo: g.handNo }] };
}

/** Point the clock at `index`, or the next seat that actually owes action. */
function seatActor(g, room, index, now) {
  g.actor = needsToAct(g.round, g.seats[index]) ? index : nextActor(g.round, g.seats, index);
  g.deadline = g.actor >= 0 ? now + room.config.actionSeconds * 1000 : null;
}

function dealNextStreet(g) {
  g.deckPos++; // burn
  if (g.street === 'preflop') {
    g.board.push(draw(g), draw(g), draw(g));
    g.street = 'flop';
  } else if (g.street === 'flop') {
    g.board.push(draw(g));
    g.street = 'turn';
  } else {
    g.board.push(draw(g));
    g.street = 'river';
  }
}

function advanceStreet(g, room, now) {
  const live = g.seats.filter((s) => s.inHand && !s.folded);
  if (live.length <= 1) return endHand(g, room, now, false);

  // With at most one player left who still has chips behind, no further betting
  // is possible: run the board out and show down.
  if (live.filter((s) => !s.allIn).length <= 1) {
    while (g.street !== 'river') dealNextStreet(g);
    return endHand(g, room, now, true);
  }

  if (g.street === 'river') return endHand(g, room, now, true);

  dealNextStreet(g);
  for (const s of g.seats) s.lastAction = null;
  g.round = openRound(g.seats, { currentBet: 0, minBet: LEVELS[g.level].bb });
  // First to act after the flop is the first live seat left of the button —
  // which, heads-up, is the big blind. Same rule serves both cases.
  seatActor(g, room, nextLive(g, g.buttonIndex), now);
  // Belt and braces: never leave the table with no clock and nobody to act.
  if (g.actor < 0) return advanceStreet(g, room, now);
  return { events: [{ kind: 'street', street: g.street, board: g.board.slice() }] };
}

/** Seat ids starting immediately left of the button — the odd-chip order. */
function oddChipOrder(g) {
  const out = [];
  for (let i = 1; i <= g.seats.length; i++) {
    out.push(g.seats[(g.buttonIndex + i) % g.seats.length].id);
  }
  return out;
}

function endHand(g, room, now, showdown) {
  const contenders = g.seats.filter((s) => s.inHand && !s.folded);
  const contested = showdown && contenders.length > 1;

  const scores = {};
  const made = {};
  for (const s of contenders) {
    if (contested) {
      const seven = [...s.hole, ...g.board];
      scores[s.id] = evaluate(seven);
      made[s.id] = { five: bestFive(seven), name: describe(seven) };
    } else {
      // Uncontested: the last player standing takes every pot they are in
      // without ever showing a card.
      scores[s.id] = 1;
    }
  }

  const { pots, refunds } = buildPots(
    g.seats
      .filter((s) => s.totalCommitted > 0)
      .map((s) => ({ id: s.id, totalCommitted: s.totalCommitted, folded: s.folded })),
  );
  const { won, detail } = awardPots(pots, scores, oddChipOrder(g));

  for (const s of g.seats) {
    s.stack += (won[s.id] ?? 0) + (refunds[s.id] ?? 0);
  }

  const remaining = g.seats.filter((s) => s.stack > 0);
  const bustedNow = g.seats.filter((s) => s.inHand && s.stack === 0 && s.place === null);
  // Two players busting on one hand are not tied: the shorter stack was all-in
  // for less, so they could not have outlasted the other.
  bustedNow.sort((a, b) => a.totalCommitted - b.totalCommitted);
  let place = remaining.length + bustedNow.length;
  for (const s of bustedNow) s.place = place--;

  g.result = {
    handNo: g.handNo,
    board: g.board.slice(),
    showdown: contested,
    pots: detail,
    refunds,
    won,
    busted: bustedNow.map((s) => ({ id: s.id, place: s.place })),
    shown: contenders.map((s) => ({
      id: s.id,
      hole: contested ? s.hole.slice() : null,
      five: made[s.id]?.five ?? null,
      name: made[s.id]?.name ?? null,
    })),
  };
  note(g, null, { kind: 'result', won });

  g.actor = -1;
  for (const s of g.seats) s.lastAction = null;

  if (remaining.length <= 1) {
    if (remaining.length === 1) remaining[0].place = 1;
    finishTournament(g);
    return { events: [{ kind: 'handEnded', showdown: contested }] };
  }

  g.phase = 'handover';
  g.deadline = now + HANDOVER_MS;
  return { events: [{ kind: 'handEnded', showdown: contested }] };
}

function finishTournament(g) {
  const winner = g.seats.find((s) => s.stack > 0) ?? null;
  if (winner) winner.place = 1;
  g.phase = 'over';
  g.actor = -1;
  g.deadline = null;
  g.over = {
    winner: winner?.id ?? null,
    standings: g.seats
      .map((s) => ({ id: s.id, place: s.place ?? 99, stack: s.stack }))
      .sort((a, b) => a.place - b.place),
  };
  return { events: [] };
}

// ------------------------------------------------------------------ actions --

export function action(room, playerId, act, now) {
  const g = room.game;
  if (g.phase === 'over') return { error: 'game_over' };

  switch (act.type) {
    case 'act': {
      if (g.phase !== 'hand') return { error: 'wrong_phase' };
      const index = g.seats.findIndex((s) => s.id === playerId);
      if (index < 0) return { error: 'not_seated' };
      if (index !== g.actor) return { error: 'not_your_turn' };

      const seat = g.seats[index];
      const outcome = applyAction(g.round, g.seats, seat, {
        type: act.move,
        to: act.to,
      });
      if (outcome.error) return { error: outcome.error };
      note(g, seat, { kind: outcome.kind, amount: outcome.to ?? outcome.amount ?? 0 });

      return afterAction(g, room, now, outcome);
    }

    // The handover runs on a timer so the table keeps moving on its own; this
    // just lets anyone who is ready skip the wait.
    case 'deal': {
      if (g.phase !== 'handover') return { error: 'wrong_phase' };
      if (!g.seats.some((s) => s.id === playerId)) return { error: 'not_seated' };
      return beginHand(g, room, now) ?? {};
    }

    default:
      return { error: 'unknown_action' };
  }
}

function afterAction(g, room, now, outcome) {
  const events = [];
  const live = g.seats.filter((s) => s.inHand && !s.folded);

  if (live.length <= 1) return merge(events, endHand(g, room, now, false));
  if (roundComplete(g.round, g.seats)) return merge(events, advanceStreet(g, room, now));

  g.actor = nextActor(g.round, g.seats, g.actor);
  if (g.actor < 0) return merge(events, advanceStreet(g, room, now));
  g.deadline = now + room.config.actionSeconds * 1000;
  if (outcome.allIn) events.push({ kind: 'allIn' });
  return { events };
}

function merge(events, outcome) {
  return { events: [...events, ...(outcome?.events ?? [])] };
}

export function onDeadline(room, now) {
  const g = room.game;

  if (g.phase === 'handover') return beginHand(g, room, now) ?? {};

  if (g.phase === 'hand' && g.actor >= 0) {
    const seat = g.seats[g.actor];
    // Standard online behaviour, and the only safe default: never fold a hand
    // that could be continued for free.
    const legal = legalActions(g.round, seat);
    const move = legal.check ? 'check' : 'fold';
    const outcome = applyAction(g.round, g.seats, seat, { type: move });
    if (outcome.error) return {};
    note(g, seat, { kind: move, amount: 0, timedOut: true });
    return afterAction(g, room, now, outcome);
  }

  return {};
}

// --------------------------------------------------------------------- view --

export function viewFor(room, viewerId) {
  const g = room.game;
  const me = g.seats.find((s) => s.id === viewerId) ?? null;
  const shown = new Map((g.result?.shown ?? []).map((s) => [s.id, s]));
  const potTotal = g.seats.reduce((n, s) => n + s.totalCommitted, 0);
  const { sb, bb } = LEVELS[g.level];

  const seats = g.seats.map((s, i) => {
    const reveal = g.phase !== 'hand' && shown.get(s.id)?.hole;
    return {
      id: s.id,
      seat: i,
      stack: s.stack,
      committed: s.committedThisRound,
      totalCommitted: s.totalCommitted,
      folded: s.folded,
      allIn: s.allIn,
      inHand: s.inHand,
      place: s.place,
      lastAction: s.lastAction,
      isButton: i === g.buttonIndex,
      isSB: i === g.sbIndex,
      isBB: i === g.bbIndex,
      acting: i === g.actor,
      // The redaction boundary: your own cards always, everyone else's only
      // once they have been turned face up at a showdown.
      hole: s.id === viewerId ? s.hole.slice() : reveal ? reveal.slice() : null,
      cardCount: s.inHand && !s.folded ? s.hole.length : 0,
      best: shown.get(s.id)?.five ?? null,
      handName: g.phase !== 'hand' ? (shown.get(s.id)?.name ?? null) : null,
      won: g.result?.won?.[s.id] ?? 0,
    };
  });

  const legal = me && g.phase === 'hand' && g.actor >= 0 && g.seats[g.actor] === me
    ? legalActions(g.round, me)
    : null;

  return {
    game: 'holdem',
    phase: g.phase,
    street: g.street,
    handNo: g.handNo,
    board: g.board.slice(),
    seats,
    potTotal,
    pots: buildPots(
      g.seats
        .filter((s) => s.totalCommitted > 0)
        .map((s) => ({ id: s.id, totalCommitted: s.totalCommitted, folded: s.folded })),
    ).pots,
    currentBet: g.round.currentBet,
    minRaiseTo: g.round.currentBet + g.round.lastFullRaiseSize,
    blinds: { sb, bb, level: g.level + 1 },
    levelEndsAt: g.levelEndsAt,
    actor: g.actor >= 0 ? g.seats[g.actor].id : null,
    myTurn: Boolean(legal),
    legal,
    myStack: me?.stack ?? 0,
    // Your own two cards read against the board — the one bit of analysis
    // worth doing for you, because misreading your hand on a phone is easy.
    myHand: me && me.inHand && !me.folded && g.board.length >= 3 ? describe([...me.hole, ...g.board]) : null,
    result: g.result,
    log: g.log,
    deadline: g.deadline,
    over: g.over,
  };
}

export const rulesText = [
  {
    h: 'The deal',
    p: 'Everyone gets two private cards. Five community cards come out in the middle — three (the flop), then one (the turn), then one (the river). Your hand is the best five cards out of your two plus the five shared.',
  },
  {
    h: 'Betting',
    p: 'There is a round of betting before the flop and after each community card. In turn you fold, check or call what is in front of you, or raise. No-limit: you can push your whole stack in at any point.',
  },
  {
    h: 'Minimum raise',
    p: 'A raise has to be at least as big as the last bet or raise this round. If someone goes all-in for less than a full raise, players who have already acted can call the extra or fold, but cannot re-raise.',
  },
  {
    h: 'All-in and side pots',
    p: 'Running out of chips does not put you out of the hand — you play for the part of the pot you paid for, and everything above that goes into a side pot the others fight over. Chips nobody could call come straight back to you.',
  },
  {
    h: 'Hand rankings',
    p: 'Straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, pair, high card. A-2-3-4-5 is a straight — the lowest one. Suits never break a tie; equal hands split the pot.',
  },
  {
    h: 'The tournament',
    p: 'Everyone starts with the same stack and the blinds climb on a clock. Lose your chips and you are out, in the order you busted. Last player with chips wins.',
  },
];
