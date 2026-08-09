/**
 * THE COUNCIL — hidden-role legislature.
 *
 * Mechanically this is Secret Hitler, implemented against the official
 * rulebook. Game mechanics are not copyrightable (DaVinci v. Ziko), but the
 * name, art, and theme are, so the setting here is original: a colony ship's
 * governing council with a Cabal trying to seat their Architect.
 *
 * Mapping, for anyone checking the rules against the original:
 *   Steward / Cabal / Architect   <- Liberal / Fascist / Hitler
 *   Speaker / Deputy              <- President / Chancellor
 *   Charter / Decree              <- Liberal / Fascist policy
 *   Audit / Foresight / Session / Purge <- Investigate / Peek / Special Election / Execution
 *
 * Rules that implementations habitually get wrong, all handled below:
 *   - a policy enacted by the chaos tracker grants NO power
 *   - chaos also wipes term limits and resets the tracker
 *   - the tracker resets on POLICY ENACTMENT, not on a successful election,
 *     so a passed election that ends in a veto leaves it incremented
 *   - a veto advances the tracker, and can therefore trigger chaos
 *   - the "only the last Deputy is term-limited" exception counts LIVING
 *     players, so it switches on mid-game after purges
 *   - Audit reveals PARTY, not role, so the Architect audits as Cabal
 */

import { makeRng, shuffle } from '../shared/rng.js';
import { asBool, clampInt, playerName } from './engine.js';

export const meta = {
  id: 'council',
  name: 'The Council',
  tagline: 'Pass the charter. Or seat your Architect.',
  blurb:
    'Two factions sit on one council. The Stewards outnumber the Cabal but cannot tell who is who. The Cabal know each other — and they know which of them must never be elected Deputy.',
  minPlayers: 5,
  maxPlayers: 10,
  familiar: 'Secret Hitler',
  emblem: 'g-council',
  lengthMinutes: '25–45 min',
};

export const defaultConfig = {
  allowSelfPurge: false,
  allowSelfAudit: false,
  chaosOnVetoTracker: true,
};

export function normalizeConfig(config) {
  return {
    allowSelfPurge: asBool(config.allowSelfPurge, false),
    allowSelfAudit: asBool(config.allowSelfAudit, false),
    chaosOnVetoTracker: asBool(config.chaosOnVetoTracker, true),
  };
}

/** Verified against the official rulebook and the printed board text. */
const ROLES = {
  5: { stewards: 3, cabal: 1, board: '5-6', architectKnowsCabal: true },
  6: { stewards: 4, cabal: 1, board: '5-6', architectKnowsCabal: true },
  7: { stewards: 4, cabal: 2, board: '7-8', architectKnowsCabal: false },
  8: { stewards: 5, cabal: 2, board: '7-8', architectKnowsCabal: false },
  9: { stewards: 5, cabal: 3, board: '9-10', architectKnowsCabal: false },
  10: { stewards: 6, cabal: 3, board: '9-10', architectKnowsCabal: false },
};

/** Index 0 is the 1st decree slot. Index 5 is always the instant Cabal win. */
const BOARDS = {
  '5-6': [null, null, 'FORESIGHT', 'PURGE', 'PURGE', null],
  '7-8': [null, 'AUDIT', 'SESSION', 'PURGE', 'PURGE', null],
  '9-10': ['AUDIT', 'AUDIT', 'SESSION', 'PURGE', 'PURGE', null],
};

const CHARTERS_TO_WIN = 5;
const DECREES_TO_WIN = 6;
const VETO_UNLOCK = 5;
const ARCHITECT_DANGER_ZONE = 3;
const CHAOS_AT = 3;

export const POWER_LABELS = {
  AUDIT: 'Audit',
  SESSION: 'Emergency Session',
  FORESIGHT: 'Foresight',
  PURGE: 'Purge',
};

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const ids = room.players.map((p) => p.id);
  const setup = ROLES[ids.length];

  const bag = [
    ...Array(setup.stewards).fill('STEWARD'),
    ...Array(setup.cabal).fill('CABAL'),
    'ARCHITECT',
  ];
  const dealt = shuffle(bag, rng);
  const roles = {};
  ids.forEach((id, i) => {
    roles[id] = dealt[i];
  });

  return {
    seed,
    phase: 'reveal',
    roles,
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    board: setup.board,
    architectKnowsCabal: setup.architectKnowsCabal,
    // 6 charters + 11 decrees = 17. The invariant
    //   draw.charters + discard.charters + charters === 6
    // must hold after every mutation.
    draw: shuffle([...Array(6).fill('CHARTER'), ...Array(11).fill('DECREE')], rng),
    discard: [],
    charters: 0,
    decrees: 0,
    tracker: 0,
    seatOrder: ids.slice(),
    seatPointer: Math.floor(rng() * ids.length),
    speaker: null,
    nominee: null,
    electedSpeaker: null,
    electedDeputy: null,
    lastElectedSpeaker: null,
    lastElectedDeputy: null,
    sessionReturnSeat: null,
    votes: {},
    votesRevealed: null,
    speakerHand: null,
    deputyHand: null,
    vetoProposed: false,
    vetoRefused: false,
    pendingPower: null,
    auditResult: null,
    foresight: null,
    audited: {},
    acked: {},
    log: [],
    deadline: null,
    over: null,
  };
}

// ------------------------------------------------------------------ helpers --

const isAlive = (g, id) => g.alive[id] === true;
const livingIds = (g) => g.seatOrder.filter((id) => isAlive(g, id));
const party = (g, id) => (g.roles[id] === 'STEWARD' ? 'STEWARD' : 'CABAL');
const vetoUnlocked = (g) => g.decrees >= VETO_UNLOCK;

function note(g, text) {
  g.log.push(text);
  if (g.log.length > 40) g.log.shift();
}

function nextLivingSeat(g, fromSeat) {
  const n = g.seatOrder.length;
  for (let step = 1; step <= n; step++) {
    const seat = (fromSeat + step) % n;
    if (isAlive(g, g.seatOrder[seat])) return seat;
  }
  return fromSeat;
}

/**
 * A session consumes exactly one candidacy: afterwards the placard returns to
 * the seat that would have followed the player who called it, so a session
 * never skips anyone.
 */
function advanceSpeaker(g) {
  if (g.sessionReturnSeat !== null) {
    g.seatPointer = g.sessionReturnSeat;
    g.sessionReturnSeat = null;
  } else {
    g.seatPointer = nextLivingSeat(g, g.seatPointer);
  }
  g.speaker = g.seatOrder[g.seatPointer];
}

export function termLimited(g, id) {
  const living = livingIds(g).length;
  if (id === g.lastElectedDeputy) return true;
  // With five or fewer alive, only the last Deputy is barred.
  if (living > 5 && id === g.lastElectedSpeaker) return true;
  return false;
}

export function eligibleDeputies(g) {
  return livingIds(g).filter((id) => id !== g.speaker && !termLimited(g, id));
}

function ensureDraw(g, rng) {
  if (g.draw.length >= 3) return;
  // Leftovers are shuffled in — never revealed, never stacked on top.
  g.draw = shuffle([...g.draw, ...g.discard], rng);
  g.discard = [];
}

function rngFor(g) {
  // Derive a fresh stream per call site from the stored seed plus progress, so
  // the whole game stays reproducible from `seed` alone.
  return makeRng((g.seed ^ (g.charters * 73856093) ^ (g.decrees * 19349663) ^ (g.tracker * 83492791) ^ g.log.length) >>> 0);
}

function finish(g, winner, reason) {
  g.phase = 'over';
  g.deadline = null;
  g.over = { winner, reason };
}

// ------------------------------------------------------------- enact policy --

function enactPolicy(g, tile, viaGovernment, room) {
  const events = [];
  if (tile === 'CHARTER') g.charters++;
  else g.decrees++;

  // Any face-up policy resets the tracker — including a chaos enactment.
  g.tracker = 0;
  note(g, tile === 'CHARTER' ? 'A Charter was enacted.' : 'A Decree was enacted.');
  events.push({ kind: 'policy', tile });

  if (g.charters >= CHARTERS_TO_WIN) {
    finish(g, 'STEWARD', 'CHARTERS');
    return events;
  }
  if (g.decrees >= DECREES_TO_WIN) {
    finish(g, 'CABAL', 'DECREES');
    return events;
  }

  ensureDraw(g, rngFor(g));

  // A policy the frustrated council enacts on its own grants no power at all.
  const power = viaGovernment && tile === 'DECREE' ? BOARDS[g.board][g.decrees - 1] : null;
  if (!power) {
    beginNomination(g);
    return events;
  }

  g.pendingPower = power;
  events.push({ kind: 'power', power, speaker: playerName(room, g.electedSpeaker) });
  switch (power) {
    case 'AUDIT':
      g.phase = 'power_audit';
      break;
    case 'SESSION':
      g.phase = 'power_session';
      break;
    case 'FORESIGHT':
      g.phase = 'power_foresight';
      g.foresight = g.draw.slice(0, 3);
      break;
    case 'PURGE':
      g.phase = 'power_purge';
      break;
    default:
      beginNomination(g);
  }
  return events;
}

function beginNomination(g) {
  g.pendingPower = null;
  g.auditResult = null;
  g.foresight = null;
  g.speakerHand = null;
  g.deputyHand = null;
  g.vetoProposed = false;
  g.vetoRefused = false;
  g.votes = {};
  g.votesRevealed = null;
  g.electedSpeaker = null;
  g.electedDeputy = null;
  g.nominee = null;
  advanceSpeaker(g);
  g.phase = 'nominate';
}

function runChaos(g, room) {
  ensureDraw(g, rngFor(g));
  const tile = g.draw.shift();
  // Chaos wipes term limits: everyone is eligible for Deputy next election.
  g.lastElectedSpeaker = null;
  g.lastElectedDeputy = null;
  note(g, 'The council fractured. The top policy was enacted with no oversight.');
  const events = [{ kind: 'chaos' }];
  events.push(...enactPolicy(g, tile, false, room));
  return events;
}

// ---------------------------------------------------------------- actions ----

export function action(room, playerId, act, now) {
  const g = room.game;
  if (g.phase === 'over') return { error: 'game_over' };
  if (!isAlive(g, playerId) && act.type !== 'ack') return { error: 'you_are_out' };

  switch (act.type) {
    case 'ack': {
      if (g.phase !== 'reveal') return { error: 'wrong_phase' };
      g.acked[playerId] = true;
      if (livingIds(g).every((id) => g.acked[id])) {
        g.speaker = g.seatOrder[g.seatPointer];
        g.phase = 'nominate';
      }
      return {};
    }

    case 'nominate': {
      if (g.phase !== 'nominate') return { error: 'wrong_phase' };
      if (playerId !== g.speaker) return { error: 'not_speaker' };
      if (!eligibleDeputies(g).includes(act.target)) return { error: 'ineligible_deputy' };
      g.nominee = act.target;
      g.votes = {};
      g.votesRevealed = null;
      g.phase = 'vote';
      return { events: [{ kind: 'nominated', name: playerName(room, act.target) }] };
    }

    case 'vote': {
      if (g.phase !== 'vote') return { error: 'wrong_phase' };
      if (act.value !== 'YES' && act.value !== 'NO') return { error: 'bad_vote' };
      g.votes[playerId] = act.value;
      if (!livingIds(g).every((id) => g.votes[id])) return {};
      return resolveElection(g, room);
    }

    case 'discardPolicy': {
      if (g.phase !== 'legislate_speaker') return { error: 'wrong_phase' };
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      const i = clampInt(act.index, 0, 2, -1);
      if (i < 0 || !g.speakerHand) return { error: 'bad_index' };
      const kept = g.speakerHand.filter((_, idx) => idx !== i);
      g.discard.push(g.speakerHand[i]);
      g.deputyHand = kept;
      g.speakerHand = null;
      g.phase = 'legislate_deputy';
      return {};
    }

    case 'enactPolicy': {
      if (g.phase !== 'legislate_deputy') return { error: 'wrong_phase' };
      if (playerId !== g.electedDeputy) return { error: 'not_deputy' };
      const i = clampInt(act.index, 0, 1, -1);
      if (i < 0 || !g.deputyHand) return { error: 'bad_index' };
      const tile = g.deputyHand[i];
      g.discard.push(g.deputyHand[1 - i]);
      g.deputyHand = null;
      g.lastElectedSpeaker = g.electedSpeaker;
      g.lastElectedDeputy = g.electedDeputy;
      return { events: enactPolicy(g, tile, true, room) };
    }

    case 'proposeVeto': {
      if (g.phase !== 'legislate_deputy') return { error: 'wrong_phase' };
      if (playerId !== g.electedDeputy) return { error: 'not_deputy' };
      if (!vetoUnlocked(g)) return { error: 'veto_locked' };
      if (g.vetoRefused) return { error: 'veto_refused' };
      g.vetoProposed = true;
      g.phase = 'veto_consent';
      return { events: [{ kind: 'vetoProposed' }] };
    }

    case 'vetoConsent': {
      if (g.phase !== 'veto_consent') return { error: 'wrong_phase' };
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      if (act.value === false) {
        // Refused: the Deputy must now enact, and may not propose again.
        g.vetoProposed = false;
        g.vetoRefused = true;
        g.phase = 'legislate_deputy';
        return { events: [{ kind: 'vetoRefused' }] };
      }
      g.discard.push(...g.deputyHand);
      g.deputyHand = null;
      g.lastElectedSpeaker = g.electedSpeaker;
      g.lastElectedDeputy = g.electedDeputy;
      // A veto is an inactive government: it advances the tracker.
      g.tracker++;
      note(g, 'The agenda was vetoed.');
      const events = [{ kind: 'vetoAgreed' }];
      ensureDraw(g, rngFor(g));
      if (g.tracker >= CHAOS_AT && room.config.chaosOnVetoTracker) {
        advanceSpeaker(g);
        events.push(...runChaos(g, room));
      } else {
        beginNomination(g);
      }
      return { events };
    }

    case 'audit': {
      if (g.phase !== 'power_audit') return { error: 'wrong_phase' };
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      const target = act.target;
      if (!isAlive(g, target)) return { error: 'bad_target' };
      if (target === playerId && !room.config.allowSelfAudit) return { error: 'bad_target' };
      if (g.audited[target]) return { error: 'already_audited' };
      g.audited[target] = true;
      // Party, not role: the Architect audits as Cabal.
      g.auditResult = { target, party: party(g, target) };
      g.phase = 'power_audit_result';
      note(g, `${playerName(room, playerId)} audited ${playerName(room, target)}.`);
      return { events: [{ kind: 'audited', name: playerName(room, target) }] };
    }

    case 'ackPower': {
      if (g.phase !== 'power_audit_result' && g.phase !== 'power_foresight') {
        return { error: 'wrong_phase' };
      }
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      beginNomination(g);
      return {};
    }

    case 'session': {
      if (g.phase !== 'power_session') return { error: 'wrong_phase' };
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      if (!isAlive(g, act.target) || act.target === playerId) return { error: 'bad_target' };
      g.sessionReturnSeat = nextLivingSeat(g, g.seatOrder.indexOf(g.electedSpeaker));
      g.pendingPower = null;
      g.speakerHand = null;
      g.deputyHand = null;
      g.votes = {};
      g.votesRevealed = null;
      g.electedSpeaker = null;
      g.electedDeputy = null;
      g.nominee = null;
      g.speaker = act.target;
      g.phase = 'nominate';
      note(g, `${playerName(room, act.target)} was called to chair an emergency session.`);
      return { events: [{ kind: 'session', name: playerName(room, act.target) }] };
    }

    case 'purge': {
      if (g.phase !== 'power_purge') return { error: 'wrong_phase' };
      if (playerId !== g.electedSpeaker) return { error: 'not_speaker' };
      const target = act.target;
      if (!isAlive(g, target)) return { error: 'bad_target' };
      if (target === playerId && !room.config.allowSelfPurge) return { error: 'bad_target' };
      g.alive[target] = false;
      note(g, `${playerName(room, target)} was purged from the council.`);
      const events = [{ kind: 'purged', name: playerName(room, target) }];
      if (g.roles[target] === 'ARCHITECT') {
        finish(g, 'STEWARD', 'ARCHITECT_PURGED');
        return { events };
      }
      // Role is NOT revealed otherwise.
      beginNomination(g);
      return { events };
    }

    default:
      return { error: 'unknown_action' };
  }
}

function resolveElection(g, room) {
  const living = livingIds(g);
  const yes = living.filter((id) => g.votes[id] === 'YES').length;
  const no = living.length - yes;
  g.votesRevealed = { ...g.votes };
  const events = [{ kind: 'voteResult', yes, no, passed: yes > no }];

  // A tie fails. The printed placard's "at least 50%" is wrong; the rulebook
  // is authoritative and requires a strict majority.
  if (yes <= no) {
    g.tracker++;
    g.nominee = null;
    note(g, `The government was rejected ${yes}–${no}.`);
    advanceSpeaker(g);
    if (g.tracker >= CHAOS_AT) {
      events.push(...runChaos(g, room));
    } else {
      g.phase = 'nominate';
      g.votes = {};
    }
    return { events };
  }

  g.electedSpeaker = g.speaker;
  g.electedDeputy = g.nominee;
  note(g, `The government was approved ${yes}–${no}.`);

  if (g.decrees >= ARCHITECT_DANGER_ZONE && g.roles[g.electedDeputy] === 'ARCHITECT') {
    finish(g, 'CABAL', 'ARCHITECT_SEATED');
    return { events };
  }

  // NOTE: the tracker is deliberately not reset here. Only an enacted policy
  // resets it, so a passed election that ends in a veto keeps its increment.
  ensureDraw(g, rngFor(g));
  g.speakerHand = g.draw.splice(0, 3);
  g.phase = 'legislate_speaker';
  return { events };
}

export function onDeadline() {
  return {};
}

// ------------------------------------------------------------------- view ----

export function viewFor(room, viewerId) {
  const g = room.game;
  const over = g.phase === 'over';
  const myRole = g.roles[viewerId] ?? null;

  // Night knowledge, computed per viewer. At 5-6 the Architect and the single
  // Cabal member know each other; at 7-10 the Cabal know each other and the
  // Architect, and the Architect knows nobody.
  let known = [];
  if (myRole === 'CABAL') {
    known = room.players
      .filter((p) => p.id !== viewerId && (g.roles[p.id] === 'CABAL' || g.roles[p.id] === 'ARCHITECT'))
      .map((p) => ({ id: p.id, role: g.roles[p.id] }));
  } else if (myRole === 'ARCHITECT' && g.architectKnowsCabal) {
    known = room.players
      .filter((p) => g.roles[p.id] === 'CABAL')
      .map((p) => ({ id: p.id, role: 'CABAL' }));
  }

  const iAmSpeaker = viewerId === (g.electedSpeaker ?? g.speaker);

  return {
    game: 'council',
    phase: g.phase,
    charters: g.charters,
    decrees: g.decrees,
    tracker: g.tracker,
    board: g.board,
    powers: BOARDS[g.board],
    drawCount: g.draw.length,
    discardCount: g.discard.length,
    vetoUnlocked: vetoUnlocked(g),
    speaker: g.speaker,
    nominee: g.nominee,
    electedSpeaker: g.electedSpeaker,
    electedDeputy: g.electedDeputy,
    lastElectedSpeaker: g.lastElectedSpeaker,
    lastElectedDeputy: g.lastElectedDeputy,
    alive: g.alive,
    eligible: g.phase === 'nominate' ? eligibleDeputies(g) : [],
    // Who has voted is public; how they voted is private until the reveal.
    voted: Object.keys(g.votes),
    votes: g.votesRevealed ?? (g.votes[viewerId] ? { [viewerId]: g.votes[viewerId] } : {}),
    votesRevealed: Boolean(g.votesRevealed),
    myRole,
    myParty: myRole ? (myRole === 'STEWARD' ? 'STEWARD' : 'CABAL') : null,
    known,
    acked: g.acked,
    // Hands go only to their holder. There is no code path that broadcasts them.
    myHand:
      g.phase === 'legislate_speaker' && viewerId === g.electedSpeaker
        ? g.speakerHand
        : (g.phase === 'legislate_deputy' || g.phase === 'veto_consent') && viewerId === g.electedDeputy
          ? g.deputyHand
          : g.phase === 'veto_consent' && viewerId === g.electedSpeaker
            ? g.deputyHand
            : null,
    vetoProposed: g.vetoProposed,
    vetoRefused: g.vetoRefused,
    pendingPower: g.pendingPower,
    auditResult: iAmSpeaker ? g.auditResult : g.auditResult ? { target: g.auditResult.target } : null,
    foresight: iAmSpeaker && g.phase === 'power_foresight' ? g.foresight : null,
    audited: g.audited,
    log: g.log,
    over: g.over,
    // Roles are public only once the game is over.
    reveal: over ? g.roles : null,
  };
}

export const rulesText = [
  {
    h: 'The two factions',
    p: 'Most of you are Stewards and want five Charters enacted. A minority are the Cabal, want six Decrees, and know exactly who each other are. One of the Cabal is the Architect.',
  },
  {
    h: 'Every round',
    p: 'The Speaker nominates a Deputy. Everyone votes yes or no — a tie fails. If it passes, the Speaker secretly draws three policies, discards one, and passes two to the Deputy, who discards one and enacts the last. Neither may show what they held, and both may lie about it freely.',
  },
  {
    h: 'How the Stewards win',
    p: 'Enact five Charters, or purge the Architect.',
  },
  {
    h: 'How the Cabal wins',
    p: 'Enact six Decrees, or get the Architect elected Deputy once three Decrees are already on the board. Watch for the danger-zone warning.',
  },
  {
    h: 'Powers',
    p: 'Some Decree slots hand the sitting Speaker a power: audit a member’s allegiance, look at the next three policies, chair an emergency session, or purge someone from the council. The Speaker must use it, and may lie about anything they learn.',
  },
  {
    h: 'Deadlock',
    p: 'Three failed governments in a row and the council enacts the top policy itself — with no power triggered and all term limits forgotten.',
  },
];
