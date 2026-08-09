/**
 * Game registry.
 *
 * Every game exposes the same surface, and the lobby knows nothing else about
 * it:
 *   meta            - static description for the picker
 *   defaultConfig   - host-adjustable options
 *   normalizeConfig - validate/clamp anything a client sends
 *   start(room, seed, now)          -> game state
 *   action(room, playerId, act, now) -> {error} | {events}
 *   onDeadline(room, now)            -> {events}
 *   viewFor(room, viewerId)          -> the REDACTED per-player projection
 *   rulesText                        - in-app rules, phase by phase
 *
 * viewFor is the security boundary of the whole product. There is no other
 * code path that puts game state on the wire.
 */

import * as oddoneout from './oddoneout.js';
import * as council from './council.js';
import * as sabotage from './sabotage.js';
import * as spectrum from './spectrum.js';

const MODULES = [oddoneout, council, sabotage, spectrum];

export const GAMES = Object.fromEntries(MODULES.map((m) => [m.meta.id, m]));

/** Ordered for the picker: quickest and easiest to teach first. */
export const GAME_LIST = MODULES.map((m) => m.meta);
