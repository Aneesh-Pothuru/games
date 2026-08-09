/**
 * The hot-path evaluator.
 *
 * `cards.js` has an evaluator already, and it stays: it is the readable one,
 * the one you check a rule against. This is the one the equity loops call
 * millions of times, and it exists because the readable one runs at 1.8M
 * hands/sec while this runs at 20M — measured, same machine, same hands.
 *
 * That ratio is not a micro-optimisation, it is the difference between two
 * products. At 1.8M/sec a decision can afford 5,000 Monte Carlo samples, which
 * is worth +/-1.4 points at 95% — so the coach says "62%" when the truth is
 * anywhere from 60.6 to 63.4. At 20M/sec the same decision affords 40,000
 * samples and +/-0.5. The advice stops wobbling and starts being worth quoting.
 *
 * THE TWO IMPLEMENTATIONS MUST AGREE, EXACTLY, ON EVERY HAND. They return the
 * identical integer — same category, same kickers, same packing — so `===` is
 * still a tie and `>` is still a win, and the test suite cross-checks them
 * against each other. Two independent implementations that must agree is a far
 * better guard than either one tested alone.
 *
 * How it goes fast:
 *
 *   RANKS AS BITMASKS, COUNTED BY CASCADE. m1 is the ranks seen at least once,
 *   m2 at least twice, m3 three times, m4 four. Each new card does
 *   `m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b`, so every rank
 *   multiplicity falls out of four ORs with no array and no loop over ranks.
 *   Then quads is `m4 != 0`, a boat is `m3 != 0 && (m2 ^ top) != 0`, and the
 *   highest of anything is `31 - clz32(mask)`, which is one instruction.
 *
 *   SUIT COUNTS PACKED INTO ONE INT. Four nibbles, one per suit. A suit has
 *   five or more iff adding 3 to its nibble overflows into bit 3, so
 *   `(sc + 0x3333) & 0x8888` tests all four suits at once. With at most seven
 *   cards the maximum nibble is 7+3 = 10, so nothing carries into its
 *   neighbour. And with at most seven cards only one suit can reach five, so
 *   the branch is unambiguous.
 *
 *   ONE 8 KB TABLE, BUILT AT BOOT. STRAIGHT[mask] is the straight's high rank
 *   plus one, or zero. It costs 2ms to build and nothing to ship, which is why
 *   it is generated rather than embedded — a 123 MB lookup table would be
 *   faster still and would not fit in a Worker.
 *
 * A flush can never coexist with quads or a full house in seven cards, so
 * returning early on the flush branch cannot miss a better hand: five cards of
 * one suit are five distinct ranks, which leaves two cards to build a boat out
 * of, and two cards is not enough.
 */

/** Category ordinals. Identical to CATEGORY in cards.js, by construction. */
export const CAT = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, BOAT: 6, QUADS: 7, SF: 8,
};

// score = cat * 16^5 + k1 * 16^4 + ... + k5. Matches cards.js exactly.
const P5 = 16 ** 5;
const P4 = 16 ** 4;
const P3 = 16 ** 3;
const P2 = 256;
const P1 = 16;

/** STRAIGHT[13-bit rank mask] = 1 + the straight's high rank, or 0 for none. */
const STRAIGHT = new Uint8Array(8192);
(() => {
  for (let m = 0; m < 8192; m++) {
    let best = 0;
    for (let high = 12; high >= 4; high--) {
      const need = 0b11111 << (high - 4);
      if ((m & need) === need) { best = high + 1; break; }
    }
    // The wheel is a straight and it is the LOWEST one, so it is only reached
    // when no higher run exists. Its high card is the five, not the ace.
    if (best === 0) {
      const wheel = (1 << 12) | 0b1111;
      if ((m & wheel) === wheel) best = 3 + 1;
    }
    STRAIGHT[m] = best;
  }
})();

const { clz32 } = Math;

/** The top five set bits of a 13-bit mask, packed into the kicker slots. */
function top5(mask) {
  let m = mask;
  const a = 31 - clz32(m); m ^= 1 << a;
  const b = 31 - clz32(m); m ^= 1 << b;
  const c = 31 - clz32(m); m ^= 1 << c;
  const d = 31 - clz32(m); m ^= 1 << d;
  const e = 31 - clz32(m);
  return a * P4 + b * P3 + c * P2 + d * P1 + e;
}

/**
 * The best five-card hand out of 5, 6 or 7 cards.
 *
 * Same answer as `evaluate()` in cards.js, for every input, always.
 */
export function evalAny(cards) {
  const n = cards.length;
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let sc = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const b = 1 << (c >> 2);
    m4 |= m3 & b;
    m3 |= m2 & b;
    m2 |= m1 & b;
    m1 |= b;
    sc += 1 << ((c & 3) << 2);
  }

  const flushBit = (sc + 0x3333) & 0x8888;
  if (flushBit !== 0) {
    const s = flushBit === 0x8 ? 0 : flushBit === 0x80 ? 1 : flushBit === 0x800 ? 2 : 3;
    let fm = 0;
    for (let i = 0; i < n; i++) {
      const c = cards[i];
      if ((c & 3) === s) fm |= 1 << (c >> 2);
    }
    const sf = STRAIGHT[fm];
    if (sf !== 0) return CAT.SF * P5 + (sf - 1) * P4;
    return CAT.FLUSH * P5 + top5(fm);
  }

  if (m4 !== 0) {
    const q = 31 - clz32(m4);
    return CAT.QUADS * P5 + q * P4 + (31 - clz32(m1 ^ (1 << q))) * P3;
  }

  if (m3 !== 0) {
    const t = 31 - clz32(m3);
    // Anything else paired plays as the boat's pair — including a second set
    // of trips, which is why this reads m2 (ranks seen twice or more) rather
    // than a separate list of pairs.
    const rest = m2 ^ (1 << t);
    if (rest !== 0) return CAT.BOAT * P5 + t * P4 + (31 - clz32(rest)) * P3;
    const st = STRAIGHT[m1];
    if (st !== 0) return CAT.STRAIGHT * P5 + (st - 1) * P4;
    let r = m1 ^ (1 << t);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    return CAT.TRIPS * P5 + t * P4 + a * P3 + (31 - clz32(r)) * P2;
  }

  const st = STRAIGHT[m1];
  if (st !== 0) return CAT.STRAIGHT * P5 + (st - 1) * P4;

  if (m2 !== 0) {
    const p1 = 31 - clz32(m2);
    const r2 = m2 ^ (1 << p1);
    if (r2 !== 0) {
      const p2 = 31 - clz32(r2);
      return CAT.TWO_PAIR * P5 + p1 * P4 + p2 * P3
        + (31 - clz32(m1 ^ (1 << p1) ^ (1 << p2))) * P2;
    }
    let r = m1 ^ (1 << p1);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    const b = 31 - clz32(r);
    r ^= 1 << b;
    return CAT.PAIR * P5 + p1 * P4 + a * P3 + b * P2 + (31 - clz32(r)) * P1;
  }

  return CAT.HIGH * P5 + top5(m1);
}

/**
 * Seven cards as seven arguments.
 *
 * The argument form exists because it is measurably faster than the array
 * form: no allocation per call, no bounds checks, and the whole thing stays in
 * registers. In the equity loops that is the entire cost.
 */
export function eval7(c0, c1, c2, c3, c4, c5, c6) {
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let sc = 0;
  let b;
  b = 1 << (c0 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c0 & 3) << 2);
  b = 1 << (c1 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c1 & 3) << 2);
  b = 1 << (c2 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c2 & 3) << 2);
  b = 1 << (c3 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c3 & 3) << 2);
  b = 1 << (c4 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c4 & 3) << 2);
  b = 1 << (c5 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c5 & 3) << 2);
  b = 1 << (c6 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((c6 & 3) << 2);

  const flushBit = (sc + 0x3333) & 0x8888;
  if (flushBit !== 0) {
    const s = flushBit === 0x8 ? 0 : flushBit === 0x80 ? 1 : flushBit === 0x800 ? 2 : 3;
    let fm = 0;
    if ((c0 & 3) === s) fm |= 1 << (c0 >> 2);
    if ((c1 & 3) === s) fm |= 1 << (c1 >> 2);
    if ((c2 & 3) === s) fm |= 1 << (c2 >> 2);
    if ((c3 & 3) === s) fm |= 1 << (c3 >> 2);
    if ((c4 & 3) === s) fm |= 1 << (c4 >> 2);
    if ((c5 & 3) === s) fm |= 1 << (c5 >> 2);
    if ((c6 & 3) === s) fm |= 1 << (c6 >> 2);
    const sf = STRAIGHT[fm];
    if (sf !== 0) return CAT.SF * P5 + (sf - 1) * P4;
    return CAT.FLUSH * P5 + top5(fm);
  }

  if (m4 !== 0) {
    const q = 31 - clz32(m4);
    return CAT.QUADS * P5 + q * P4 + (31 - clz32(m1 ^ (1 << q))) * P3;
  }

  if (m3 !== 0) {
    const t = 31 - clz32(m3);
    const rest = m2 ^ (1 << t);
    if (rest !== 0) return CAT.BOAT * P5 + t * P4 + (31 - clz32(rest)) * P3;
    const straight = STRAIGHT[m1];
    if (straight !== 0) return CAT.STRAIGHT * P5 + (straight - 1) * P4;
    let r = m1 ^ (1 << t);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    return CAT.TRIPS * P5 + t * P4 + a * P3 + (31 - clz32(r)) * P2;
  }

  const straight = STRAIGHT[m1];
  if (straight !== 0) return CAT.STRAIGHT * P5 + (straight - 1) * P4;

  if (m2 !== 0) {
    const p1 = 31 - clz32(m2);
    const r2 = m2 ^ (1 << p1);
    if (r2 !== 0) {
      const p2 = 31 - clz32(r2);
      return CAT.TWO_PAIR * P5 + p1 * P4 + p2 * P3
        + (31 - clz32(m1 ^ (1 << p1) ^ (1 << p2))) * P2;
    }
    let r = m1 ^ (1 << p1);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    const b2 = 31 - clz32(r);
    r ^= 1 << b2;
    return CAT.PAIR * P5 + p1 * P4 + a * P3 + b2 * P2 + (31 - clz32(r)) * P1;
  }

  return CAT.HIGH * P5 + top5(m1);
}

/**
 * Hoist the board out of the loop.
 *
 * Every runout in an equity calculation shares the same five board cards, and
 * folding them into the masks once instead of once per villain combo is worth
 * another 30% on top of everything above.
 */
export function boardState(board) {
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let sc = 0;
  for (let i = 0; i < board.length; i++) {
    const c = board[i];
    const b = 1 << (c >> 2);
    m4 |= m3 & b;
    m3 |= m2 & b;
    m2 |= m1 & b;
    m1 |= b;
    sc += 1 << ((c & 3) << 2);
  }
  return { m1, m2, m3, m4, sc, cards: board, n: board.length };
}

/** A prepared board plus two hole cards. */
export function evalBoard2(bs, h0, h1) {
  let m1 = bs.m1;
  let m2 = bs.m2;
  let m3 = bs.m3;
  let m4 = bs.m4;
  let sc = bs.sc;
  let b;
  b = 1 << (h0 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((h0 & 3) << 2);
  b = 1 << (h1 >> 2); m4 |= m3 & b; m3 |= m2 & b; m2 |= m1 & b; m1 |= b; sc += 1 << ((h1 & 3) << 2);

  const flushBit = (sc + 0x3333) & 0x8888;
  if (flushBit !== 0) {
    const s = flushBit === 0x8 ? 0 : flushBit === 0x80 ? 1 : flushBit === 0x800 ? 2 : 3;
    let fm = 0;
    const bc = bs.cards;
    for (let i = 0; i < bs.n; i++) if ((bc[i] & 3) === s) fm |= 1 << (bc[i] >> 2);
    if ((h0 & 3) === s) fm |= 1 << (h0 >> 2);
    if ((h1 & 3) === s) fm |= 1 << (h1 >> 2);
    const sf = STRAIGHT[fm];
    if (sf !== 0) return CAT.SF * P5 + (sf - 1) * P4;
    return CAT.FLUSH * P5 + top5(fm);
  }

  if (m4 !== 0) {
    const q = 31 - clz32(m4);
    return CAT.QUADS * P5 + q * P4 + (31 - clz32(m1 ^ (1 << q))) * P3;
  }

  if (m3 !== 0) {
    const t = 31 - clz32(m3);
    const rest = m2 ^ (1 << t);
    if (rest !== 0) return CAT.BOAT * P5 + t * P4 + (31 - clz32(rest)) * P3;
    const straight = STRAIGHT[m1];
    if (straight !== 0) return CAT.STRAIGHT * P5 + (straight - 1) * P4;
    let r = m1 ^ (1 << t);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    return CAT.TRIPS * P5 + t * P4 + a * P3 + (31 - clz32(r)) * P2;
  }

  const straight = STRAIGHT[m1];
  if (straight !== 0) return CAT.STRAIGHT * P5 + (straight - 1) * P4;

  if (m2 !== 0) {
    const p1 = 31 - clz32(m2);
    const r2 = m2 ^ (1 << p1);
    if (r2 !== 0) {
      const p2 = 31 - clz32(r2);
      return CAT.TWO_PAIR * P5 + p1 * P4 + p2 * P3
        + (31 - clz32(m1 ^ (1 << p1) ^ (1 << p2))) * P2;
    }
    let r = m1 ^ (1 << p1);
    const a = 31 - clz32(r);
    r ^= 1 << a;
    const b2 = 31 - clz32(r);
    r ^= 1 << b2;
    return CAT.PAIR * P5 + p1 * P4 + a * P3 + b2 * P2 + (31 - clz32(r)) * P1;
  }

  return CAT.HIGH * P5 + top5(m1);
}
