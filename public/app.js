/**
 * Parlour client.
 *
 * The server owns all truth. This file renders whatever projection arrives and
 * sends intents back. Two rules it never breaks:
 *   - it never derives hidden state; if the server didn't send it, it isn't known
 *   - every screen says what is happening and who we are waiting for, by name
 */

import { api, clearSeat, Connection, loadSeat, recalledName, rememberName, saveSeat } from './net.js';
import {
  announce, assignAvatars, avatarSvg, buzz, celebrate, clear, el, escapeAttr, formatClock,
  icon, keepAwake, prefs, savePrefs, toast, tone, trackKeyboard, unlockAudio,
} from './ui.js';
import { GAME_UI } from './games.js';

const root = document.getElementById('app');
const sheet = document.getElementById('sheet');

const state = {
  screen: 'home',
  code: null,
  pid: null,
  conn: null,
  room: null,
  view: null,
  status: 'offline',
  offlineSince: 0,
  games: [],
  picked: null,
  avatars: {},
  selection: null,
  error: null,
  busy: false,
  revealed: false,
  clockOffset: 0,
  // Form fields live in state, not only in the DOM: a re-render rebuilds the
  // inputs, and anything typed but unsaved would otherwise be silently lost.
  name: recalledName(),
  codeEntry: '',
  // What /api/room told us about a room we have not joined yet.
  peek: null,
};

// --------------------------------------------------------------------- boot --

trackKeyboard();
document.getElementById('sheet-close').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.close();
});

async function boot() {
  try {
    const res = await fetch('/api/games');
    state.games = res.ok ? await res.json() : [];
  } catch {
    state.games = [];
  }
  const path = location.pathname.replace(/^\/+|\/+$/g, '').toUpperCase();
  if (/^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(path)) {
    state.code = path;
    const seat = loadSeat(path);
    if (seat) return join(path, seat);
    state.screen = 'join';
    loadPeek(path);
  }
  render();
}

/** Reconnect to a seat we already hold. */
async function join(code, seat) {
  state.code = code;
  state.pid = seat.pid;
  state.screen = 'game';
  connect(code, seat);
  render();
}

function connect(code, seat) {
  state.conn?.close();
  state.conn = new Connection({
    code,
    pid: seat.pid,
    tok: seat.tok,
    onState: (msg) => {
      state.room = msg.room;
      state.view = msg.view;
      state.pid = msg.you;
      state.avatars = assignAvatars(msg.room.players.map((p) => p.id));
      state.error = null;
      render();
    },
    onEvent: (msg) => {
      if (msg.t === 'reject') {
        state.error = humanError(msg.why);
        buzz('reject');
        toast(state.error);
        render();
        return;
      }
      handleEvent(msg);
    },
    onStatus: (status) => {
      if (status === 'offline' && state.status !== 'offline') state.offlineSince = Date.now();
      state.status = status;
      render();
    },
    onFatal: () => {
      clearSeat(code);
      state.screen = 'gone';
      render();
    },
  });
  state.conn.connect();
  keepAwake(true);
}

function handleEvent(msg) {
  const label = {
    joined: (m) => `${m.name} joined`,
    left: (m) => `${m.name} left`,
    kicked: (m) => `${m.name} was removed`,
    newHost: (m) => `${m.name} is now the host`,
    gameStarted: () => 'Game on',
    accusation: (m) => `${m.accuser} accuses ${m.accused}`,
    accusationFailed: () => 'Not unanimous — clock restarts',
    spyReveal: (m) => `${m.name} revealed as the spy`,
    timeUp: () => 'Time! Voting one at a time',
    chaos: () => 'Deadlock — the council acts alone',
    vetoProposed: () => 'The Deputy proposes a veto',
    vetoRefused: () => 'The Speaker refuses the veto',
    vetoAgreed: () => 'The agenda was vetoed',
    purged: (m) => `${m.name} was purged`,
    session: (m) => `${m.name} chairs an emergency session`,
    audited: (m) => `${m.name} was audited`,
    nominated: (m) => `${m.name} was nominated`,
    proposed: (m) => 'A team was proposed',
    assassinated: (m) => `The Handler names ${m.name}`,
    claim: (m) => `${m.name}: ${m.count} × ${m.rank}`,
    called: (m) => (m.lying
      ? `${m.caller} calls it — ${m.accused} was lying`
      : `${m.caller} calls it — and ${m.accused} was telling the truth`),
    cheatWin: (m) => `${m.name} is out of cards`,
  }[msg.kind];
  if (label) toast(label(msg));
}

const ERRORS = {
  host_only: 'Only the host can do that',
  need_more_players: 'Not enough players yet',
  too_many_players: 'Too many players for this game',
  ineligible_deputy: 'That player is term-limited',
  crew_must_succeed: 'Crew must play success',
  wrong_team_size: 'Wrong number of players on the team',
  already_accused: 'You have used your accusation this round',
  too_late: 'Someone already stopped the clock',
  psychic_cannot_guess: 'The psychic sits this one out',
  veto_locked: 'Veto is not unlocked yet',
  veto_refused: 'The Speaker already refused',
  room_full: 'That room is full',
  in_progress: 'That game has already started',
  waiting_for_next_round: 'You are in for the next round',
  host_is_here: 'The host is still connected',
  not_found: 'No room with that code',
  name_required: 'Enter a name first',
  bad_code: 'That code does not look right',
};
const humanError = (why) => ERRORS[why] ?? 'That move is not allowed right now';

// ------------------------------------------------------------------- render --

function render() {
  const scroll = root.querySelector('.flow')?.scrollTop ?? 0;

  // Every render rebuilds the whole tree, and renders happen on someone else's
  // schedule — a broadcast, a reconnect, a timer tick. If that lands while you
  // are typing, the field you are in is replaced by a new node and you lose
  // focus and caret mid-word. Carry both across.
  const was = document.activeElement;
  const focus = was && was.id && root.contains(was)
    ? { id: was.id, start: caretOf(was, 'selectionStart'), end: caretOf(was, 'selectionEnd') }
    : null;

  clear(root);
  const screen =
    state.screen === 'home' ? homeScreen()
    : state.screen === 'join' ? joinScreen()
    : state.screen === 'gone' ? goneScreen()
    : gameScreen();
  root.append(screen);

  const flow = root.querySelector('.flow');
  if (flow) flow.scrollTop = scroll;
  document.documentElement.dataset.game = state.room?.gameId ?? '';

  if (focus) {
    const next = document.getElementById(focus.id);
    // preventScroll, or restoring focus yanks the scroll position we just put
    // back. Only refocus if the field still exists on the new screen.
    if (next && next !== document.activeElement) {
      next.focus({ preventScroll: true });
      if (focus.start !== null) {
        try {
          next.setSelectionRange(focus.start, focus.end);
        } catch {
          /* selection is not supported on every input type */
        }
      }
    }
  }
}

/** selectionStart throws on email/number inputs, so it is never read directly. */
function caretOf(node, prop) {
  try {
    return node[prop] ?? null;
  } catch {
    return null;
  }
}

function shell({ top, body, bottom, variant = '' }) {
  return el('div', { class: `screen ${variant}` }, [
    top ?? el('div'),
    el('main', { class: 'flow' }, [el('div', { class: `shell stack ${variant}` }, body)]),
    bottom ?? el('div'),
  ]);
}

// --------------------------------------------------------------------- home --

function homeScreen() {
  // The code box only accepts the room alphabet, which silently eats anything
  // else. Someone typing "spyfall" here watched it become "SPYF" and then got
  // told the room didn't exist -- so match game names too and offer a rescue.
  const rescue = matchGameByName(state.codeEntry);

  const codeInput = el('input', {
    class: 'input input--code', id: 'code', maxlength: '16', inputmode: 'text',
    enterkeyhint: 'go', autocomplete: 'off', autocapitalize: 'characters',
    autocorrect: 'off', spellcheck: 'false', placeholder: 'ROOM CODE',
    'aria-label': 'Room code', value: state.codeEntry,
    // Read the field, never write to it.
    //
    // This used to assign `e.target.value` on every keystroke to force upper
    // case. Phone keyboards do not type character by character — they COMPOSE,
    // firing an input event per predicted prefix, and writing to .value ends
    // the composition and re-inserts what is already there. Typing "poker" on
    // a real phone produced "PPOPOKPOKEPOKERP". The uppercasing was never
    // needed anyway: `.input--code` already renders uppercase in CSS, and
    // doJoin() normalises before it goes anywhere.
    oninput: (e) => {
      state.codeEntry = e.target.value.toUpperCase().slice(0, 16);
      renderRescue();
    },
    onkeydown: (e) => { if (e.key === 'Enter') doJoin(state.codeEntry, state.name); },
  });

  const tiles = state.games.map((g) => gameTile(g));

  return shell({
    top: el('header', { class: 'bar bar--top' }, [
      el('span', { class: 'label', text: 'Parlour' }),
      themeToggle(),
    ]),
    body: [
      el('h1', { class: 't-lg', text: 'Party games for a room full of phones' }),

      // Answers "where is Secret Hitler?" without scrolling, and makes the
      // browser's find-in-page work. Kept to two lines so the games clear the
      // fold on a 375x667 phone.
      el('p', { class: 'banner banner--accent t-xs', text:
        'Spyfall · Wavelength · Cheat · Werewolf · Poker · Secret Hitler · Avalon — all seven are below.' }),

      // Joining is one compact row, not a titled section: most joiners arrive
      // on a link and never see this screen at all.
      el('div', { class: 'joinrow' }, [
        codeInput,
        el('button', { class: 'btn btn--secondary', onclick: () => doJoin(state.codeEntry, state.name) }, ['Join']),
      ]),
      el('div', { id: 'rescue' }, rescue ? [rescueCard(rescue)] : []),

      el('div', { class: 'label', text: 'Pick a game' }),
      el('div', { class: 'gamegrid', role: 'radiogroup', 'aria-label': 'Pick a game' }, tiles),

      attributionFooter(),
    ],
    // No bar until a game is chosen: a permanently disabled button would steal
    // ~84px from the screen that most needs the room.
    bottom: state.picked ? startBar() : null,
    variant: 'home',
  });
}

/** Re-render only the rescue slot so typing does not rebuild the whole page. */
function renderRescue() {
  const slot = document.getElementById('rescue');
  if (!slot) return;
  const match = matchGameByName(state.codeEntry);
  clear(slot);
  if (match) slot.append(rescueCard(match));
}

const ALIASES = {
  spyfall: 'oddoneout', spy: 'oddoneout',
  werewolf: 'nightfall', mafia: 'nightfall', wolf: 'nightfall',
  'secret hitler': 'council', secrethitler: 'council', hitler: 'council',
  avalon: 'sabotage', resistance: 'sabotage',
  wavelength: 'spectrum',
  poker: 'holdem', holdem: 'holdem', 'texas holdem': 'holdem', cards: 'holdem',
  bs: 'cheat', bullshit: 'cheat', 'i doubt it': 'cheat', liar: 'cheat',
};

/** Does what they typed look like a game rather than a room code? */
function matchGameByName(raw) {
  const q = String(raw ?? '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (q.length < 3) return null;
  const byAlias = ALIASES[q] ?? Object.entries(ALIASES).find(([k]) => k.startsWith(q) || q.startsWith(k))?.[1];
  const direct = state.games.find(
    (g) => g.name.toLowerCase().includes(q) || (g.familiar ?? '').toLowerCase().includes(q),
  );
  return state.games.find((g) => g.id === byAlias) ?? direct ?? null;
}

function rescueCard(game) {
  return el('div', { class: 'card stack stack--tight' }, [
    el('b', { text: `Looking for ${game.familiar ?? game.name}?` }),
    el('span', { class: 'dim t-sm', text: `That is ${game.name} here. ${game.minPlayers}–${game.maxPlayers} players, ${game.lengthMinutes}.` }),
    el('button', {
      class: 'btn btn--primary btn--block',
      onclick: () => {
        state.picked = game.id;
        state.codeEntry = '';
        render();
      },
    }, [`Pick ${game.name}`]),
  ]);
}

function gameTile(g) {
  const selected = state.picked === g.id;
  return el('button', {
    class: `gametile ${selected ? 'is-selected' : ''}`,
    dataset: { game: g.id },
    role: 'radio',
    'aria-checked': String(selected),
    onclick: () => {
      state.picked = selected ? null : g.id;
      render();
      if (!selected) document.getElementById('startbar-name')?.focus({ preventScroll: true });
    },
  }, [
    icon(g.emblem, 'gametile__emblem'),
    el('span', { class: 'grow' }, [
      el('span', { class: 'gametile__name', text: g.name }),
      // The name people came looking for.
      g.familiar && el('span', { class: 'gametile__familiar', text: `Plays like ${g.familiar}` }),
      el('span', { class: 'gametile__meta', text: `${g.minPlayers}–${g.maxPlayers} players · ${g.lengthMinutes}` }),
      el('span', { class: 'dim t-sm', style: 'display:block;margin-top:4px', text: g.plain ?? g.tagline }),
    ]),
  ]);
}

/** Name and start together, so the field is never off-screen from the button. */
function startBar() {
  const game = state.games.find((g) => g.id === state.picked);
  return el('footer', { class: 'bar bar--bottom' }, [
    el('input', {
      class: 'input', id: 'startbar-name', maxlength: '14', autocomplete: 'nickname',
      enterkeyhint: 'go', placeholder: 'Your name', 'aria-label': 'Your name',
      value: state.name,
      oninput: (e) => { state.name = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') doCreate(state.name); },
    }),
    el('button', {
      class: 'btn btn--primary btn--block',
      disabled: state.busy,
      onclick: () => doCreate(state.name),
    }, [state.busy ? 'Starting…' : `Start ${game.name}`]),
    // The rules were previously reachable only from inside a running game, so
    // the host had to commit five friends to a room before they could read
    // what they had picked.
    el('button', {
      class: 'btn btn--ghost btn--block',
      onclick: () => openRules(game.id),
    }, [`How to play ${game.name}`]),
  ]);
}

function attributionFooter() {
  return el('details', { class: 'card', style: 'margin-top:var(--sp-5)' }, [
    el('summary', { class: 'label', text: 'About these games' }),
    el('div', { class: 'stack stack--tight', style: 'margin-top:var(--sp-3)' }, [
      el('p', { class: 'dim t-sm', text:
        'Parlour is not affiliated with, endorsed by, or licensed by the publishers of the games named here. These are our own implementations, in the spirit of games we love.' }),
      ...state.games.filter((g) => g.familiar).map((g) =>
        el('p', { class: 'dim t-sm', text: `${g.name} — in the spirit of ${g.familiar}.` })),
      el('p', { class: 'dim t-sm', text:
        'Every location, spectrum pair and word list here was written for this site.' }),
    ]),
  ]);
}

function joinScreen() {
  const nameInput = el('input', {
    class: 'input', id: 'name', maxlength: '14', autofocus: true,
    placeholder: 'Your name', value: state.name,
    oninput: (e) => { state.name = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') doJoin(state.code, state.name); },
  });
  // A code out of context tells you nothing. The peek is one cheap read that
  // turns "Joining room VDMH" into "Ana's game of Texas Hold'em, 4 already in"
  // — which is also how you find out you have the wrong room before you type
  // your name into it.
  const peek = state.peek;
  const inProgress = peek?.inProgress;
  // Finding out a room is full AFTER typing your name and tapping Join is a
  // waste of the only two things a guest has to give.
  const full = peek && peek.playerCount + (peek.waitingCount ?? 0) >= peek.maxPlayers;
  return shell({
    top: el('header', { class: 'bar bar--top' }, [el('span', { class: 'label', text: 'Parlour' }), themeToggle()]),
    body: [
      el('h1', { class: 't-xl', text: peek ? peek.gameName : `Joining room ${state.code}` }),
      peek && el('p', { class: 'dim', text:
        `${peek.hostName ? `${peek.hostName}’s room` : `Room ${state.code}`} · ${peek.playerCount} ${peek.playerCount === 1 ? 'player' : 'players'} in` }),
      full && el('div', { class: 'banner banner--danger', text:
        `This room is full — ${peek.gameName} seats ${peek.maxPlayers}.` }),
      !full && inProgress && el('div', { class: 'banner banner--accent', text:
        'A round is already running. Join now and you are dealt in as soon as it finishes.' }),
      !full && el('div', { class: 'field' }, [el('label', { class: 'label', for: 'name', text: 'Your name' }), nameInput]),
    ].filter(Boolean),
    bottom: el('footer', { class: 'bar bar--bottom' }, full
      ? [el('button', {
          class: 'btn btn--primary btn--block',
          onclick: () => {
            history.pushState({}, '', '/');
            state.screen = 'home';
            state.code = null;
            state.peek = null;
            render();
          },
        }, ['Start a room of your own'])]
      : [el('button', {
          class: 'btn btn--primary btn--block',
          disabled: state.busy,
          onclick: () => doJoin(state.code, state.name),
        }, [inProgress ? 'Hold me a seat' : 'Go — join game'])]),
  });
}

/** Fire-and-forget: the join screen renders fine without it. */
async function loadPeek(code) {
  state.peek = null;
  try {
    const res = await fetch(`/api/room?code=${encodeURIComponent(code)}`);
    if (!res.ok) return;
    const info = await res.json();
    if (state.screen === 'join' && state.code === code) {
      state.peek = info;
      render();
    }
  } catch {
    /* the screen already works without it */
  }
}

function goneScreen() {
  return shell({
    body: [
      el('h1', { class: 't-xl', text: 'That room has closed' }),
      el('p', { class: 'dim', text: 'Rooms expire after a while of being empty.' }),
      el('button', {
        class: 'btn btn--primary btn--block',
        onclick: () => {
          history.pushState({}, '', '/');
          state.screen = 'home';
          state.code = null;
          render();
        },
      }, ['Back to the start']),
    ],
  });
}

async function doCreate(name) {
  if (!name.trim()) {
    // A toast is fixed near the top and is announced to screen readers. The old
    // inline banner rendered below five game tiles, so tapping Start with an
    // empty name looked like the button simply did nothing.
    toast('Add your name first — the box just above this button.');
    document.getElementById('startbar-name')?.focus();
    return;
  }
  state.busy = true;
  unlockAudio();
  render();
  try {
    rememberName(name.trim());
    const res = await api('/api/create', { game: state.picked, name });
    saveSeat(res.code, { pid: res.pid, tok: res.tok });
    history.pushState({}, '', `/${res.code}`);
    await join(res.code, res);
  } catch (err) {
    toast(humanError(err.code));
  } finally {
    state.busy = false;
    render();
  }
}

async function doJoin(code, name) {
  const clean = String(code ?? '').toUpperCase().replace(/[^BCDFGHJKMNPQRSTVWXYZ]/g, '');
  if (clean.length !== 4) {
    const match = matchGameByName(code);
    toast(match
      ? `That is a game, not a room code. ${match.name} is in the list below.`
      : 'Room codes are 4 letters, no vowels.');
    return;
  }
  if (!name.trim()) {
    state.name = '';
    state.screen = 'join';
    state.code = clean;
    loadPeek(clean);
    render();
    toast('Add your name to join.');
    return;
  }
  state.busy = true;
  unlockAudio();
  render();
  try {
    rememberName(name.trim());
    const res = await api('/api/join', { code: clean, name });
    saveSeat(clean, { pid: res.pid, tok: res.tok });
    history.pushState({}, '', `/${clean}`);
    await join(clean, res);
  } catch (err) {
    toast(humanError(err.code));
    // The room filled up while they were typing. Re-peek so the screen shows
    // the wall and the way around it, rather than a toast that fades back to a
    // form that will keep failing.
    if (err.code === 'room_full') {
      state.screen = 'join';
      state.code = clean;
      loadPeek(clean);
    }
  } finally {
    state.busy = false;
    render();
  }
}

// --------------------------------------------------------------------- game --

function gameScreen() {
  const room = state.room;
  if (!room) {
    return shell({
      body: [el('div', { class: 'banner', text: 'Connecting to the room…' })],
    });
  }
  const ui = GAME_UI[room.gameId];
  const inLobby = room.phase === 'lobby';
  const ctx = {
    room, view: state.view, me: state.pid, isHost: room.hostId === state.pid,
    send: (action) => state.conn?.action(action),
    // Lobby-level intents (as opposed to in-game actions).
    again: () => state.conn?.send({ t: 'playAgain' }),
    playerTile, playerList, nameOf, avatarFor, select, selected: () => state.selection,
    revealed: state.revealed, setRevealed: (v) => { state.revealed = v; render(); },
    // For UI that swaps panes without a server round-trip, e.g. opening the
    // bet sizer. Anything that changes game state must go through send().
    rerender: render,
  };

  // Arrived mid-round: holding a seat for the next one, and deliberately sent
  // no game view at all, so there is nothing here that could leak.
  const waiting = !inLobby && !room.players.some((p) => p.id === state.pid);
  const body = waiting ? waitingBody(ctx) : inLobby ? lobbyBody(ctx) : ui.body(ctx);
  const bottom = waiting ? waitingBottom(ctx) : inLobby ? lobbyBottom(ctx) : ui.bottom(ctx);

  return shell({
    top: gameTop(ctx, waiting ? {} : ui),
    body: [connectionBanner(), ...body],
    bottom,
  });
}

function waitingBody(ctx) {
  const { room } = ctx;
  const game = state.games.find((g) => g.id === room.gameId);
  const queue = room.waiting ?? [];
  const mine = queue.findIndex((p) => p.id === state.pid);
  return [
    el('div', { class: 'banner banner--accent', text: `A round of ${game?.name ?? 'the game'} is already going.` }),
    el('div', { class: 'card center stack stack--tight' }, [
      el('div', { class: 'label', text: 'You are in' }),
      el('b', { class: 'secret__value', text: mine === 0 ? 'Next round' : `Next round · ${mine + 1} in the queue` }),
      el('p', { class: 'dim t-sm', text: 'Your seat is held. You will be dealt in automatically when this round finishes — nothing to do but wait.' }),
    ]),
    el('div', { class: 'label', text: 'Playing right now' }),
    playerList(ctx, { showHost: true }),
    queue.length > 1 && el('div', { class: 'label', text: 'Also waiting' }),
    queue.length > 1 && el('ul', { class: 'plist' }, queue.filter((p) => p.id !== state.pid).map((p) =>
      playerTile(ctx, { ...p, online: p.online }, {}))),
  ].filter(Boolean);
}

function waitingBottom(ctx) {
  return el('footer', { class: 'bar bar--bottom' }, [
    el('button', {
      class: 'btn btn--primary btn--block',
      onclick: () => openRules(ctx.room.gameId),
    }, ['Read the rules while you wait']),
    el('button', {
      class: 'btn btn--ghost btn--block',
      onclick: () => leaveRoom(),
    }, ['Leave']),
  ]);
}

/** Give up the seat, drop the token, and go home — no orphaned reconnects. */
function leaveRoom() {
  state.conn?.send({ t: 'leave' });
  if (state.room?.code) clearSeat(state.room.code);
  state.conn?.close?.();
  state.room = null;
  state.view = null;
  state.code = null;
  state.screen = 'home';
  history.pushState({}, '', '/');
  render();
}

function gameTop(ctx, ui) {
  const { room, view } = ctx;
  return el('header', { class: 'bar bar--top' }, [
    el('button', {
      class: 'chip', title: 'Tap to copy the room link',
      onclick: (e) => copyLink(e.currentTarget),
    }, [el('span', { class: 'label', text: 'Room' }), el('b', { class: 'mono', text: room.code })]),
    view?.deadline || view?.remainingMs !== undefined ? timerNode(view) : el('span'),
    el('div', { class: 'row' }, [
      room.phase !== 'lobby' && ui.roleChip ? ui.roleChip(ctx) : null,
      el('button', {
        class: 'iconbtn', 'aria-label': 'How to play',
        onclick: () => openRules(room.gameId),
      }, [icon('i-book', 'ico ico--lg')]),
    ]),
  ]);
}

/** The client interpolates against a server timestamp; it never owns the clock. */
/**
 * The server sends a deadline but never says how long the phase was, so the
 * ring calibrates itself: the largest remaining time we have seen for this
 * particular deadline is the full span. Keyed by deadline so a new phase
 * recalibrates on its own.
 */
const spans = new Map();
function spanFor(deadline, left) {
  const total = Math.max(spans.get(deadline) ?? 0, left);
  spans.set(deadline, total);
  if (spans.size > 8) spans.delete(spans.keys().next().value);
  return total;
}

function timerNode(view) {
  const node = el('div', { class: 'timer', role: 'timer' }, [
    el('span', {
      class: 'timer__n num', html:
        `<svg class="timer__ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="timer__trk" cx="50" cy="50" r="44"/><circle class="timer__bar" cx="50" cy="50" r="44"/></svg>`,
    }),
    el('span', { class: 'timer__n num timer__t' }),
  ]);
  paintTimer(node, view);
  if (view.deadline) startTicking(view);
  return node;
}

/** Write the two things that change. No node is created or destroyed. */
function paintTimer(node, view) {
  const left = view.deadline ? view.deadline - Date.now() : (view.remainingMs ?? 0);
  const total = view.deadline ? spanFor(view.deadline, left) : (view.totalMs ?? 0);
  const p = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  node.style.setProperty('--p', String(p));
  node.classList.toggle('is-urgent', left <= 10_000 && left > 0);
  node.setAttribute('aria-label', `${Math.max(0, Math.ceil(left / 1000))} seconds left`);
  node.querySelector('.timer__t').textContent = formatClock(left);
}

/**
 * The countdown used to call render() once a second.
 *
 * That tore the entire DOM down and rebuilt it every tick — taking with it
 * whatever field you were typing in, whatever slider you were dragging, and
 * the focus and caret along with them. During Spectrum's 90-second clue phase
 * the psychic's input was destroyed and recreated empty every single second.
 *
 * A clock only needs to repaint a clock.
 */
let tickHandle = 0;
let ticking = null;
function startTicking(view) {
  ticking = view;
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    const node = document.querySelector('.timer');
    if (!node || state.screen !== 'game' || !ticking?.deadline) {
      clearInterval(tickHandle);
      tickHandle = 0;
      return;
    }
    paintTimer(node, ticking);
  }, 1000);
}

/** One-shot re-render, for state that becomes true merely by time passing. */
let graceHandle = 0;
function scheduleGraceCheck(ms) {
  if (graceHandle) return;
  graceHandle = setTimeout(() => {
    graceHandle = 0;
    render();
  }, ms);
}

function connectionBanner() {
  if (state.status === 'online') return null;
  // Suppress the banner for a sub-2s blip: flashing on every hiccup makes a
  // working connection feel broken.
  const waited = Date.now() - state.offlineSince;
  if (state.status === 'offline' && waited < 2000) {
    scheduleGraceCheck(2000 - waited + 50);
    return null;
  }
  return el('div', { class: 'banner banner--danger row' }, [
    icon('i-wifi-off'),
    el('span', { class: 'grow', text: 'Reconnecting…' }),
  ]);
}

// -------------------------------------------------------------------- lobby --

function lobbyBody(ctx) {
  const { room, isHost } = ctx;
  const game = state.games.find((g) => g.id === room.gameId);
  const enough = room.players.length >= (game?.minPlayers ?? 3);
  const full = room.players.length >= (game?.maxPlayers ?? 99);
  const host = room.players.find((p) => p.id === room.hostId);
  const hostGone = host && !host.online;

  return [
    el('button', {
      class: 'roomcode', onclick: (e) => copyLink(e.currentTarget),
      'aria-label': `Room code ${room.code.split('').join(' ')}, tap to copy the link`,
    }, [
      el('span', { class: 'label', text: 'Room code' }),
      el('span', { class: 'roomcode__cells num', 'aria-hidden': 'true' }, room.code.split('').map((c) => el('i', { text: c }))),
      el('span', { class: 'roomcode__hint label' }, [icon('i-copy', 'ico ico--sm'), 'Tap to copy the link']),
    ]),
    // The one room-wide dead end: the host closes their tab and nobody else
    // can start. Offer the way out where the problem is visible.
    hostGone && !isHost && el('div', { class: 'stack stack--tight' }, [
      el('div', { class: 'banner banner--danger', text: `${host.name} has dropped out, so nobody can start.` }),
      el('button', {
        class: 'btn btn--secondary btn--block',
        onclick: () => state.conn?.send({ t: 'claimHost' }),
      }, ['Take over as host']),
    ]),
    el('div', { class: 'label', text: `${room.players.length} in the room${full ? ' — full' : ''}` }),
    playerList(ctx, {
      showHost: true,
      // Host controls live on the tiles rather than behind a settings screen:
      // "get Dev out of this room" is a thing you want to do while looking at
      // Dev, not three taps away.
      onPickFor: (p) => (isHost && p.id !== ctx.me ? () => openPlayerSheet(ctx, p) : undefined),
      subFor: (p) => (p.id === room.hostId ? 'Host' : p.online ? null : 'Reconnecting'),
    }),
    !enough && el('div', { class: 'banner', text: `Needs at least ${game?.minPlayers} players.` }),
    !isHost && !hostGone && el('div', { class: 'banner banner--accent', text: `Waiting for ${nameOf(ctx, room.hostId)} to start.` }),
    isHost && gameOptions(ctx, game),
  ];
}

/** Host-only actions on one player. A sheet, so a mis-tap is never destructive. */
function openPlayerSheet(ctx, player) {
  document.getElementById('sheet-title').textContent = player.name;
  const body = clear(document.getElementById('sheet-body'));
  const close = () => sheet.close();
  body.append(
    el('button', {
      class: 'btn btn--secondary btn--block',
      onclick: () => { state.conn?.send({ t: 'makeHost', playerId: player.id }); close(); },
    }, [`Make ${player.name} the host`]),
    el('button', {
      class: 'btn btn--danger btn--block',
      onclick: () => { state.conn?.send({ t: 'kick', playerId: player.id }); close(); },
    }, [`Remove ${player.name} from the room`]),
    el('button', { class: 'btn btn--ghost btn--block', onclick: close }, ['Cancel']),
  );
  sheet.showModal();
}

function gameOptions(ctx, game) {
  const { room, send } = ctx;
  const ui = GAME_UI[room.gameId];
  if (!ui.options) return null;
  return el('div', { class: 'stack stack--tight' }, [
    el('div', { class: 'label', text: 'Options' }),
    ...ui.options(ctx, (patch) => state.conn?.send({ t: 'setConfig', config: patch })),
  ]);
}

function lobbyBottom(ctx) {
  const { room, isHost } = ctx;
  const game = state.games.find((g) => g.id === room.gameId);
  const count = room.players.length;
  const enough = count >= (game?.minPlayers ?? 3);
  const tooMany = count > (game?.maxPlayers ?? 99);

  const need = (game?.minPlayers ?? 3) - count;

  if (!isHost) {
    return el('footer', { class: 'bar bar--bottom' }, [
      el('button', { class: 'btn btn--primary btn--block', onclick: shareLink }, [
        need > 0 ? `Invite ${need} more ${need === 1 ? 'person' : 'people'}` : 'Invite someone',
      ]),
    ]);
  }

  // Short of players? Inviting IS the next step, so it takes the primary slot.
  // A disabled button with nothing beside it is the dead end that made this
  // look broken.
  if (!enough) {
    return el('footer', { class: 'bar bar--bottom' }, [
      el('button', { class: 'btn btn--primary btn--block', onclick: shareLink }, [
        `Invite ${need} more ${need === 1 ? 'person' : 'people'}`,
      ]),
      el('button', {
        class: 'btn btn--secondary btn--block',
        onclick: () => state.conn?.send({ t: 'start' }),
        disabled: true,
      }, [`Start needs ${game.minPlayers} players`]),
    ]);
  }

  return el('footer', { class: 'bar bar--bottom' }, [
    el('button', {
      class: 'btn btn--primary btn--block',
      disabled: tooMany,
      onclick: () => state.conn?.send({ t: 'start' }),
    }, [
      tooMany ? `Too many players (max ${game.maxPlayers})` : `Start with ${count} player${count === 1 ? '' : 's'}`,
    ]),
    el('button', { class: 'btn btn--ghost btn--block', onclick: shareLink }, ['Invite someone']),
  ]);
}

// ------------------------------------------------------------ shared pieces --

function avatarFor(id, name) {
  const traits = state.avatars[id];
  if (!traits) return el('span', { class: 'ptile__av' });
  return el('span', { class: 'ptile__av', html: avatarSvg(name, traits) });
}

function nameOf(ctx, id) {
  return ctx.room.players.find((p) => p.id === id)?.name ?? 'someone';
}

function playerTile(ctx, player, opts = {}) {
  const badges = [];
  if (opts.host && ctx.room.hostId === player.id) {
    badges.push(el('span', { class: 'bdg bdg--host', title: 'Host' }, [icon('i-crown')]));
  }
  for (const badge of opts.badges ?? []) badges.push(badge);
  if (!player.online) {
    badges.push(el('span', { class: 'bdg bdg--off', title: 'Reconnecting' }, [icon('i-wifi-off')]));
  }

  const tile = el(opts.onPick ? 'button' : 'li', {
    class: `ptile ${opts.pick ? 'ptile--pick' : ''} ${opts.selected ? 'is-selected' : ''} ${player.online ? '' : 'is-offline'}`,
    dataset: opts.state ? { state: opts.state } : {},
    disabled: opts.disabled,
    onclick: opts.onPick,
  }, [
    avatarFor(player.id, player.name),
    el('span', { class: 'ptile__body' }, [
      el('span', { class: 'ptile__name', text: player.id === ctx.me ? `${player.name} (you)` : player.name }),
      opts.sub && el('span', { class: 'ptile__sub label', text: opts.sub }),
    ]),
    el('span', { class: 'ptile__badges' }, badges),
  ]);
  // A <ul> whose children are <button>s is not a list to a screen reader, and
  // "6 items" is real information here. display:contents keeps the flex layout
  // identical while restoring the semantics.
  return opts.onPick ? el('li', { class: 'ptile__slot' }, [tile]) : tile;
}

function playerList(ctx, opts = {}) {
  return el('ul', { class: `plist ${opts.picking ? 'is-picking' : ''}` },
    ctx.room.players.map((p) => playerTile(ctx, p, {
      host: opts.showHost,
      sub: opts.subFor?.(p),
      state: opts.stateFor?.(p),
      badges: opts.badgesFor?.(p),
      // Per-player, because "you cannot manage yourself" must make the tile
      // inert rather than a button that does nothing when tapped.
      onPick: opts.onPickFor?.(p),
    })),
  );
}

function select(id) {
  state.selection = state.selection === id ? null : id;
  buzz('confirm');
  render();
}

async function copyLink(node) {
  const url = `${location.origin}/${state.room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    node.classList.add('is-copied');
    toast('Link copied');
    setTimeout(() => node.classList.remove('is-copied'), 1500);
  } catch {
    toast(url);
  }
}

async function shareLink() {
  const url = `${location.origin}/${state.room.code}`;
  const data = { title: 'Parlour', text: `Join my game — room ${state.room.code}`, url };
  // Must be inside the click handler: share requires transient activation.
  if (navigator.share) {
    try {
      await navigator.share(data);
      return;
    } catch {
      /* user dismissed */
    }
  }
  copyLink(document.body);
}

function themeToggle() {
  return el('button', {
    class: 'iconbtn', 'aria-label': 'Switch theme',
    onclick: () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('parlour:theme', next);
      } catch {
        /* nothing to do */
      }
    },
  }, [icon('i-eye', 'ico ico--lg')]);
}

function openRules(gameId) {
  const game = state.games.find((g) => g.id === gameId);
  document.getElementById('sheet-title').textContent = `How to play ${game?.name ?? ''}`;
  const body = clear(document.getElementById('sheet-body'));
  for (const section of game?.rules ?? []) {
    body.append(el('div', { class: 'stack stack--tight' }, [
      el('h3', { class: 't-lg', text: section.h }),
      el('p', { class: 'dim t-sm', text: section.p }),
    ]));
  }
  body.append(el('div', { class: 'optionrow' }, [
    el('span', { text: 'Sound' }),
    el('button', {
      class: 'btn btn--secondary', 'aria-pressed': String(prefs.sound),
      onclick: (e) => {
        prefs.sound = !prefs.sound;
        savePrefs();
        unlockAudio();
        e.currentTarget.textContent = prefs.sound ? 'On' : 'Off';
        e.currentTarget.setAttribute('aria-pressed', String(prefs.sound));
      },
    }, [prefs.sound ? 'On' : 'Off']),
  ]));
  sheet.showModal();
}

try {
  const saved = localStorage.getItem('parlour:theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* nothing to do */
}

export { render, state, el, icon, playerTile, playerList, nameOf, avatarFor, toast, celebrate, tone, buzz, announce };

boot();
