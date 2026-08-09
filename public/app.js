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
  not_found: 'No room with that code',
  name_required: 'Enter a name first',
  bad_code: 'That code does not look right',
};
const humanError = (why) => ERRORS[why] ?? 'That move is not allowed right now';

// ------------------------------------------------------------------- render --

function render() {
  const scroll = root.querySelector('.flow')?.scrollTop ?? 0;
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
    oninput: (e) => {
      state.codeEntry = e.target.value.toUpperCase().slice(0, 16);
      e.target.value = state.codeEntry;
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
        'Spyfall · Werewolf · Secret Hitler · Avalon · Wavelength — all five are below, under our own names.' }),

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
  return shell({
    top: el('header', { class: 'bar bar--top' }, [el('span', { class: 'label', text: 'Parlour' }), themeToggle()]),
    body: [
      el('h1', { class: 't-xl', text: `Joining room ${state.code}` }),
      el('div', { class: 'field' }, [el('label', { class: 'label', for: 'name', text: 'Your name' }), nameInput]),
    ],
    bottom: el('footer', { class: 'bar bar--bottom' }, [
      el('button', {
        class: 'btn btn--primary btn--block',
        disabled: state.busy,
        onclick: () => doJoin(state.code, state.name),
      }, ['Go — join game']),
    ]),
  });
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
  };

  const body = inLobby ? lobbyBody(ctx) : ui.body(ctx);
  const bottom = inLobby ? lobbyBottom(ctx) : ui.bottom(ctx);

  return shell({
    top: gameTop(ctx, ui),
    body: [connectionBanner(), ...body],
    bottom,
  });
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
function timerNode(view) {
  const total = view.totalMs ?? 0;
  const left = view.deadline ? view.deadline - Date.now() : (view.remainingMs ?? 0);
  const p = total ? Math.max(0, Math.min(1, left / total)) : 0;
  const urgent = left <= 10_000 && left > 0;
  const node = el('div', {
    class: `timer ${urgent ? 'is-urgent' : ''}`, role: 'timer',
    'aria-label': `${Math.ceil(left / 1000)} seconds left`, style: `--p:${p}`,
  }, [
    el('span', {
      class: 'timer__n num', html:
        `<svg class="timer__ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="timer__trk" cx="50" cy="50" r="44"/><circle class="timer__bar" cx="50" cy="50" r="44"/></svg>`,
    }),
    el('span', { class: 'timer__n num', text: formatClock(left) }),
  ]);
  if (view.deadline) scheduleTick();
  return node;
}

let tickHandle = 0;
function scheduleTick() {
  if (tickHandle) return;
  tickHandle = setTimeout(() => {
    tickHandle = 0;
    if (state.screen === 'game') render();
  }, 1000);
}

function connectionBanner() {
  if (state.status === 'online') return null;
  // Suppress the banner for a sub-2s blip: flashing on every hiccup makes a
  // working connection feel broken.
  if (state.status === 'offline' && Date.now() - state.offlineSince < 2000) {
    scheduleTick();
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

  return [
    el('button', {
      class: 'roomcode', onclick: (e) => copyLink(e.currentTarget),
      'aria-label': `Room code ${room.code.split('').join(' ')}, tap to copy the link`,
    }, [
      el('span', { class: 'label', text: 'Room code' }),
      el('span', { class: 'roomcode__cells num', 'aria-hidden': 'true' }, room.code.split('').map((c) => el('i', { text: c }))),
      el('span', { class: 'roomcode__hint label' }, [icon('i-copy', 'ico ico--sm'), 'Tap to copy the link']),
    ]),
    el('div', { class: 'label', text: `${room.players.length} in the room` }),
    playerList(ctx, { showHost: true }),
    !enough && el('div', { class: 'banner', text: `Needs at least ${game?.minPlayers} players.` }),
    !isHost && el('div', { class: 'banner banner--accent', text: `Waiting for ${nameOf(ctx, room.hostId)} to start.` }),
    isHost && gameOptions(ctx, game),
  ];
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

  const tag = opts.onPick ? 'button' : 'li';
  return el(tag, {
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
}

function playerList(ctx, opts = {}) {
  return el('ul', { class: `plist ${opts.picking ? 'is-picking' : ''}` },
    ctx.room.players.map((p) => playerTile(ctx, p, {
      host: opts.showHost,
      sub: opts.subFor?.(p),
      state: opts.stateFor?.(p),
      badges: opts.badgesFor?.(p),
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
