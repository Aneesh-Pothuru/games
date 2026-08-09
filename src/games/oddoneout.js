/**
 * ODD ONE OUT — everyone shares a location except one player.
 *
 * Mechanically Spyfall, implemented from the official Hobby World rulebooks
 * (editions 1, 2 and 3). Original name and original location deck; the
 * published location list is the protectable part of that product.
 *
 * Two places where the real rules differ from what almost every app ships,
 * both implemented correctly here:
 *
 *  - An accusation needs UNANIMITY among everyone except the accused. The
 *    accuser counts as an automatic yes. It is not a plurality vote.
 *  - When the timer expires the official procedure is SEQUENTIAL single-
 *    suspect ballots, starting with the dealer and going clockwise — not
 *    "everyone points at once". Sequential ballots also mean an endgame vote
 *    can never tie, which is why the official version is better.
 */

import { makeRng, shuffle } from '../shared/rng.js';
import { LOCATIONS } from '../content/locations.js';
import { asBool, clampInt, drawUnseen, playerName } from './engine.js';

export const meta = {
  id: 'oddoneout',
  name: 'Odd One Out',
  tagline: 'Everyone knows where they are. Except one of you.',
  blurb:
    'You all get the same location and a role in it. One player gets nothing at all and has to work out where they are before the rest of you work out who they are.',
  minPlayers: 3,
  maxPlayers: 12,
  familiar: 'Spyfall',
  emblem: 'g-oddoneout',
  lengthMinutes: '8–10 min per round',
};

/** Official Spyfall 2/3 timer table, scaled by player count. */
const OFFICIAL_TIMER = [
  [4, 360],
  [6, 420],
  [8, 480],
  [10, 540],
  [12, 600],
];

export function timerFor(count) {
  for (const [max, seconds] of OFFICIAL_TIMER) if (count <= max) return seconds;
  return 600;
}

/** Official guidance: 1 spy at <=6, 2 recommended at >=9, mandatory at 12. */
export function defaultSpyCount(count) {
  if (count >= 12) return 2;
  if (count >= 9) return 2;
  return 1;
}

export const defaultConfig = { rounds: 5, timerMode: 'official', spyCountMode: 'auto' };

export function normalizeConfig(config) {
  return {
    rounds: clampInt(config.rounds, 1, 10, 5),
    timerMode: config.timerMode === 'short' || config.timerMode === 'long' ? config.timerMode : 'official',
    spyCountMode: config.spyCountMode === 'one' || config.spyCountMode === 'two' ? config.spyCountMode : 'auto',
  };
}

function roundSeconds(room) {
  const base = timerFor(room.players.length);
  if (room.config.timerMode === 'short') return Math.round(base * 0.6);
  if (room.config.timerMode === 'long') return Math.round(base * 1.5);
  return base;
}

function spyCountFor(room) {
  if (room.config.spyCountMode === 'one') return 1;
  if (room.config.spyCountMode === 'two') return Math.min(2, room.players.length - 2);
  return Math.min(defaultSpyCount(room.players.length), room.players.length - 2);
}

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const ids = room.players.map((p) => p.id);
  const seen = room.seenLocations ?? [];
  const { picked } = drawUnseen(LOCATIONS, seen, rng);

  const spyCount = spyCountFor(room);
  const shuffled = shuffle(ids, rng);
  const spies = shuffled.slice(0, spyCount);
  const roles = {};
  const roleDeck = shuffle(picked.roles, rng);
  let r = 0;
  for (const id of ids) {
    if (!spies.includes(id)) roles[id] = roleDeck[r++ % roleDeck.length];
  }

  const seconds = roundSeconds(room);
  return {
    seed,
    phase: 'reveal',
    round: (room.game?.round ?? 0) + 1,
    locationId: picked.id,
    roles,
    spies,
    // The dealer is the first suspect at the endgame, which is a real
    // positional advantage/disadvantage and is deliberately not smoothed out.
    dealer: shuffled[shuffled.length - 1],
    order: shuffled,
    acked: {},
    // Absolute deadline. The client interpolates against it; it never owns it.
    deadline: null,
    seconds,
    remainingMs: seconds * 1000,
    accusedBy: {},
    accusation: null,
    ballotQueue: null,
    ballotIndex: 0,
    spyGuesses: {},
    revealPending: false,
    result: null,
    firstAccuserOf: {},
  };
}

const alivePlayers = (room) => room.players.map((p) => p.id);

function pause(g, now) {
  if (g.deadline) {
    g.remainingMs = Math.max(0, g.deadline - now);
    g.deadline = null;
  }
}

function resume(g, now) {
  g.deadline = now + g.remainingMs;
}

function finish(g, room, outcome) {
  g.phase = 'result';
  g.deadline = null;
  const location = LOCATIONS.find((l) => l.id === g.locationId);

  // Official scoring: spy survives 2, spy names the location 4, an innocent
  // convicted 4, spy caught 1 to every non-spy plus 1 more to whoever first
  // accused them.
  const deltas = Object.fromEntries(room.players.map((p) => [p.id, 0]));
  const isSpy = (id) => g.spies.includes(id);

  if (outcome.kind === 'spyCaught') {
    for (const p of room.players) if (!isSpy(p.id)) deltas[p.id] += 1;
    const accuser = g.firstAccuserOf[outcome.caught];
    if (accuser && deltas[accuser] !== undefined) deltas[accuser] += 1;
    // A surviving second spy scores as though they were a non-spy.
    for (const spy of g.spies) if (spy !== outcome.caught) deltas[spy] += 1;
  } else if (outcome.kind === 'innocentConvicted') {
    for (const spy of g.spies) deltas[spy] += 4;
  } else if (outcome.kind === 'spyGuess') {
    if (outcome.correct) for (const spy of g.spies) deltas[spy] += 4;
    else for (const p of room.players) if (!isSpy(p.id)) deltas[p.id] += 1;
  } else if (outcome.kind === 'spySurvived') {
    for (const spy of g.spies) deltas[spy] += 2;
  }

  for (const [id, delta] of Object.entries(deltas)) {
    room.scores[id] = (room.scores[id] ?? 0) + delta;
  }

  g.result = { ...outcome, location: location.name, deltas, roles: g.roles, spies: g.spies };
  room.seenLocations = [...(room.seenLocations ?? []), g.locationId].slice(-40);
  if (g.round >= room.config.rounds) room.lastResult = { kind: 'series' };
}

export function action(room, playerId, act, now) {
  const g = room.game;

  switch (act.type) {
    case 'ack': {
      if (g.phase !== 'reveal') return { error: 'wrong_phase' };
      g.acked[playerId] = true;
      if (alivePlayers(room).every((id) => g.acked[id])) {
        g.phase = 'questioning';
        resume(g, now);
      }
      return {};
    }

    case 'accuse': {
      if (g.phase !== 'questioning') return { error: 'wrong_phase' };
      if (g.accusedBy[playerId]) return { error: 'already_accused' };
      if (act.target === playerId) return { error: 'cannot_accuse_self' };
      if (!room.players.some((p) => p.id === act.target)) return { error: 'bad_target' };

      g.accusedBy[playerId] = true;
      // The clock stops for the whole vote and resumes at the exact value.
      pause(g, now);
      g.accusation = {
        accuser: playerId,
        accused: act.target,
        // The accuser is an automatic yes.
        ballots: { [playerId]: 'YES' },
      };
      if (!g.firstAccuserOf[act.target]) g.firstAccuserOf[act.target] = playerId;
      g.phase = 'accusation';
      return {
        events: [
          { kind: 'accusation', accuser: playerName(room, playerId), accused: playerName(room, act.target) },
        ],
      };
    }

    case 'accusationVote': {
      if (g.phase !== 'accusation') return { error: 'wrong_phase' };
      if (playerId === g.accusation.accused) return { error: 'accused_cannot_vote' };
      if (act.value !== 'YES' && act.value !== 'NO') return { error: 'bad_vote' };
      g.accusation.ballots[playerId] = act.value;

      const electorate = alivePlayers(room).filter((id) => id !== g.accusation.accused);
      if (!electorate.every((id) => g.accusation.ballots[id])) return {};
      return resolveAccusation(g, room, now);
    }

    case 'spyReveal': {
      // Once someone else has stopped the clock the spy has missed their
      // chance — a single-writer transition on the phase enforces that.
      if (g.phase !== 'questioning') return { error: 'too_late' };
      if (!g.spies.includes(playerId)) return { error: 'not_spy' };
      pause(g, now);
      g.phase = 'spyGuess';
      g.revealPending = true;
      return { events: [{ kind: 'spyReveal', name: playerName(room, playerId) }] };
    }

    case 'spyGuess': {
      if (g.phase !== 'spyGuess') return { error: 'wrong_phase' };
      if (!g.spies.includes(playerId)) return { error: 'not_spy' };
      if (g.spyGuesses[playerId]) return { error: 'already_guessed' };
      if (!LOCATIONS.some((l) => l.id === act.locationId)) return { error: 'bad_location' };
      g.spyGuesses[playerId] = act.locationId;

      // With two spies the partner must also reveal and also name a location;
      // the spies win if either is right.
      if (!g.spies.every((id) => g.spyGuesses[id])) return {};
      const correct = g.spies.some((id) => g.spyGuesses[id] === g.locationId);
      finish(g, room, { kind: 'spyGuess', correct, guesses: g.spyGuesses });
      return { events: [{ kind: 'roundOver' }] };
    }

    case 'endgameVote': {
      if (g.phase !== 'endgame') return { error: 'wrong_phase' };
      const suspect = g.ballotQueue[g.ballotIndex];
      if (playerId === suspect) return { error: 'suspect_cannot_vote' };
      if (act.value !== 'YES' && act.value !== 'NO') return { error: 'bad_vote' };
      g.accusation.ballots[playerId] = act.value;
      const electorate = alivePlayers(room).filter((id) => id !== suspect);
      if (!electorate.every((id) => g.accusation.ballots[id])) return {};
      return resolveEndgameBallot(g, room);
    }

    case 'nextRound': {
      if (g.phase !== 'result') return { error: 'wrong_phase' };
      if (room.hostId !== playerId) return { error: 'host_only' };
      if (g.round >= room.config.rounds) return { error: 'series_over' };
      room.game = start(room, (g.seed * 1103515245 + 12345) >>> 0, now);
      room.game.round = g.round + 1;
      return { events: [{ kind: 'newRound' }] };
    }

    default:
      return { error: 'unknown_action' };
  }
}

/** Unanimity among everyone except the accused. Absent voters count as no. */
function unanimousExcept(g, room, suspect) {
  const electorate = alivePlayers(room).filter((id) => id !== suspect);
  const yes = electorate.filter((id) => g.accusation.ballots[id] === 'YES').length;
  // With two spies in play a conviction tolerates exactly one dissenter.
  const allowedDissent = g.spies.length > 1 ? 1 : 0;
  return yes >= electorate.length - allowedDissent;
}

function resolveAccusation(g, room, now) {
  const { accused } = g.accusation;
  if (!unanimousExcept(g, room, accused)) {
    // Failed: the clock resumes exactly where it stopped and the accuser has
    // spent their one accusation for the round.
    g.accusation = null;
    g.phase = 'questioning';
    resume(g, now);
    return { events: [{ kind: 'accusationFailed' }] };
  }
  const caughtSpy = g.spies.includes(accused);
  finish(
    g,
    room,
    caughtSpy ? { kind: 'spyCaught', caught: accused } : { kind: 'innocentConvicted', convicted: accused },
  );
  return { events: [{ kind: 'roundOver' }] };
}

function resolveEndgameBallot(g, room) {
  const suspect = g.ballotQueue[g.ballotIndex];
  if (unanimousExcept(g, room, suspect)) {
    const caughtSpy = g.spies.includes(suspect);
    finish(
      g,
      room,
      caughtSpy ? { kind: 'spyCaught', caught: suspect } : { kind: 'innocentConvicted', convicted: suspect },
    );
    return { events: [{ kind: 'roundOver' }] };
  }
  g.ballotIndex++;
  if (g.ballotIndex >= g.ballotQueue.length) {
    // Nobody was unanimously convicted, so the spy walks.
    finish(g, room, { kind: 'spySurvived' });
    return { events: [{ kind: 'roundOver' }] };
  }
  g.accusation = { accuser: null, accused: g.ballotQueue[g.ballotIndex], ballots: {} };
  return {};
}

export function onDeadline(room, now) {
  const g = room.game;
  if (g.phase !== 'questioning') return {};
  g.deadline = null;
  g.remainingMs = 0;
  // Sequential ballots, dealer first, then clockwise.
  const order = g.order;
  const dealerIdx = order.indexOf(g.dealer);
  g.ballotQueue = [...order.slice(dealerIdx), ...order.slice(0, dealerIdx)];
  g.ballotIndex = 0;
  g.accusation = { accuser: null, accused: g.ballotQueue[0], ballots: {} };
  g.phase = 'endgame';
  return { events: [{ kind: 'timeUp' }] };
}

export function viewFor(room, viewerId) {
  const g = room.game;
  const amSpy = g.spies.includes(viewerId);
  const done = g.phase === 'result';
  const location = LOCATIONS.find((l) => l.id === g.locationId);

  return {
    game: 'oddoneout',
    phase: g.phase,
    round: g.round,
    totalRounds: room.config.rounds,
    deadline: g.deadline,
    remainingMs: g.deadline ? null : g.remainingMs,
    totalMs: g.seconds * 1000,
    dealer: g.dealer,
    order: g.order,
    acked: g.acked,
    spyCount: g.spies.length,
    // The location name is never sent to a spy's client — not hidden in the
    // DOM, not in a collapsed field, not anywhere in the payload.
    myLocation: amSpy && !done ? null : location.name,
    myRole: amSpy && !done ? null : (g.roles[viewerId] ?? null),
    amSpy: done ? g.spies.includes(viewerId) : amSpy,
    // Everyone can see the full list of possible locations — that is public
    // information in the physical game too, printed on every card.
    locations: LOCATIONS.map((l) => ({ id: l.id, name: l.name })),
    usedAccusation: Boolean(g.accusedBy[viewerId]),
    accusation: g.accusation
      ? {
          accuser: g.accusation.accuser,
          accused: g.accusation.accused,
          voted: Object.keys(g.accusation.ballots),
          myVote: g.accusation.ballots[viewerId] ?? null,
        }
      : null,
    ballotIndex: g.ballotIndex,
    ballotTotal: g.ballotQueue?.length ?? 0,
    myGuess: g.spyGuesses[viewerId] ?? null,
    spyGuesses: done ? g.spyGuesses : {},
    result: g.result,
    scores: room.scores,
  };
}

export const rulesText = [
  {
    h: 'The setup',
    p: 'Everyone gets the same location and a role in it. One player — two in a big game — gets the SPY card and knows neither.',
  },
  {
    h: 'Asking questions',
    p: 'Someone asks another player a question out loud, by name. They answer, then ask someone else. You may not immediately ask back the person who just asked you. One question, one answer, no follow-ups.',
  },
  {
    h: 'The tension',
    p: 'Answer too vaguely and you look like the spy. Answer too specifically and you hand the location to them.',
  },
  {
    h: 'Accusing',
    p: 'Any player may stop the clock once per round to accuse someone. Everyone except the accused votes, and it must be unanimous. If it fails, the clock restarts and you have spent your accusation.',
  },
  {
    h: 'The spy’s move',
    p: 'The spy may stop the clock at any time and name the location. Right, and they win big. Wrong, and everyone else does. Once somebody else stops the clock, the spy has missed their chance.',
  },
  {
    h: 'Time running out',
    p: 'Players are put up one at a time, dealer first. Each needs a unanimous vote. If nobody is convicted, the spy walks.',
  },
  {
    h: 'Scoring',
    p: 'Spy survives: 2. Spy names the location: 4. An innocent gets convicted: 4 to the spy. Spy caught: 1 to every other player, and 2 to whoever accused them first.',
  },
];
