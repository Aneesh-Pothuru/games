/**
 * SPECTRUM — one player sees a hidden target on a sliding scale and has to
 * describe it in a single clue.
 *
 * Mechanically Wavelength, implemented from the official rules. Original name
 * and original concept-pair deck.
 *
 * Scoring, verified: 4 / 3 / 2 by proximity band; the opposing team scores 1
 * for a correct left/right call UNLESS the psychic's team hit the bullseye;
 * the team going second starts on 1; first to 10 wins; a team that scores 4
 * while still behind immediately takes another turn.
 */

import { makeRng, randInt } from '../shared/rng.js';
import { SPECTRUMS } from '../content/spectrums.js';
import { clampInt, drawUnseen, oneOf, playerName } from './engine.js';

export const meta = {
  id: 'spectrum',
  name: 'Spectrum',
  tagline: 'One clue. Where on the dial did they mean?',
  blurb:
    'The psychic sees a hidden target between two opposed ideas and gives a single clue. Their team argues and moves the dial. Everyone finds out how differently other people’s brains are wired.',
  minPlayers: 2,
  maxPlayers: 16,
  emblem: 'g-spectrum',
  lengthMinutes: '15–20 min',
};

/**
 * Target geometry.
 *
 * The five wedges are EQUAL width — a common misreading is that the bands get
 * progressively wider, but the 2- and 3-point scores only cover more total arc
 * because each appears twice, once per side. The rulebook never states the
 * angle in words; measurement of the official artwork puts each wedge at
 * ~7.45°, which we round to a clean 7.5° (1/24 of the 180° spectrum), i.e.
 * 4.1667 units on a 0–100 scale.
 *
 * These are cumulative distances from the target centre, so the 4-band is
 * half a wedge wide and each subsequent band adds a full wedge.
 */
const WEDGE = 100 / 24; // 4.1667 units == 7.5 degrees
const BANDS = {
  bullseye: WEDGE / 2, // 2.0833
  inner: WEDGE * 1.5, //  6.25
  outer: WEDGE * 2.5, // 10.4167
};
// Keep the whole target on the board so every band is always reachable.
const TARGET_MIN = BANDS.outer;
const TARGET_MAX = 100 - BANDS.outer;
const WIN_SCORE = 10;

export const defaultConfig = { mode: 'auto', clueSeconds: 90, guessSeconds: 120 };

export function normalizeConfig(config) {
  return {
    mode: oneOf(config.mode, ['auto', 'teams', 'coop'], 'auto'),
    clueSeconds: clampInt(config.clueSeconds, 30, 240, 90),
    guessSeconds: clampInt(config.guessSeconds, 30, 300, 120),
  };
}

function resolveMode(room) {
  if (room.config.mode !== 'auto') return room.config.mode;
  // Co-op is genuinely the better game below six, and it dodges an awkward 2v2.
  return room.players.length >= 6 ? 'teams' : 'coop';
}

/**
 * Official rule: a dial landing exactly on a boundary scores the HIGHER of the
 * two values. The band edges are thirds and twenty-fourths, so an exact hit is
 * never exactly representable in binary floating point — without the epsilon,
 * a dial genuinely on the line loses a point about half the time.
 */
const EPSILON = 1e-9;

export function scoreFor(target, guess) {
  const d = Math.abs(target - guess);
  if (d <= BANDS.bullseye + EPSILON) return 4;
  if (d <= BANDS.inner + EPSILON) return 3;
  if (d <= BANDS.outer + EPSILON) return 2;
  return 0;
}

export function start(room, seed, now) {
  const rng = makeRng(seed);
  const mode = resolveMode(room);
  const ids = room.players.map((p) => p.id);

  let teams = null;
  if (mode === 'teams') {
    // Alternate by seat so the split is stable and obvious to the table.
    teams = { A: [], B: [] };
    ids.forEach((id, i) => teams[i % 2 === 0 ? 'A' : 'B'].push(id));
  }

  const g = {
    seed,
    mode,
    teams,
    // The team going second starts on 1, per the official rules.
    scores: mode === 'teams' ? { A: 0, B: 1 } : { coop: 0 },
    activeTeam: 'A',
    psychicIndex: { A: 0, B: 0, coop: 0 },
    round: 0,
    cardsLeft: mode === 'coop' ? 7 : null,
    seen: [],
    phase: 'clue',
    pair: null,
    target: null,
    psychic: null,
    clue: '',
    dial: 50,
    dialBy: null,
    locks: {},
    bets: {},
    lastResult: null,
    deadline: null,
    over: null,
  };
  beginRound(g, room, rng, now);
  return g;
}

function teamMembers(g, room, team) {
  if (g.mode === 'coop') return room.players.map((p) => p.id);
  return (g.teams[team] ?? []).filter((id) => room.players.some((p) => p.id === id));
}

function beginRound(g, room, rng, now) {
  const { picked } = drawUnseen(SPECTRUMS, g.seen, rng);
  g.seen = [...g.seen, picked.id].slice(-60);
  g.pair = picked;
  // Uniform, with margins so the full band always fits on the board.
  g.target = TARGET_MIN + rng() * (TARGET_MAX - TARGET_MIN);
  const roster = teamMembers(g, room, g.activeTeam);
  const key = g.mode === 'coop' ? 'coop' : g.activeTeam;
  g.psychic = roster.length ? roster[g.psychicIndex[key] % roster.length] : null;
  g.psychicIndex[key] = (g.psychicIndex[key] + 1) % Math.max(1, roster.length);
  g.round++;
  g.phase = 'clue';
  g.clue = '';
  g.dial = 50;
  g.dialBy = null;
  g.locks = {};
  g.bets = {};
  g.deadline = now ? now + room.config.clueSeconds * 1000 : null;
}

export function action(room, playerId, act, now) {
  const g = room.game;
  if (g.phase === 'over') return { error: 'game_over' };

  switch (act.type) {
    case 'clue': {
      if (g.phase !== 'clue') return { error: 'wrong_phase' };
      if (playerId !== g.psychic) return { error: 'not_psychic' };
      const clue = String(act.clue ?? '').trim().slice(0, 60);
      if (!clue) return { error: 'clue_required' };
      g.clue = clue;
      g.phase = 'guess';
      g.deadline = now + room.config.guessSeconds * 1000;
      return { events: [{ kind: 'clue', clue }] };
    }

    case 'dial': {
      if (g.phase !== 'guess') return { error: 'wrong_phase' };
      // Rejected at the server, not merely greyed out on the psychic's client.
      if (playerId === g.psychic) return { error: 'psychic_cannot_guess' };
      if (!teamMembers(g, room, g.activeTeam).includes(playerId)) return { error: 'not_your_turn' };
      const value = Number(act.value);
      if (!Number.isFinite(value)) return { error: 'bad_value' };
      g.dial = Math.min(100, Math.max(0, Math.round(value * 10) / 10));
      g.dialBy = playerId;
      g.locks = {};
      return {};
    }

    case 'lock': {
      if (g.phase !== 'guess') return { error: 'wrong_phase' };
      if (playerId === g.psychic) return { error: 'psychic_cannot_guess' };
      const roster = teamMembers(g, room, g.activeTeam).filter((id) => id !== g.psychic);
      if (!roster.includes(playerId)) return { error: 'not_your_turn' };
      g.locks[playerId] = true;
      // A majority locks it in, so nobody can slam-lock the group's guess.
      const locked = roster.filter((id) => g.locks[id]).length;
      if (locked * 2 <= roster.length) return {};
      return closeGuess(g, room, now);
    }

    case 'bet': {
      if (g.phase !== 'bet') return { error: 'wrong_phase' };
      const other = g.activeTeam === 'A' ? 'B' : 'A';
      if (!teamMembers(g, room, other).includes(playerId)) return { error: 'not_your_bet' };
      if (act.value !== 'LEFT' && act.value !== 'RIGHT') return { error: 'bad_bet' };
      g.bets[playerId] = act.value;
      const roster = teamMembers(g, room, other);
      if (!roster.every((id) => g.bets[id])) return {};
      return reveal(g, room, now);
    }

    case 'next': {
      if (g.phase !== 'reveal') return { error: 'wrong_phase' };
      if (room.hostId !== playerId) return { error: 'host_only' };
      return advance(g, room, now);
    }

    default:
      return { error: 'unknown_action' };
  }
}

function closeGuess(g, room, now) {
  if (g.mode === 'coop') return reveal(g, room, now);
  g.phase = 'bet';
  g.deadline = now + 30_000;
  return {};
}

function reveal(g, room, now) {
  const points = scoreFor(g.target, g.dial);
  const key = g.mode === 'coop' ? 'coop' : g.activeTeam;
  g.scores[key] += points;

  let betPoints = 0;
  let betChoice = null;
  if (g.mode === 'teams') {
    const other = g.activeTeam === 'A' ? 'B' : 'A';
    const roster = teamMembers(g, room, other);
    const left = roster.filter((id) => g.bets[id] === 'LEFT').length;
    const right = roster.filter((id) => g.bets[id] === 'RIGHT').length;
    betChoice = left === right ? null : left > right ? 'LEFT' : 'RIGHT';
    const actual = g.target < g.dial ? 'LEFT' : 'RIGHT';
    // No bonus if the psychic's team hit the bullseye.
    if (betChoice && betChoice === actual && points !== 4) {
      betPoints = 1;
      g.scores[other] += 1;
    }
  }

  g.lastResult = {
    target: g.target,
    dial: g.dial,
    points,
    betChoice,
    betPoints,
    clue: g.clue,
    pair: g.pair,
    psychic: g.psychic,
    team: key,
  };
  g.phase = 'reveal';
  g.deadline = null;
  if (g.mode === 'coop' && points === 4) g.cardsLeft += 1;
  return { events: [{ kind: 'spectrumResult', points }] };
}

function advance(g, room, now) {
  const rng = makeRng((g.seed + g.round * 2654435761) >>> 0);

  if (g.mode === 'coop') {
    g.cardsLeft--;
    if (g.cardsLeft <= 0) {
      g.phase = 'over';
      g.over = { winner: 'coop', score: g.scores.coop };
      return {};
    }
    beginRound(g, room, rng, now);
    return {};
  }

  if (g.scores.A >= WIN_SCORE || g.scores.B >= WIN_SCORE) {
    if (g.scores.A !== g.scores.B) {
      g.phase = 'over';
      g.over = { winner: g.scores.A > g.scores.B ? 'A' : 'B', scores: g.scores };
      return {};
    }
    // Tie at the target: sudden death until someone is ahead.
  }

  // Catch-up: score 4 while still behind and you go again immediately.
  const scored = g.lastResult?.points === 4;
  const key = g.activeTeam;
  const other = key === 'A' ? 'B' : 'A';
  const stillBehind = g.scores[key] < g.scores[other];
  if (!(scored && stillBehind)) g.activeTeam = other;

  beginRound(g, room, rng, now);
  return {};
}

export function onDeadline(room, now) {
  const g = room.game;
  if (g.phase === 'clue') {
    g.clue = '(no clue given)';
    g.phase = 'guess';
    g.deadline = now + room.config.guessSeconds * 1000;
    return { events: [{ kind: 'clueTimeout' }] };
  }
  if (g.phase === 'guess') return closeGuess(g, room, now);
  if (g.phase === 'bet') return reveal(g, room, now);
  return {};
}

export function viewFor(room, viewerId) {
  const g = room.game;
  const amPsychic = viewerId === g.psychic;
  const revealed = g.phase === 'reveal' || g.phase === 'over';
  const myTeam =
    g.mode === 'coop' ? 'coop' : g.teams.A.includes(viewerId) ? 'A' : g.teams.B.includes(viewerId) ? 'B' : null;

  return {
    game: 'spectrum',
    phase: g.phase,
    mode: g.mode,
    round: g.round,
    cardsLeft: g.cardsLeft,
    teams: g.teams,
    myTeam,
    scores: g.scores,
    activeTeam: g.activeTeam,
    psychic: g.psychic,
    amPsychic,
    pair: g.pair,
    clue: g.clue,
    dial: g.dial,
    dialBy: g.dialBy,
    locks: Object.keys(g.locks),
    betCount: Object.keys(g.bets).length,
    myBet: g.bets[viewerId] ?? null,
    // The target goes only to the psychic, and only while it is still hidden.
    // Every other client renders the band component with target=null rather
    // than receiving it and hiding it.
    target: amPsychic || revealed ? g.target : null,
    bands: BANDS,
    deadline: g.deadline,
    lastResult: revealed ? g.lastResult : null,
    over: g.over,
    winScore: WIN_SCORE,
  };
}

export const rulesText = [
  {
    h: 'The dial',
    p: 'A spectrum runs between two opposed ideas — “Underrated” to “Overrated”, say. Somewhere on it is a hidden target, and only the psychic can see it.',
  },
  {
    h: 'The clue',
    p: 'The psychic gives one word or short phrase that sits at exactly that spot. Then they say nothing at all — no reacting, no wincing.',
  },
  {
    h: 'The guess',
    p: 'Their team argues out loud and moves the dial together. Anyone can drag it; it locks when most of the team agrees.',
  },
  {
    h: 'The bet',
    p: 'The other team then calls whether the real target is left or right of where the dial stopped. They score 1 if they are right — unless the psychic’s team hit the bullseye, in which case they get nothing.',
  },
  {
    h: 'Scoring',
    p: 'Bullseye 4, near 3, close 2, miss 0. First to 10 wins. Score a 4 while you are still behind and you immediately go again.',
  },
  {
    h: 'Small groups',
    p: 'With fewer than six players it switches to co-op: one team, seven spectrums, no betting. Hit the bullseye and you earn an extra spectrum.',
  },
];
