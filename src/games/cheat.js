/**
 * CHEAT — the traditional card game (also called BS or I Doubt It).
 *
 * Public domain, played the same way everywhere, and a near-perfect fit for
 * this platform: the cards are private, the claim is public, and the whole
 * game is what your face does while you say "three Kings".
 *
 * The rule set here, stated once so the in-app rules and the code cannot drift:
 *   - the whole deck is dealt out; uneven hands are fine and normal
 *   - the required rank climbs by one every turn and wraps past Ace
 *   - on your turn you put 1-4 cards face down and claim they are that rank
 *   - anyone else may call Cheat until the window closes
 *   - a caller who is right hands the pile to the liar; a caller who is wrong
 *     takes the pile themselves
 *   - after a challenge the rank keeps climbing and the turn moves on
 *   - empty your hand and survive the window and you win
 *
 * The last one is why going out is a phase and not a return value: playing your
 * last card is not winning until nobody has called it.
 */

import { makeRng, shuffle } from '../shared/rng.js';
import { clampInt, playerName } from './engine.js';
import { freshDeck, rankOf } from './poker/cards.js';

export const meta = {
  id: 'cheat',
  name: 'Cheat',
  tagline: 'Three Kings. Probably.',
  blurb:
    'Put cards face down and say what they are. You are almost certainly lying, and so is everyone else — the only question is who gets called on it. The cards are on your phone; the lying is out loud.',
  minPlayers: 3,
  maxPlayers: 10,
  familiar: 'Cheat / BS',
  emblem: 'g-cheat',
  lengthMinutes: '10–20 min',
};

const RANK_WORD = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];
export const rankWord = (r) => RANK_WORD[r];

const LOG_MAX = 30;

export const defaultConfig = { challengeSeconds: 15, playSeconds: 60 };

export function normalizeConfig(config) {
  return {
    // Long enough to read the table, short enough that nobody stalls out a
    // bluff by simply not deciding.
    challengeSeconds: clampInt(config.challengeSeconds, 5, 60, 15),
    playSeconds: clampInt(config.playSeconds, 20, 180, 60),
  };
}

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const ids = room.players.map((p) => p.id);
  const deck = shuffle(freshDeck(), rng);

  const hands = {};
  for (const id of ids) hands[id] = [];
  // Dealt round-robin, so hands differ by at most one card.
  deck.forEach((card, i) => hands[ids[i % ids.length]].push(card));
  for (const id of ids) hands[id].sort((a, b) => rankOf(a) - rankOf(b) || a - b);

  return {
    seed,
    order: shuffle(ids, rng),
    hands,
    pile: [],
    turn: 0,
    // Start on Twos: everyone can count up from there without a reference card.
    rank: 0,
    phase: 'play',
    lastPlay: null,
    passed: {},
    reveal: null,
    goingOut: null,
    log: [],
    deadline: now + room.config.playSeconds * 1000,
    over: null,
  };
}

const seated = (g, room) => g.order.filter((id) => room.players.some((p) => p.id === id));

function note(g, entry) {
  g.log.push(entry);
  if (g.log.length > LOG_MAX) g.log.splice(0, g.log.length - LOG_MAX);
}

function advance(g, room, now, { from = g.turn } = {}) {
  g.rank = (g.rank + 1) % 13;
  g.turn = (from + 1) % g.order.length;
  g.phase = 'play';
  g.passed = {};
  g.lastPlay = null;
  g.reveal = null;
  g.goingOut = null;
  g.deadline = now + room.config.playSeconds * 1000;
}

export function action(room, playerId, act, now) {
  const g = room.game;
  if (g.phase === 'over') return { error: 'game_over' };

  switch (act.type) {
    case 'play': {
      if (g.phase !== 'play') return { error: 'wrong_phase' };
      if (g.order[g.turn] !== playerId) return { error: 'not_your_turn' };

      const hand = g.hands[playerId] ?? [];
      const cards = [...new Set((act.cards ?? []).map(Number))];
      if (cards.length < 1 || cards.length > 4) return { error: 'bad_count' };
      // Ownership is checked server-side: a doctored client must not be able
      // to play a card it does not hold, or the same card twice.
      if (!cards.every((c) => hand.includes(c))) return { error: 'not_your_cards' };

      g.hands[playerId] = hand.filter((c) => !cards.includes(c));
      g.pile.push(...cards);
      g.lastPlay = { by: playerId, count: cards.length, rank: g.rank, cards };
      g.passed = {};
      g.phase = 'challenge';
      // Going out is not winning yet — the window still has to close.
      g.goingOut = g.hands[playerId].length === 0 ? playerId : null;
      g.deadline = now + room.config.challengeSeconds * 1000;
      note(g, { kind: 'claim', by: playerId, count: cards.length, rank: g.rank });
      return { events: [{ kind: 'claim', name: playerName(room, playerId), count: cards.length, rank: rankWord(g.rank) }] };
    }

    case 'challenge': {
      if (g.phase !== 'challenge') return { error: 'wrong_phase' };
      if (playerId === g.lastPlay.by) return { error: 'cannot_challenge_self' };
      if (!g.order.includes(playerId)) return { error: 'not_seated' };
      return resolve(g, room, playerId, now);
    }

    case 'pass': {
      if (g.phase !== 'challenge') return { error: 'wrong_phase' };
      if (playerId === g.lastPlay.by) return { error: 'not_your_call' };
      g.passed[playerId] = true;
      // Everyone has waved it through, so there is nothing left to wait for.
      const others = seated(g, room).filter((id) => id !== g.lastPlay.by);
      if (!others.every((id) => g.passed[id])) return {};
      return close(g, room, now);
    }

    default:
      return { error: 'unknown_action' };
  }
}

/** Somebody called it. Turn the cards over and hand the pile to whoever was wrong. */
function resolve(g, room, callerId, now) {
  const play = g.lastPlay;
  const lying = play.cards.some((c) => rankOf(c) !== play.rank);
  const loser = lying ? play.by : callerId;

  g.hands[loser] = [...(g.hands[loser] ?? []), ...g.pile].sort((a, b) => rankOf(a) - rankOf(b) || a - b);
  const pileSize = g.pile.length;
  g.pile = [];

  g.reveal = {
    caller: callerId,
    claimed: { count: play.count, rank: play.rank },
    cards: play.cards,
    lying,
    loser,
    pileSize,
  };
  g.phase = 'reveal';
  g.deadline = now + 8000;
  note(g, { kind: 'called', by: callerId, on: play.by, lying, loser });

  // Being caught means picking up, which means you are no longer out.
  if (g.goingOut === loser) g.goingOut = null;
  if (g.goingOut) return finish(g, room, g.goingOut);

  return {
    events: [{
      kind: 'called',
      caller: playerName(room, callerId),
      accused: playerName(room, play.by),
      lying,
      loser: playerName(room, loser),
    }],
  };
}

/** The window closed with no call. */
function close(g, room, now) {
  if (g.goingOut) return finish(g, room, g.goingOut);
  advance(g, room, now);
  return {};
}

function finish(g, room, winnerId) {
  g.phase = 'over';
  g.deadline = null;
  // Everyone else is ranked by how close they came to being empty.
  const rest = seated(g, room)
    .filter((id) => id !== winnerId)
    .sort((a, b) => g.hands[a].length - g.hands[b].length);
  g.over = {
    winner: winnerId,
    standings: [winnerId, ...rest].map((id, i) => ({ id, place: i + 1, cards: g.hands[id].length })),
  };
  return { events: [{ kind: 'cheatWin', name: playerName(room, winnerId) }] };
}

export function onDeadline(room, now) {
  const g = room.game;

  if (g.phase === 'challenge') return close(g, room, now);
  if (g.phase === 'reveal') {
    // g.turn is still the player who put the cards down, so the default
    // "next after the last player" is exactly right.
    advance(g, room, now);
    return {};
  }
  if (g.phase === 'play') {
    // Nobody can be made to sit and think forever. Play the lowest card in
    // hand as a bluff — the same thing a stalling player would do anyway.
    const id = g.order[g.turn];
    const hand = g.hands[id] ?? [];
    if (!hand.length) {
      advance(g, room, now);
      return {};
    }
    return action(room, id, { type: 'play', cards: [hand[0]] }, now);
  }
  return {};
}

export function viewFor(room, viewerId) {
  const g = room.game;
  const mine = g.hands[viewerId] ?? null;
  const revealed = g.phase === 'reveal' || g.phase === 'over';

  return {
    game: 'cheat',
    phase: g.phase,
    rank: g.rank,
    rankName: rankWord(g.rank),
    turn: g.order[g.turn] ?? null,
    myTurn: g.order[g.turn] === viewerId && g.phase === 'play',
    order: g.order,
    // Your cards, and only counts for everyone else. The pile is face down to
    // the whole table, including whoever put cards in it.
    hand: mine ? [...mine] : null,
    counts: Object.fromEntries(g.order.map((id) => [id, (g.hands[id] ?? []).length])),
    pileCount: g.pile.length,
    lastPlay: g.lastPlay
      ? {
          by: g.lastPlay.by,
          count: g.lastPlay.count,
          rank: g.lastPlay.rank,
          rankName: rankWord(g.lastPlay.rank),
          // The whole game is not knowing this until someone pays to find out.
          cards: revealed ? g.lastPlay.cards : null,
        }
      : null,
    canChallenge: g.phase === 'challenge' && g.lastPlay?.by !== viewerId && !g.passed[viewerId],
    passed: Object.keys(g.passed),
    reveal: revealed ? g.reveal : null,
    goingOut: g.goingOut,
    log: g.log,
    deadline: g.deadline,
    over: g.over,
  };
}

export const rulesText = [
  {
    h: 'The claim',
    p: 'The whole deck is dealt out. On your turn you put one to four cards face down and say what they are — and what they have to be is fixed: Twos, then Threes, then Fours, all the way up and round again.',
  },
  {
    h: 'Lying',
    p: 'You do not need the cards you claim. You almost never will. Put down whatever you like and say it with a straight face.',
  },
  {
    h: 'Calling it',
    p: 'Anyone else can call Cheat before the window closes. The cards get turned over. If they were lying, they take the whole pile. If they were telling the truth, you take it.',
  },
  {
    h: 'Winning',
    p: 'Get rid of every card. Playing your last card is not enough on its own — you have to survive the challenge window. Get caught on it and you pick the pile up like anyone else.',
  },
  {
    h: 'Running out of time',
    p: 'If you take too long on your turn, one card goes down for you. If nobody calls in time, the claim stands.',
  },
];
