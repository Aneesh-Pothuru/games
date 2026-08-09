/**
 * Seeded, deterministic RNG.
 *
 * Every random decision in a game (role dealing, deck order, secret targets)
 * runs through here with a seed stored in room state. That makes a finished
 * round reproducible from `seed + ordered commands`, which matters because
 * social deduction players *will* accuse the app of cheating.
 */

/** mulberry32 — small, fast, good enough distribution for card dealing. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a 32-bit seed from a string, so seeds can be human-readable. */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Cryptographically random 32-bit seed for fresh rounds. */
export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** Fisher-Yates. Returns a new array; does not mutate the input. */
export function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick one element. */
export function pick(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

/** Pick `n` distinct elements. */
export function pickMany(items, n, rng) {
  return shuffle(items, rng).slice(0, n);
}

/** Random integer in [min, max]. */
export function randInt(min, max, rng) {
  return min + Math.floor(rng() * (max - min + 1));
}
