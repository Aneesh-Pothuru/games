/**
 * Side pots.
 *
 * This is the part of poker that implementations get wrong, and the bug is
 * always the same shape: the pot is tracked as a single running number, so when
 * a short stack goes all-in there is nothing left to say *which* chips they were
 * eligible to win. The fix is to never track a scalar pot at all. Pots are
 * derived, every time, from each player's `totalCommitted`.
 *
 * The invariant that catches everything:
 *   sum(pots) + sum(refunds) === sum(totalCommitted)
 * Chips are conserved. There is a test asserting exactly that over random
 * commitment sets.
 */

/** Deep-ish equality for the small id arrays we build below. */
function sameSet(a, b) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Split what everyone put in into layers.
 *
 * @param players [{ id, totalCommitted, folded }]
 * @returns { pots: [{ amount, eligible: [id] }], refunds: { id: chips } }
 *
 * `eligible` excludes folded players — their chips stay in the pot but they
 * cannot win it. A layer built only from folded players' chips is dead money
 * and folds down into the layer below rather than becoming an unwinnable pot.
 */
export function buildPots(players) {
  const committed = new Map();
  for (const p of players) {
    if (p.totalCommitted > 0) committed.set(p.id, p.totalCommitted);
  }

  const refunds = {};
  const amounts = [...committed.values()].sort((a, b) => b - a);
  if (amounts.length) {
    const top = amounts[0];
    const second = amounts[1] ?? 0;
    // An uncalled bet is returned. This is the open-shove-into-a-shorter-stack
    // case: nobody could match the excess, so it was never really wagered.
    if (top > second) {
      const id = [...committed].find(([, v]) => v === top)[0];
      refunds[id] = top - second;
      committed.set(id, second);
    }
  }

  const levels = [...new Set(committed.values())].filter((v) => v > 0).sort((a, b) => a - b);
  const pots = [];
  // Chips from a layer every contender folded out of. They belong to the pot
  // below; if no pot exists below them yet, they wait for the first one.
  let orphaned = 0;
  let floor = 0;

  for (const level of levels) {
    const slice = level - floor;
    floor = level;
    let amount = 0;
    const eligible = [];
    for (const p of players) {
      if ((committed.get(p.id) ?? 0) < level) continue;
      amount += slice;
      if (!p.folded) eligible.push(p.id);
    }
    if (amount === 0) continue;

    if (eligible.length === 0) {
      if (pots.length) pots[pots.length - 1].amount += amount;
      else orphaned += amount;
      continue;
    }

    const last = pots[pots.length - 1];
    if (last && sameSet(last.eligible, eligible)) last.amount += amount;
    else pots.push({ amount, eligible });

    if (orphaned) {
      pots[0].amount += orphaned;
      orphaned = 0;
    }
  }

  // Nobody who put chips in is still contesting the hand. Reachable only if a
  // live player committed nothing at all while others bet and folded, which a
  // real betting round cannot produce — but the chips still have to land
  // somewhere, so they go to whoever is left.
  if (orphaned) {
    const live = players.filter((p) => !p.folded).map((p) => p.id);
    if (live.length) pots.push({ amount: orphaned, eligible: live });
    else {
      const [top] = [...committed.keys()];
      refunds[top] = (refunds[top] ?? 0) + orphaned;
    }
  }

  return { pots, refunds };
}

/**
 * Hand every pot to its best eligible hand.
 *
 * @param pots        from buildPots
 * @param scores      { id: evaluate(cards) } for players who reached showdown
 * @param oddChipOrder player ids starting immediately left of the button —
 *                     odd chips go to the earliest seat in that order, which is
 *                     the standard rule and the only one that is not arbitrary.
 */
export function awardPots(pots, scores, oddChipOrder) {
  const won = {};
  const detail = [];

  for (const pot of pots) {
    const contenders = pot.eligible.filter((id) => scores[id] !== undefined);
    if (!contenders.length) continue;

    let best = -Infinity;
    for (const id of contenders) if (scores[id] > best) best = scores[id];
    // Equal scores are a genuine tie — the evaluator never encodes suit, so
    // this is a split and not a comparison that happened to land on equality.
    const winners = oddChipOrder.filter((id) => contenders.includes(id) && scores[id] === best);

    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    for (const id of winners) {
      const extra = odd > 0 ? 1 : 0;
      odd -= extra;
      won[id] = (won[id] ?? 0) + share + extra;
    }
    detail.push({ amount: pot.amount, winners, per: share });
  }

  return { won, detail };
}
