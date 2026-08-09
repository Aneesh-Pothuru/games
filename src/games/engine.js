/**
 * Shared game primitives.
 *
 * The point of this file is that a new game should be a phase graph plus a
 * view projector, not a new program. If adding a game means adding primitives
 * here, that is fine; if it means bypassing them, the abstraction is wrong.
 */

import { shuffle } from '../shared/rng.js';

/** Players who can still act. Someone who closed the tab keeps their seat. */
export function activePlayers(room) {
  return room.players.filter((p) => !p.left);
}

export function playerName(room, id) {
  return room.players.find((p) => p.id === id)?.name ?? 'Someone';
}

/**
 * Deal one hidden assignment per player.
 * Returns a map of playerId -> value, so every read is explicit about the fact
 * that it is touching secret state.
 */
export function deal(playerIds, values, rng) {
  const order = shuffle(playerIds, rng);
  const out = {};
  order.forEach((id, i) => {
    out[id] = values[i];
  });
  return out;
}

/** Build a role bag: [{role, count}] -> flat array, padded with `filler`. */
export function roleBag(spec, total, filler) {
  const bag = [];
  for (const { role, count } of spec) {
    for (let i = 0; i < count; i++) bag.push(role);
  }
  while (bag.length < total) bag.push(filler);
  return bag.slice(0, total);
}

// ------------------------------------------------------------------ voting --

export function newVote({ eligible, kind = 'binary', target = null }) {
  return { kind, target, eligible: [...eligible], ballots: {}, closedAt: null };
}

export function castBallot(vote, playerId, choice) {
  if (!vote.eligible.includes(playerId)) return 'not_eligible';
  if (vote.closedAt) return 'vote_closed';
  vote.ballots[playerId] = choice;
  return null;
}

export function voteComplete(vote) {
  return vote.eligible.every((id) => vote.ballots[id] !== undefined);
}

export function tally(vote) {
  const counts = {};
  for (const id of vote.eligible) {
    const choice = vote.ballots[id];
    if (choice === undefined) continue;
    counts[choice] = (counts[choice] ?? 0) + 1;
  }
  return counts;
}

/**
 * Highest-count entries. Returns every tied leader, because *which* tie rule
 * applies is a per-game decision and must not be buried in a helper.
 */
export function leaders(counts) {
  let best = -1;
  let winners = [];
  for (const [key, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      winners = [key];
    } else if (n === best) {
      winners.push(key);
    }
  }
  return { winners, count: best };
}

/** Who we are still waiting on — this indicator does real social work. */
export function pendingVoters(vote) {
  return vote.eligible.filter((id) => vote.ballots[id] === undefined);
}

/**
 * A ballot a player has cast is public *to that player only* until the reveal.
 * Redact the rest.
 */
export function redactBallots(vote, viewerId, revealed) {
  if (revealed) return vote.ballots;
  const mine = vote.ballots[viewerId];
  return mine === undefined ? {} : { [viewerId]: mine };
}

// ------------------------------------------------------------------- turns --

export function nextInOrder(order, currentId) {
  const i = order.indexOf(currentId);
  return order[(i + 1) % order.length];
}

// --------------------------------------------------------------- deadlines --

export const NO_DEADLINE = null;

export function deadlineIn(now, seconds) {
  return now + seconds * 1000;
}

// ----------------------------------------------------------------- content --

/**
 * Draw from a deck without repeating within a session.
 * A group burns through locations fast, and a repeat is much worse here than
 * in a word game — the whole tension is "do I recognise this place".
 */
export function drawUnseen(deck, seenIds, rng) {
  const fresh = deck.filter((item) => !seenIds.includes(item.id));
  const pool = fresh.length ? fresh : deck;
  const picked = shuffle(pool, rng)[0];
  return { picked, exhausted: fresh.length === 0 };
}

// ------------------------------------------------------------------ config --

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
