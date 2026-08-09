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
import * as nightfall from './nightfall.js';
import * as holdem from './poker/index.js';
import * as cheat from './cheat.js';

const MODULES = [oddoneout, spectrum, cheat, nightfall, holdem, council, sabotage];

export const GAMES = Object.fromEntries(MODULES.map((m) => [m.meta.id, m]));

/**
 * Ordered for the picker. Spectrum is second because it is the only game that
 * works with two people, and a pair opening the app should not have to scroll
 * past four games they cannot play.
 */
export const GAME_LIST = MODULES.map((m) => m.meta);
