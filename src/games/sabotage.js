/**
 * SABOTAGE — team missions with hidden saboteurs.
 *
 * Mechanically The Resistance: Avalon, implemented from the official
 * Indie Boards & Cards rulebooks. Original name and original role suite:
 * Merlin/Percival/Morgana/Mordred/Oberon as a curated set is Eskridge's
 * expression, so the equivalents here are Analyst, Decoy, Mimic, Ghost and
 * Handler with the same visibility graph.
 *
 * Rules worth calling out, all official and all commonly got wrong:
 *   - a TIED approval vote is a rejection
 *   - five consecutive rejections in one round loses the game outright
 *   - mission 4 needs TWO fails, and only at 7+ players
 *   - the fail COUNT is public; who played what is never revealed
 *   - the 5th proposal is voted on normally; it is not auto-approved
 *   - no assassination after an evil mission win or a 5-rejection win
 */

import { makeRng, shuffle } from '../shared/rng.js';
import { asBool, playerName } from './engine.js';

export const meta = {
  id: 'sabotage',
  name: 'Sabotage',
  tagline: 'Three missions to win. Someone here wants them to fail.',
  blurb:
    'A crew proposes teams and votes them up or down. On a mission, everyone plays success or fail in secret. Nobody is ever eliminated — the whole game is argument and voting record.',
  minPlayers: 5,
  maxPlayers: 10,
  familiar: 'The Resistance: Avalon',
  emblem: 'g-sabotage',
  lengthMinutes: '20–30 min',
};

const LOYALTY = {
  5: { crew: 3, saboteurs: 2 },
  6: { crew: 4, saboteurs: 2 },
  7: { crew: 4, saboteurs: 3 },
  8: { crew: 5, saboteurs: 3 },
  9: { crew: 6, saboteurs: 3 },
  10: { crew: 6, saboteurs: 4 },
};

/** Verified against the rulebook — genuinely non-monotonic at 5 and 6. */
const TEAM_SIZES = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5],
};

const FAILS_REQUIRED = {
  5: [1, 1, 1, 1, 1],
  6: [1, 1, 1, 1, 1],
  7: [1, 1, 1, 2, 1],
  8: [1, 1, 1, 2, 1],
  9: [1, 1, 1, 2, 1],
  10: [1, 1, 1, 2, 1],
};

export const ROLE_INFO = {
  ANALYST: { team: 'CREW', name: 'Analyst', desc: 'You know who the saboteurs are — except the Ghost’s hidden ally. If they identify you at the end, they win.' },
  DECOY: { team: 'CREW', name: 'Decoy', desc: 'You see two people. One is the Analyst, one is the Mimic. You don’t know which.' },
  CREW: { team: 'CREW', name: 'Crew', desc: 'You know nothing. Work it out from the voting record.' },
  HANDLER: { team: 'SABOTEUR', name: 'Handler', desc: 'A saboteur. If the crew wins three missions, you get one guess at the Analyst.' },
  MIMIC: { team: 'SABOTEUR', name: 'Mimic', desc: 'A saboteur. The Decoy sees you as though you might be the Analyst.' },
  SHADOW: { team: 'SABOTEUR', name: 'Shadow', desc: 'A saboteur hidden from the Analyst.' },
  GHOST: { team: 'SABOTEUR', name: 'Ghost', desc: 'A saboteur who knows no one and whom no other saboteur knows. The Analyst can see you.' },
  SABOTEUR: { team: 'SABOTEUR', name: 'Saboteur', desc: 'You know your fellow saboteurs.' },
};

/** Community-standard sets; the rulebook only fixes three constraints. */
const ROLE_SETS = {
  5: { crew: ['ANALYST', 'DECOY', 'CREW'], evil: ['HANDLER', 'MIMIC'] },
  6: { crew: ['ANALYST', 'DECOY', 'CREW', 'CREW'], evil: ['HANDLER', 'MIMIC'] },
  7: { crew: ['ANALYST', 'DECOY', 'CREW', 'CREW'], evil: ['HANDLER', 'MIMIC', 'GHOST'] },
  8: { crew: ['ANALYST', 'DECOY', 'CREW', 'CREW', 'CREW'], evil: ['HANDLER', 'MIMIC', 'SHADOW'] },
  9: { crew: ['ANALYST', 'DECOY', 'CREW', 'CREW', 'CREW', 'CREW'], evil: ['HANDLER', 'MIMIC', 'SHADOW'] },
  10: { crew: ['ANALYST', 'DECOY', 'CREW', 'CREW', 'CREW', 'CREW'], evil: ['HANDLER', 'MIMIC', 'SHADOW', 'GHOST'] },
};

export const defaultConfig = { specialRoles: true };

export function normalizeConfig(config) {
  return { specialRoles: asBool(config.specialRoles, true) };
}

export function start(room, seed) {
  const rng = makeRng(seed);
  const ids = shuffle(room.players.map((p) => p.id), rng);
  const n = ids.length;
  const split = LOYALTY[n];

  let bag;
  if (room.config.specialRoles) {
    const set = ROLE_SETS[n];
    bag = [...set.crew, ...set.evil];
  } else {
    // Plain mode: no special knowledge, just crew vs saboteurs.
    bag = [...Array(split.crew).fill('CREW'), ...Array(split.saboteurs).fill('SABOTEUR')];
  }
  const dealt = shuffle(bag, rng);
  const roles = {};
  ids.forEach((id, i) => {
    roles[id] = dealt[i];
  });

  return {
    seed,
    phase: 'reveal',
    roles,
    order: ids,
    leaderIndex: 0,
    mission: 0,
    results: [null, null, null, null, null],
    rejections: 0,
    proposal: [],
    votes: {},
    votesRevealed: null,
    missionCards: {},
    lastMission: null,
    acked: {},
    log: [],
    deadline: null,
    over: null,
  };
}

const teamOf = (role) => ROLE_INFO[role].team;
const leader = (g) => g.order[g.leaderIndex];
export const teamSize = (n, mission) => TEAM_SIZES[n][mission];
export const failsNeeded = (n, mission) => FAILS_REQUIRED[n][mission];

function note(g, text) {
  g.log.push(text);
  if (g.log.length > 30) g.log.shift();
}

function finish(g, winner, reason) {
  g.phase = 'over';
  g.over = { winner, reason };
}

export function action(room, playerId, act) {
  const g = room.game;
  const n = room.players.length;
  if (g.phase === 'over') return { error: 'game_over' };

  switch (act.type) {
    case 'ack': {
      if (g.phase !== 'reveal') return { error: 'wrong_phase' };
      g.acked[playerId] = true;
      if (g.order.every((id) => g.acked[id])) g.phase = 'propose';
      return {};
    }

    case 'propose': {
      if (g.phase !== 'propose') return { error: 'wrong_phase' };
      if (playerId !== leader(g)) return { error: 'not_leader' };
      const team = [...new Set(act.team ?? [])];
      if (team.length !== teamSize(n, g.mission)) return { error: 'wrong_team_size' };
      if (!team.every((id) => g.order.includes(id))) return { error: 'bad_team' };
      g.proposal = team;
      g.votes = {};
      g.votesRevealed = null;
      g.phase = 'vote';
      return { events: [{ kind: 'proposed', name: playerName(room, playerId) }] };
    }

    case 'vote': {
      if (g.phase !== 'vote') return { error: 'wrong_phase' };
      if (act.value !== 'APPROVE' && act.value !== 'REJECT') return { error: 'bad_vote' };
      g.votes[playerId] = act.value;
      if (!g.order.every((id) => g.votes[id])) return {};

      const approve = g.order.filter((id) => g.votes[id] === 'APPROVE').length;
      const reject = g.order.length - approve;
      g.votesRevealed = { ...g.votes };
      const events = [{ kind: 'voteResult', approve, reject, passed: approve > reject }];

      // A tie is a rejection.
      if (approve <= reject) {
        g.rejections++;
        g.leaderIndex = (g.leaderIndex + 1) % g.order.length;
        note(g, `Team rejected ${approve}–${reject}. (${g.rejections}/5)`);
        if (g.rejections >= 5) {
          finish(g, 'SABOTEUR', 'FIVE_REJECTIONS');
          return { events };
        }
        g.phase = 'propose';
        g.proposal = [];
        return { events };
      }

      g.rejections = 0;
      g.missionCards = {};
      g.phase = 'mission';
      note(g, `Team approved ${approve}–${reject}.`);
      return { events };
    }

    case 'missionCard': {
      if (g.phase !== 'mission') return { error: 'wrong_phase' };
      if (!g.proposal.includes(playerId)) return { error: 'not_on_team' };
      if (act.value !== 'SUCCESS' && act.value !== 'FAIL') return { error: 'bad_card' };
      // Crew MUST play success. Rejected at the server, not coerced silently.
      if (act.value === 'FAIL' && teamOf(g.roles[playerId]) === 'CREW') return { error: 'crew_must_succeed' };
      g.missionCards[playerId] = act.value;
      if (!g.proposal.every((id) => g.missionCards[id])) return {};
      return resolveMission(g, room, n);
    }

    case 'assassinate': {
      if (g.phase !== 'assassinate') return { error: 'wrong_phase' };
      if (g.roles[playerId] !== 'HANDLER') return { error: 'not_handler' };
      if (!g.order.includes(act.target) || act.target === playerId) return { error: 'bad_target' };
      g.assassinTarget = act.target;
      if (g.roles[act.target] === 'ANALYST') finish(g, 'SABOTEUR', 'ANALYST_FOUND');
      else finish(g, 'CREW', 'ANALYST_SAFE');
      return { events: [{ kind: 'assassinated', name: playerName(room, act.target) }] };
    }

    default:
      return { error: 'unknown_action' };
  }
}

function resolveMission(g, room, n) {
  const fails = Object.values(g.missionCards).filter((c) => c === 'FAIL').length;
  const needed = failsNeeded(n, g.mission);
  const success = fails < needed;
  g.results[g.mission] = success ? 'SUCCESS' : 'FAIL';
  // The fail count is public; who played what is never revealed.
  g.lastMission = { mission: g.mission, fails, needed, success, team: g.proposal };
  note(g, `Mission ${g.mission + 1} ${success ? 'succeeded' : 'failed'} (${fails} fail${fails === 1 ? '' : 's'}).`);

  const events = [{ kind: 'mission', success, fails }];
  const succeeded = g.results.filter((r) => r === 'SUCCESS').length;
  const failed = g.results.filter((r) => r === 'FAIL').length;

  g.mission++;
  g.leaderIndex = (g.leaderIndex + 1) % g.order.length;
  g.rejections = 0;
  g.proposal = [];
  g.missionCards = {};

  if (failed >= 3) {
    finish(g, 'SABOTEUR', 'THREE_FAILED');
    return { events };
  }
  if (succeeded >= 3) {
    if (room.config.specialRoles) g.phase = 'assassinate';
    else finish(g, 'CREW', 'THREE_SUCCEEDED');
    return { events };
  }
  g.phase = 'propose';
  return { events };
}

export function onDeadline() {
  return {};
}

/** The visibility graph, expressed declaratively rather than as if-statements. */
function knowledgeFor(g, viewerId) {
  const myRole = g.roles[viewerId];
  if (!myRole) return [];
  const others = g.order.filter((id) => id !== viewerId);
  const roleOf = (id) => g.roles[id];

  // Saboteurs recognise each other, but never the Ghost.
  if (teamOf(myRole) === 'SABOTEUR' && myRole !== 'GHOST') {
    return others
      .filter((id) => teamOf(roleOf(id)) === 'SABOTEUR' && roleOf(id) !== 'GHOST')
      .map((id) => ({ id, label: 'Saboteur' }));
  }
  // The Analyst sees every saboteur except the Shadow — the Ghost included.
  if (myRole === 'ANALYST') {
    return others
      .filter((id) => teamOf(roleOf(id)) === 'SABOTEUR' && roleOf(id) !== 'SHADOW')
      .map((id) => ({ id, label: 'Saboteur' }));
  }
  // The Decoy sees the Analyst and the Mimic as an unordered, unlabelled pair.
  if (myRole === 'DECOY') {
    return others
      .filter((id) => roleOf(id) === 'ANALYST' || roleOf(id) === 'MIMIC')
      .map((id) => ({ id, label: 'Analyst or Mimic' }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
  return [];
}

export function viewFor(room, viewerId) {
  const g = room.game;
  const n = room.players.length;
  const over = g.phase === 'over';
  const myRole = g.roles[viewerId] ?? null;

  return {
    game: 'sabotage',
    phase: g.phase,
    mission: g.mission,
    results: g.results,
    rejections: g.rejections,
    leader: leader(g),
    order: g.order,
    proposal: g.proposal,
    requiredSize: g.mission < 5 ? teamSize(n, g.mission) : 0,
    failsNeeded: g.mission < 5 ? failsNeeded(n, g.mission) : 1,
    teamSizes: TEAM_SIZES[n],
    failTable: FAILS_REQUIRED[n],
    voted: Object.keys(g.votes),
    votes: g.votesRevealed ?? (g.votes[viewerId] ? { [viewerId]: g.votes[viewerId] } : {}),
    votesRevealed: Boolean(g.votesRevealed),
    // Who has played is public; what they played never is.
    playedCard: Object.keys(g.missionCards),
    myCard: g.missionCards[viewerId] ?? null,
    onTeam: g.proposal.includes(viewerId),
    myRole,
    myRoleInfo: myRole ? ROLE_INFO[myRole] : null,
    myTeam: myRole ? teamOf(myRole) : null,
    known: knowledgeFor(g, viewerId),
    // The role set in play is public — Decoy's read is meaningless otherwise.
    roleSet: room.config.specialRoles ? Object.values(g.roles).slice().sort() : null,
    lastMission: g.lastMission,
    acked: g.acked,
    log: g.log,
    over: g.over,
    assassinTarget: g.assassinTarget ?? null,
    reveal: over ? g.roles : null,
  };
}

export const rulesText = [
  {
    h: 'Two sides',
    p: 'Most of you are Crew. A hidden minority are Saboteurs and know each other. Nobody is ever eliminated — you play all the way through.',
  },
  {
    h: 'Every round',
    p: 'The leader proposes a team of a fixed size. Everyone votes to approve or reject, and a tie counts as a rejection. Reject five teams in a row and the Saboteurs win on the spot.',
  },
  {
    h: 'On a mission',
    p: 'Everyone on the team secretly plays success or fail. Crew must play success. Saboteurs may play either — and often should play success early to stay clean.',
  },
  {
    h: 'Winning',
    p: 'Three successful missions and the Crew are close to winning. Three failures and the Saboteurs take it.',
  },
  {
    h: 'The fourth mission',
    p: 'With seven or more players, mission four needs TWO fails to go down. One fail is announced publicly and tells you a great deal.',
  },
  {
    h: 'The last move',
    p: 'If the Crew win three missions, the Handler gets one guess at who the Analyst is. Guess right and the Saboteurs steal it.',
  },
];
