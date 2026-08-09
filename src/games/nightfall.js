/**
 * NIGHTFALL — the village sleeps, the wolves hunt.
 *
 * Werewolf/Mafia is a folk game (Davidoff, 1986) with no owner, so this is
 * the one game here that needs no renaming. It follows the official
 * Werewolves of Miller's Hollow rulebook where that rulebook takes a
 * position, and makes everything else a toggle, because there is genuinely no
 * canonical ruleset.
 *
 * The app replaces the moderator entirely. That is the whole value: no one
 * sits out, nobody closes their eyes, and nobody reads the same script twelve
 * times a night.
 *
 * The part implementations get wrong is night resolution. Actions are
 * COLLECTED in a fixed order and then RESOLVED in a single pass, never
 * resolved at submit time. Deaths then cascade through a FIFO queue so a
 * Hunter's shot and a Lover's grief chain deterministically, and the win check
 * runs exactly once at the end — never mid-cascade.
 */

import { makeRng, shuffle } from '../shared/rng.js';
import { asBool, clampInt, oneOf, playerName } from './engine.js';

export const meta = {
  id: 'nightfall',
  name: 'Nightfall',
  tagline: 'The village sleeps. Something doesn’t.',
  blurb:
    'Wolves pick someone off each night; by day the village argues and hangs someone. No moderator, no closed eyes, nobody sitting out — everyone plays.',
  minPlayers: 5,
  maxPlayers: 16,
  familiar: 'Werewolf / Mafia',
  emblem: 'g-nightfall',
  lengthMinutes: '10–20 min',
};

export const ROLE_INFO = {
  WOLF: { team: 'WOLF', name: 'Werewolf', desc: 'Each night, agree with the other wolves on someone to kill.' },
  VILLAGER: { team: 'VILLAGE', name: 'Villager', desc: 'No power. Your vote and your argument are the whole job.' },
  SEER: { team: 'VILLAGE', name: 'Seer', desc: 'Each night, learn whether one player is a werewolf.' },
  DOCTOR: { team: 'VILLAGE', name: 'Doctor', desc: 'Each night, protect one player from the wolves. Not the same person twice running.' },
  HUNTER: { team: 'VILLAGE', name: 'Hunter', desc: 'When you die — by any cause — you take someone with you.' },
  WITCH: { team: 'VILLAGE', name: 'Witch', desc: 'One healing potion and one poison, each once per game. You are shown the wolves’ victim.' },
};

const DEFAULT_ROLES = ['SEER', 'DOCTOR', 'HUNTER', 'WITCH'];

export const defaultConfig = {
  roles: DEFAULT_ROLES,
  parityWin: true,
  revealRoleOnDeath: true,
  noKillFirstNight: false,
  discussionSeconds: 180,
};

export function normalizeConfig(config) {
  const roles = Array.isArray(config.roles)
    ? config.roles.filter((r) => DEFAULT_ROLES.includes(r))
    : DEFAULT_ROLES;
  return {
    roles: [...new Set(roles)],
    parityWin: asBool(config.parityWin, true),
    revealRoleOnDeath: asBool(config.revealRoleOnDeath, true),
    noKillFirstNight: asBool(config.noKillFirstNight, false),
    discussionSeconds: clampInt(config.discussionSeconds, 30, 600, 180),
  };
}

/** Miller's Hollow official ratio, extended down for small tables. */
export function wolfCount(n) {
  if (n <= 7) return 1;
  if (n <= 11) return 2;
  if (n <= 17) return 3;
  return 4;
}

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const ids = shuffle(room.players.map((p) => p.id), rng);
  const n = ids.length;

  const wolves = wolfCount(n);
  const specials = room.config.roles.slice(0, Math.max(0, n - wolves - 1));
  const bag = [...Array(wolves).fill('WOLF'), ...specials];
  while (bag.length < n) bag.push('VILLAGER');

  const dealt = shuffle(bag.slice(0, n), rng);
  const roles = {};
  ids.forEach((id, i) => {
    roles[id] = dealt[i];
  });

  return {
    seed,
    phase: 'reveal',
    night: 0,
    // Snapshotted at start so a mid-game config change can't alter the win
    // condition under the players.
    parityWin: room.config.parityWin,
    noKillFirstNight: room.config.noKillFirstNight,
    roles,
    alive: Object.fromEntries(ids.map((id) => [id, true])),
    order: ids,
    acked: {},
    // Collected each night, resolved in one pass.
    actions: { wolfVotes: {}, doctor: null, seerTarget: null, witchHeal: false, witchPoison: null },
    seerResults: {},
    witch: { healUsed: false, poisonUsed: false },
    lastProtected: null,
    pendingHunter: null,
    dayVotes: {},
    deaths: [],
    lastNight: null,
    lastDay: null,
    log: [],
    deadline: null,
    over: null,
  };
}

// ------------------------------------------------------------------ helpers --

const isAlive = (g, id) => g.alive[id] === true;
const living = (g) => g.order.filter((id) => isAlive(g, id));
const teamOf = (g, id) => ROLE_INFO[g.roles[id]].team;
const livingWith = (g, role) => living(g).filter((id) => g.roles[id] === role);
const hasRole = (g, role) => Object.values(g.roles).includes(role);

function note(g, text) {
  g.log.push(text);
  if (g.log.length > 40) g.log.shift();
}

function finish(g, winner, reason) {
  g.phase = 'over';
  g.deadline = null;
  g.over = { winner, reason };
}

/**
 * Runs once per phase, never mid-cascade.
 * Village wins when no wolves remain; wolves win at parity (>=, equality is
 * enough — once they reach it they can always carry the day vote).
 */
function checkWin(g) {
  const alive = living(g);
  const wolves = alive.filter((id) => teamOf(g, id) === 'WOLF').length;
  const others = alive.length - wolves;
  if (wolves === 0) {
    finish(g, 'VILLAGE', 'WOLVES_DEAD');
    return true;
  }
  if (others === 0 || (g.parityWin && wolves >= others)) {
    finish(g, 'WOLF', 'PARITY');
    return true;
  }
  return false;
}

/**
 * Apply a set of deaths and cascade the triggers they set off.
 * Returns true if the machine is suspended waiting on a Hunter's shot.
 */
function applyDeaths(g, room, pending) {
  const queue = [];
  for (const death of pending) {
    if (!isAlive(g, death.id)) continue;
    g.alive[death.id] = false;
    g.deaths.push(death);
    queue.push(death);
  }

  while (queue.length) {
    const death = queue.shift();
    // A Hunter needs a decision, so the machine suspends here and resumes
    // from resolveHunter() once they have shot.
    if (g.roles[death.id] === 'HUNTER' && !g.pendingHunter) {
      g.pendingHunter = { shooter: death.id, resume: g.phase };
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- the night --

function beginNight(g, room, now) {
  g.night++;
  g.phase = 'night';
  g.actions = { wolfVotes: {}, doctor: null, seerTarget: null, witchHeal: false, witchPoison: null };
  g.deaths = [];
  g.deadline = null;
  note(g, `Night ${g.night} falls.`);
}

/** Everyone with a night action has submitted (or has none to give). */
function nightComplete(g, room) {
  const wolves = livingWith(g, 'WOLF');
  if (wolves.some((id) => !g.actions.wolfVotes[id])) return false;
  if (livingWith(g, 'DOCTOR').length && g.actions.doctor === null) return false;
  if (livingWith(g, 'SEER').length && g.actions.seerTarget === null) return false;
  // The Witch is shown the victim, so she acts last and only once the wolves
  // have settled. `witchDone` is set explicitly, including when she passes.
  if (livingWith(g, 'WITCH').length && !g.actions.witchDone) return false;
  return true;
}

function resolveNight(g, room) {
  const events = [];

  // Wolves: majority of their votes. A deadlock means no kill, which is the
  // official Miller's Hollow ruling ("too bad for them, no fresh meat").
  const counts = {};
  for (const target of Object.values(g.actions.wolfVotes)) {
    if (target) counts[target] = (counts[target] ?? 0) + 1;
  }
  let victim = null;
  let best = 0;
  let tied = false;
  for (const [id, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      victim = id;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  if (tied || (g.noKillFirstNight && g.night === 1)) victim = null;

  const pending = [];
  const saved = victim && (victim === g.actions.doctor || g.actions.witchHeal);
  if (victim && !saved) pending.push({ id: victim, cause: 'WOLF' });

  // Poison kills through protection: protection is against the wolf attack.
  if (g.actions.witchPoison) pending.push({ id: g.actions.witchPoison, cause: 'POISON' });

  g.lastNight = {
    night: g.night,
    victim,
    saved: Boolean(saved),
    // Whether a save happened is deliberately NOT announced: the table only
    // learns who died, never that someone was protected.
    deaths: pending.map((d) => d.id),
  };

  const suspended = applyDeaths(g, room, pending);
  g.lastProtected = g.actions.doctor;

  if (suspended) {
    g.phase = 'hunter';
    return events;
  }
  return finishNight(g, room, events);
}

function finishNight(g, room, events = []) {
  const names = g.deaths.map((d) => playerName(room, d.id));
  note(g, names.length ? `${names.join(' and ')} died in the night.` : 'Nobody died in the night.');
  events.push({ kind: 'dawn', names });
  if (checkWin(g)) return events;
  g.phase = 'day';
  g.dayVotes = {};
  g.deadline = Date.now() + room.config.discussionSeconds * 1000;
  return events;
}

// ------------------------------------------------------------------ the day --

function resolveDay(g, room) {
  const alive = living(g);
  const counts = {};
  for (const id of alive) {
    const target = g.dayVotes[id];
    if (target) counts[target] = (counts[target] ?? 0) + 1;
  }
  let lynched = null;
  let best = 0;
  let tied = false;
  for (const [id, n] of Object.entries(counts)) {
    if (n > best) {
      best = n;
      lynched = id;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  // Official: a tie eliminates nobody.
  if (tied) lynched = null;

  g.lastDay = { lynched, counts, votes: { ...g.dayVotes } };
  const events = [{ kind: 'lynch', name: lynched ? playerName(room, lynched) : null }];
  note(g, lynched ? `${playerName(room, lynched)} was hanged.` : 'The village could not agree. Nobody was hanged.');

  g.deaths = [];
  if (lynched) {
    const suspended = applyDeaths(g, room, [{ id: lynched, cause: 'LYNCH' }]);
    if (suspended) {
      g.phase = 'hunter';
      return events;
    }
  }
  return finishDay(g, room, events);
}

function finishDay(g, room, events = []) {
  if (checkWin(g)) return events;
  beginNight(g, room, Date.now());
  return events;
}

// ---------------------------------------------------------------- actions ----

export function action(room, playerId, act, now) {
  const g = room.game;
  if (g.phase === 'over') return { error: 'game_over' };

  switch (act.type) {
    case 'ack': {
      if (g.phase !== 'reveal') return { error: 'wrong_phase' };
      g.acked[playerId] = true;
      if (g.order.every((id) => g.acked[id])) beginNight(g, room, now);
      return {};
    }

    case 'wolfKill': {
      if (g.phase !== 'night') return { error: 'wrong_phase' };
      if (g.roles[playerId] !== 'WOLF' || !isAlive(g, playerId)) return { error: 'not_a_wolf' };
      if (act.target !== null && !isAlive(g, act.target)) return { error: 'bad_target' };
      // Wolves do not eat wolves.
      if (act.target && teamOf(g, act.target) === 'WOLF') return { error: 'bad_target' };
      g.actions.wolfVotes[playerId] = act.target;
      return maybeResolveNight(g, room);
    }

    case 'protect': {
      if (g.phase !== 'night') return { error: 'wrong_phase' };
      if (g.roles[playerId] !== 'DOCTOR' || !isAlive(g, playerId)) return { error: 'not_doctor' };
      if (!isAlive(g, act.target)) return { error: 'bad_target' };
      // Card text: not the same player two nights running.
      if (act.target === g.lastProtected) return { error: 'repeat_target' };
      g.actions.doctor = act.target;
      return maybeResolveNight(g, room);
    }

    case 'inspect': {
      if (g.phase !== 'night') return { error: 'wrong_phase' };
      if (g.roles[playerId] !== 'SEER' || !isAlive(g, playerId)) return { error: 'not_seer' };
      if (!isAlive(g, act.target) || act.target === playerId) return { error: 'bad_target' };
      g.actions.seerTarget = act.target;
      // Alignment is static, so the answer is order-independent and can be
      // delivered immediately — even if the target dies later the same night.
      g.seerResults[act.target] = teamOf(g, act.target) === 'WOLF';
      return maybeResolveNight(g, room);
    }

    case 'witch': {
      if (g.phase !== 'night') return { error: 'wrong_phase' };
      if (g.roles[playerId] !== 'WITCH' || !isAlive(g, playerId)) return { error: 'not_witch' };
      if (act.heal) {
        if (g.witch.healUsed) return { error: 'potion_spent' };
        g.actions.witchHeal = true;
        g.witch.healUsed = true;
      }
      if (act.poison) {
        if (g.witch.poisonUsed) return { error: 'potion_spent' };
        if (!isAlive(g, act.poison)) return { error: 'bad_target' };
        g.actions.witchPoison = act.poison;
        g.witch.poisonUsed = true;
      }
      g.actions.witchDone = true;
      return maybeResolveNight(g, room);
    }

    case 'hunterShoot': {
      if (g.phase !== 'hunter') return { error: 'wrong_phase' };
      if (g.pendingHunter?.shooter !== playerId) return { error: 'not_hunter' };
      if (!isAlive(g, act.target) || act.target === playerId) return { error: 'bad_target' };
      const resume = g.pendingHunter.resume;
      g.pendingHunter = null;
      note(g, `${playerName(room, playerId)} took ${playerName(room, act.target)} down with them.`);
      const suspended = applyDeaths(g, room, [{ id: act.target, cause: 'HUNTER' }]);
      const events = [{ kind: 'hunterShot', name: playerName(room, act.target) }];
      if (suspended) return { events };
      return { events: resume === 'day' ? finishDay(g, room, events) : finishNight(g, room, events) };
    }

    case 'dayVote': {
      if (g.phase !== 'day') return { error: 'wrong_phase' };
      if (!isAlive(g, playerId)) return { error: 'you_are_dead' };
      if (act.target !== null && !isAlive(g, act.target)) return { error: 'bad_target' };
      g.dayVotes[playerId] = act.target;
      if (!living(g).every((id) => g.dayVotes[id] !== undefined)) return {};
      return { events: resolveDay(g, room) };
    }

    default:
      return { error: 'unknown_action' };
  }
}

function maybeResolveNight(g, room) {
  if (!nightComplete(g, room)) return {};
  return { events: resolveNight(g, room) };
}

export function onDeadline(room, now) {
  const g = room.game;
  // Discussion running out forces the vote to close on whatever is in.
  if (g.phase === 'day') return { events: resolveDay(g, room) };
  return {};
}

// ------------------------------------------------------------------- view ----

export function viewFor(room, viewerId) {
  const g = room.game;
  const over = g.phase === 'over';
  const myRole = g.roles[viewerId] ?? null;
  const amWolf = myRole === 'WOLF';
  const amAlive = isAlive(g, viewerId);

  // Wolves recognise each other. Nobody else learns anything at setup.
  const packmates = amWolf
    ? g.order.filter((id) => id !== viewerId && g.roles[id] === 'WOLF')
    : [];

  return {
    game: 'nightfall',
    phase: g.phase,
    night: g.night,
    alive: g.alive,
    order: g.order,
    acked: g.acked,
    myRole,
    myRoleInfo: myRole ? ROLE_INFO[myRole] : null,
    myTeam: myRole ? ROLE_INFO[myRole].team : null,
    amAlive,
    packmates,
    // Wolf votes are visible to wolves only, so they can coordinate silently.
    wolfVotes: amWolf ? g.actions.wolfVotes : {},
    // Seer results go only to the seer, and only what they actually checked.
    seerResults: myRole === 'SEER' ? g.seerResults : {},
    myDoctorTarget: myRole === 'DOCTOR' ? g.actions.doctor : null,
    lastProtected: myRole === 'DOCTOR' ? g.lastProtected : null,
    // The witch is shown the wolves' victim — that is her whole mechanic.
    witchVictim: myRole === 'WITCH' && g.phase === 'night' ? pendingVictim(g) : null,
    witch: myRole === 'WITCH' ? g.witch : null,
    witchDone: myRole === 'WITCH' ? Boolean(g.actions.witchDone) : null,
    pendingHunter: g.pendingHunter?.shooter ?? null,
    // Who has voted is public; how they voted stays private until the reveal.
    dayVoted: Object.keys(g.dayVotes),
    myDayVote: g.dayVotes[viewerId] ?? null,
    dayVotes: g.lastDay?.votes ?? {},
    lastNight: g.lastNight,
    lastDay: g.lastDay,
    // The cause of death is deliberately not announced, only who died.
    deadRoles: room.config.revealRoleOnDeath
      ? Object.fromEntries(g.order.filter((id) => !isAlive(g, id)).map((id) => [id, g.roles[id]]))
      : {},
    rolesInPlay: [...new Set(Object.values(g.roles))].sort(),
    deadline: g.deadline,
    totalMs: room.config.discussionSeconds * 1000,
    log: g.log,
    over: g.over,
    reveal: over ? g.roles : null,
  };
}

function pendingVictim(g) {
  const counts = {};
  for (const target of Object.values(g.actions.wolfVotes)) {
    if (target) counts[target] = (counts[target] ?? 0) + 1;
  }
  const wolves = livingWith(g, 'WOLF');
  if (wolves.some((id) => !g.actions.wolfVotes[id])) return null;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null;
  return entries[0][0];
}

export const rulesText = [
  {
    h: 'No moderator',
    p: 'Nobody closes their eyes and nobody sits out. At night your phone tells you privately what you can do; if you have no night action, you just wait.',
  },
  {
    h: 'Night',
    p: 'The werewolves agree on someone to kill. The Seer learns whether one player is a wolf. The Doctor protects someone — never the same person two nights running. The Witch is shown the victim and may save them or poison somebody, once each per game.',
  },
  {
    h: 'Day',
    p: 'The deaths are announced. The village argues, then everyone votes. Most votes hangs; a tie hangs nobody.',
  },
  {
    h: 'The Hunter',
    p: 'If the Hunter dies — night or day, by any cause — they immediately take another player with them. That can chain.',
  },
  {
    h: 'Winning',
    p: 'The village wins when every werewolf is dead. The wolves win as soon as they equal the number of everyone else, because from there they can always carry the vote.',
  },
  {
    h: 'The dead',
    p: 'Dead players stay in the room but must not speak or signal. You will see everything, which is its own kind of fun.',
  },
];
