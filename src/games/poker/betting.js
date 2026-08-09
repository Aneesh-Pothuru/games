/**
 * Betting-round mechanics for no-limit hold'em.
 *
 * Two rules carry almost all the complexity, and both are about *re-opening*
 * the action:
 *
 * 1. A raise must be at least as large as the largest bet or raise so far this
 *    round (TDA 47-A). `lastFullRaiseSize` is that number; the minimum you may
 *    raise to is always `currentBet + lastFullRaiseSize`.
 *
 * 2. An all-in that is short of a full raise does NOT re-open the betting to a
 *    player who has already acted and is not facing at least a full raise. They
 *    may call the extra or fold, but they may not raise. This is the single
 *    most commonly mis-implemented rule in poker software.
 *
 * A player who has acted but is no longer matching `currentBet` still owes
 * action — that is what makes case 2 work without a second flag.
 *
 * Everything here is a pure function over plain objects, because this state is
 * serialised into Durable Object storage between every message.
 */

/** Move chips from a stack into the pot, capped at what the player has. */
function commit(seat, amount) {
  const n = Math.max(0, Math.min(Math.floor(amount), seat.stack));
  seat.stack -= n;
  seat.committedThisRound += n;
  seat.totalCommitted += n;
  if (seat.stack === 0) seat.allIn = true;
  return n;
}

export { commit as postChips };

/**
 * Reset per-round state. `minBet` is the big blind: postflop the smallest legal
 * bet is one big blind, and it is also the opening value of lastFullRaiseSize.
 */
export function openRound(seats, { currentBet = 0, minBet }) {
  for (const s of seats) {
    s.committedThisRound = 0;
    s.hasActed = false;
  }
  return { currentBet, lastFullRaiseSize: minBet, minBet };
}

/**
 * What this seat may legally do right now.
 *
 * Returned amounts are absolute "raise TO" totals for the round, not
 * increments — every real poker interface talks in totals, and increments are
 * where off-by-one-blind bugs live.
 */
export function legalActions(round, seat) {
  if (seat.folded || seat.allIn) {
    return { fold: false, check: false, call: false, callAmount: 0, raise: false };
  }

  const facing = round.currentBet - seat.committedThisRound;
  const callAmount = Math.min(seat.stack, Math.max(0, facing));
  const canCheck = facing <= 0;

  // Rule 2 above. A player who has not yet acted this round can always raise;
  // one who has may only raise if what they now face is itself a full raise.
  const reopened = !seat.hasActed || facing >= round.lastFullRaiseSize;
  const maxRaiseTo = seat.committedThisRound + seat.stack;
  const canRaise = reopened && maxRaiseTo > round.currentBet;

  return {
    fold: true,
    check: canCheck,
    call: !canCheck && callAmount > 0,
    callAmount,
    callIsAllIn: !canCheck && callAmount >= seat.stack,
    raise: canRaise,
    // Clamped to the stack: a short stack's only raise is its all-in, and that
    // is legal even when it falls below the minimum.
    minRaiseTo: canRaise ? Math.min(maxRaiseTo, round.currentBet + round.lastFullRaiseSize) : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
    // Naming for the UI: with no bet in front of you it is a bet, not a raise.
    raiseIsBet: round.currentBet === 0,
  };
}

/**
 * Apply one action. Mutates `seat` (and `round`, and other seats on a raise).
 * Returns `{ error }` or a description of what happened.
 */
export function applyAction(round, seats, seat, act) {
  const legal = legalActions(round, seat);
  if (!legal.fold) return { error: 'cannot_act' };

  switch (act.type) {
    case 'fold':
      seat.folded = true;
      seat.hasActed = true;
      seat.lastAction = { kind: 'fold' };
      return { kind: 'fold' };

    case 'check':
      if (!legal.check) return { error: 'cannot_check' };
      seat.hasActed = true;
      seat.lastAction = { kind: 'check' };
      return { kind: 'check' };

    case 'call': {
      if (!legal.call) return { error: 'nothing_to_call' };
      const paid = commit(seat, legal.callAmount);
      seat.hasActed = true;
      seat.lastAction = { kind: seat.allIn ? 'allIn' : 'call', amount: seat.committedThisRound };
      return { kind: 'call', amount: paid, allIn: seat.allIn };
    }

    case 'raise': {
      if (!legal.raise) return { error: 'cannot_raise' };
      let to = Math.floor(Number(act.to));
      if (!Number.isFinite(to)) return { error: 'bad_amount' };
      if (to > legal.maxRaiseTo) to = legal.maxRaiseTo;
      // Below the minimum is legal only as an all-in for the whole stack.
      if (to < legal.minRaiseTo && to !== legal.maxRaiseTo) return { error: 'raise_too_small' };
      if (to <= round.currentBet) return { error: 'raise_too_small' };

      const increment = to - round.currentBet;
      commit(seat, to - seat.committedThisRound);
      const full = increment >= round.lastFullRaiseSize;
      const wasBet = round.currentBet === 0;
      round.currentBet = to;
      if (full) round.lastFullRaiseSize = increment;

      // Only a full raise gives everyone their action back. After a short
      // all-in the others still owe the extra chips — that falls out of
      // `needsToAct` below rather than needing a flag here.
      if (full) {
        for (const s of seats) {
          if (s !== seat && !s.folded && !s.allIn) s.hasActed = false;
        }
      }
      seat.hasActed = true;
      seat.lastAction = { kind: seat.allIn ? 'allIn' : wasBet ? 'bet' : 'raise', amount: to };
      return { kind: wasBet ? 'bet' : 'raise', to, full, allIn: seat.allIn };
    }

    default:
      return { error: 'unknown_action' };
  }
}

/**
 * Does this seat still owe action? True either because they have not acted, or
 * because a later wager left them short of the current bet.
 */
export function needsToAct(round, seat) {
  if (seat.folded || seat.allIn) return false;
  return !seat.hasActed || seat.committedThisRound < round.currentBet;
}

export function roundComplete(round, seats) {
  const live = seats.filter((s) => !s.folded);
  if (live.length <= 1) return true;
  return !seats.some((s) => needsToAct(round, s));
}

/** Next seat index that owes action, searching left from `fromIndex`. */
export function nextActor(round, seats, fromIndex) {
  const n = seats.length;
  for (let step = 1; step <= n; step++) {
    const i = (fromIndex + step) % n;
    if (needsToAct(round, seats[i])) return i;
  }
  return -1;
}
