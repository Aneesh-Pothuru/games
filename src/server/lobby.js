/**
 * Lobby — one Durable Object per room code.
 *
 * Four things about this class are load-bearing and easy to break:
 *
 *  1. `ctx.acceptWebSocket()`, never `ws.accept()`. The hibernation API is what
 *     keeps an idle lobby free — a lobby sits idle for minutes at a time while
 *     eight people argue, and a non-hibernating socket bills duration for its
 *     entire life.
 *  2. No `setTimeout`/`setInterval` anywhere. A single pending timer blocks
 *     hibernation permanently, silently, for every lobby.
 *  3. Presence is *derived* from `getWebSockets()`, never persisted. A phone on
 *     a flaky train connection would otherwise write a storage row every time
 *     its radio blinked, and rows-written is the real free-tier ceiling.
 *  4. Every broadcast is redacted per player by the game module. There is no
 *     code path that sends one shared state blob to everybody.
 *
 * In-memory state does not survive hibernation: the constructor re-runs on
 * every wake. Only storage, `getWebSockets()`, and socket attachments persist.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  C,
  S,
  CLOSE,
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  MAX_FRAME_BYTES,
  FLOOD_WINDOW_MS,
  FLOOD_MAX_MESSAGES,
  MAX_PLAYERS,
  LOBBY_TTL_MS,
} from '../shared/protocol.js';
import { sanitizeName } from '../shared/codes.js';
import { GAMES } from '../games/index.js';
import { randomSeed } from '../shared/rng.js';

const STORAGE_KEY = 'room';
/** Only move the alarm when the target shifts materially — setAlarm costs a row write. */
const ALARM_EPSILON_MS = 30_000;
/** Re-persist the TTL lazily rather than on every single message. */
const TTL_WRITE_BAND_MS = 10 * 60 * 1000;

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);

    // Runs on EVERY wake from hibernation, so it must stay O(1) and I/O-free.
    this.room = undefined; // undefined = not loaded yet, null = does not exist
    this.armedAt = 0;
    this.buckets = new Map(); // pid -> {count, windowStart}; in-memory on purpose

    // Lets a client heartbeat without waking us and without duration charges.
    // Re-registering on each wake is cheap and idempotent.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
    );
  }

  // ---------------------------------------------------------------- storage --

  async #load() {
    if (this.room === undefined) {
      this.room = (await this.ctx.storage.get(STORAGE_KEY)) ?? null;
    }
    return this.room;
  }

  /** One row written. Call once per real transition — never per message. */
  async #commit() {
    this.room.seq++;
    this.room.expiresAt = Date.now() + LOBBY_TTL_MS;
    await this.ctx.storage.put(STORAGE_KEY, this.room);
    await this.#rearm();
  }

  /** Extend the lobby's life without paying for a write every time. */
  async #touch() {
    const next = Date.now() + LOBBY_TTL_MS;
    if (next - this.room.expiresAt > TTL_WRITE_BAND_MS) {
      this.room.expiresAt = next;
      await this.ctx.storage.put(STORAGE_KEY, this.room);
      await this.#rearm();
    }
  }

  async #rearm() {
    const deadline = this.room.game?.deadline ?? Infinity;
    const next = Math.min(this.room.expiresAt, deadline);
    if (!Number.isFinite(next)) return;
    if (Math.abs(this.armedAt - next) > ALARM_EPSILON_MS) {
      await this.ctx.storage.setAlarm(next);
      this.armedAt = next;
    }
  }

  // ---------------------------------------------------------------- fan-out --

  /** Presence is derived, never stored. Costs zero writes. */
  #onlineIds() {
    const ids = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att?.pid) ids.add(att.pid);
    }
    return ids;
  }

  #send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket already gone; webSocketClose will tidy up */
    }
  }

  #pushTo(ws, online = this.#onlineIds()) {
    const att = ws.deserializeAttachment();
    if (!att?.pid) return;
    this.#send(ws, {
      t: S.STATE,
      seq: this.room.seq,
      you: att.pid,
      room: publicRoom(this.room, online),
      // Redaction happens here, per viewer, inside the game module.
      view: this.room.game ? GAMES[this.room.gameId].viewFor(this.room, att.pid) : null,
    });
  }

  #broadcast() {
    const online = this.#onlineIds();
    for (const ws of this.ctx.getWebSockets()) this.#pushTo(ws, online);
  }

  #announce(event) {
    for (const ws of this.ctx.getWebSockets()) this.#send(ws, { t: S.EVENT, ...event });
  }

  // -------------------------------------------------------------------- RPC --

  /** Compare-and-set on the room code. Returns null if the code is already live. */
  async claim(code, gameId, hostName) {
    const now = Date.now();
    const existing = await this.#load();
    if (existing && now < existing.expiresAt) return null;

    const host = newPlayer(hostName, 0);
    this.room = {
      seq: 0,
      code,
      gameId,
      hostId: host.id,
      phase: 'lobby',
      createdAt: now,
      expiresAt: now + LOBBY_TTL_MS,
      config: { ...GAMES[gameId].defaultConfig },
      players: [host],
      scores: {},
      game: null,
      lastResult: null,
    };
    await this.#commit();
    return { pid: host.id, tok: host.tok };
  }

  async peek() {
    const room = await this.#load();
    if (!room || Date.now() >= room.expiresAt) return null;
    return {
      gameId: room.gameId,
      gameName: GAMES[room.gameId].meta.name,
      hostName: room.players.find((p) => p.id === room.hostId)?.name ?? '',
      playerCount: room.players.length,
      inProgress: room.phase !== 'lobby',
    };
  }

  async join(name) {
    const room = await this.#load();
    if (!room || Date.now() >= room.expiresAt) return { error: 'not_found' };
    if (room.phase !== 'lobby') return { error: 'in_progress' };
    if (room.players.length >= MAX_PLAYERS) return { error: 'room_full' };

    const player = newPlayer(dedupeName(name, room.players), room.players.length);
    room.players.push(player);
    await this.#commit();
    this.#broadcast();
    this.#announce({ kind: 'joined', name: player.name });
    return { pid: player.id, tok: player.tok };
  }

  // --------------------------------------------------------- socket upgrade --

  async fetch(request) {
    const url = new URL(request.url);
    const pid = url.searchParams.get('pid') ?? '';
    const tok = url.searchParams.get('tok') ?? '';

    const room = await this.#load();
    const seat = room?.players.find((p) => p.id === pid);
    if (!room || !seat || seat.tok !== tok || Date.now() >= room.expiresAt) {
      return new Response('bad session', { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // acceptWebSocket (not server.accept) is what enables hibernation.
    // The tag lets us find every socket belonging to this one seat.
    this.ctx.acceptWebSocket(server, [`p:${pid}`]);
    server.serializeAttachment({ pid });

    // Phone reconnected on a new IP before the old socket timed out: drop the
    // stale one so a seat never has two live sockets.
    for (const old of this.ctx.getWebSockets(`p:${pid}`)) {
      if (old !== server) {
        try {
          old.close(CLOSE.REPLACED, 'replaced');
        } catch {
          /* already closing */
        }
      }
    }

    await this.#touch();
    this.#broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- handlers --

  async webSocketMessage(ws, raw) {
    // Heartbeats never reach here — the runtime auto-answers them while we sleep.
    if (typeof raw !== 'string' || raw.length > MAX_FRAME_BYTES) {
      return ws.close(CLOSE.BAD_FRAME, 'bad frame');
    }

    const att = ws.deserializeAttachment();
    if (!att?.pid) return ws.close(CLOSE.NO_SESSION, 'no session');

    // A flooding client keeps us awake anyway, so an in-memory bucket is
    // exactly the right place for this: exact, free, and self-cleaning.
    if (this.#isFlooding(att.pid)) return ws.close(CLOSE.FLOOD, 'slow down');

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.close(CLOSE.BAD_FRAME, 'bad json');
    }
    if (!msg || typeof msg.t !== 'string') return ws.close(CLOSE.BAD_FRAME, 'bad message');

    const room = await this.#load();
    if (!room) return ws.close(CLOSE.GONE, 'lobby gone');

    await this.#handle(ws, att.pid, msg);
  }

  async #handle(ws, pid, msg) {
    const room = this.room;
    const me = room.players.find((p) => p.id === pid);
    if (!me) return ws.close(CLOSE.NO_SESSION, 'no seat');

    const reject = (why) => this.#send(ws, { t: S.REJECT, why, ref: msg.ref ?? null });
    const isHost = room.hostId === pid;

    switch (msg.t) {
      // Free: no writes, no broadcast to anyone else.
      case C.RESYNC:
        return this.#pushTo(ws);

      case C.SET_NAME: {
        const name = sanitizeName(msg.name);
        if (!name) return reject('name_required');
        if (name === me.name) return;
        me.name = dedupeName(name, room.players, me.id);
        await this.#commit();
        return this.#broadcast();
      }

      case C.SET_CONFIG: {
        if (!isHost) return reject('host_only');
        if (room.phase !== 'lobby') return reject('already_started');
        const merged = GAMES[room.gameId].normalizeConfig({ ...room.config, ...msg.config });
        room.config = merged;
        await this.#commit();
        return this.#broadcast();
      }

      case C.MAKE_HOST: {
        if (!isHost) return reject('host_only');
        const target = room.players.find((p) => p.id === msg.playerId);
        if (!target) return reject('no_such_player');
        room.hostId = target.id;
        await this.#commit();
        this.#announce({ kind: 'newHost', name: target.name });
        return this.#broadcast();
      }

      case C.KICK: {
        if (!isHost) return reject('host_only');
        if (room.phase !== 'lobby') return reject('already_started');
        if (msg.playerId === pid) return reject('cannot_kick_self');
        const idx = room.players.findIndex((p) => p.id === msg.playerId);
        if (idx === -1) return reject('no_such_player');
        const [gone] = room.players.splice(idx, 1);
        reseat(room.players);
        await this.#commit();
        for (const sock of this.ctx.getWebSockets(`p:${gone.id}`)) {
          try {
            sock.close(CLOSE.NO_SESSION, 'removed');
          } catch {
            /* already closing */
          }
        }
        this.#announce({ kind: 'kicked', name: gone.name });
        return this.#broadcast();
      }

      case C.LEAVE: {
        const idx = room.players.findIndex((p) => p.id === pid);
        if (idx === -1) return;
        // Mid-game departures keep the seat so the game state stays coherent;
        // the game module decides what an absent player means.
        if (room.phase === 'lobby') {
          room.players.splice(idx, 1);
          reseat(room.players);
          if (room.hostId === pid && room.players.length) room.hostId = room.players[0].id;
        } else {
          me.left = true;
        }
        await this.#commit();
        this.#announce({ kind: 'left', name: me.name });
        this.#broadcast();
        return ws.close(1000, 'left');
      }

      case C.START:
      case C.PLAY_AGAIN: {
        if (!isHost) return reject('host_only');
        return this.#startGame(reject);
      }

      case C.ACTION: {
        if (!room.game) return reject('not_playing');
        const game = GAMES[room.gameId];
        const outcome = game.action(room, pid, msg.action ?? {}, Date.now());
        if (outcome?.error) return reject(outcome.error);
        await this.#commit();
        if (outcome?.events) for (const e of outcome.events) this.#announce(e);
        return this.#broadcast();
      }

      default:
        return reject('unknown_message');
    }
  }

  async #startGame(reject) {
    const room = this.room;
    const game = GAMES[room.gameId];

    // Players who left the lobby mid-game are dropped before a new round.
    room.players = room.players.filter((p) => !p.left);
    reseat(room.players);
    if (!room.players.some((p) => p.id === room.hostId) && room.players.length) {
      room.hostId = room.players[0].id;
    }

    const count = room.players.length;
    if (count < game.meta.minPlayers) return reject('need_more_players');
    if (count > game.meta.maxPlayers) return reject('too_many_players');

    room.phase = 'playing';
    room.lastResult = null;
    room.game = game.start(room, randomSeed(), Date.now());
    await this.#commit();
    this.#announce({ kind: 'gameStarted' });
    this.#broadcast();
  }

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment();
    if (!att?.pid) return;

    // Do NOT flap presence when a reconnect already replaced this socket —
    // otherwise a clean reconnect blinks the player offline mid-vote for
    // everyone else at the table.
    const survivors = this.ctx.getWebSockets(`p:${att.pid}`).filter((s) => s !== ws);
    if (survivors.length === 0 && (await this.#load())) this.#broadcast();

    // The runtime auto-replies to close frames at our compatibility date.
    // Calling close anyway is a harmless no-op that protects us if the date
    // is ever rolled back — without it, clients would see spurious 1006s.
    try {
      ws.close(code, (reason ?? '').slice(0, 60));
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws, error) {
    console.error('websocket error', error instanceof Error ? error.message : String(error));
  }

  async alarm() {
    // An alarm gets only 6 retries. If this handler dies permanently, the
    // lobby is never garbage-collected and its storage is billed forever —
    // so every path is wrapped and we always re-arm on failure.
    try {
      const room = await this.#load();
      const now = Date.now();

      if (!room || now >= room.expiresAt) {
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(CLOSE.EXPIRED, 'lobby expired');
          } catch {
            /* already closing */
          }
        }
        this.room = null;
        // Stops storage billing. Also clears the alarm at our compat date.
        await this.ctx.storage.deleteAll();
        return;
      }

      const deadline = room.game?.deadline ?? null;
      if (deadline && now >= deadline) {
        const outcome = GAMES[room.gameId].onDeadline(room, now);
        await this.#commit();
        if (outcome?.events) for (const e of outcome.events) this.#announce(e);
        this.#broadcast();
      } else {
        this.armedAt = 0; // force the next #rearm to actually write
        await this.#rearm();
      }
    } catch (err) {
      console.error('alarm failed', err);
      try {
        // Re-arm ourselves so a transient bug cannot exhaust the retry budget
        // and strand this lobby's storage.
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
      } catch {
        /* nothing further we can do */
      }
    }
  }

  #isFlooding(pid) {
    const now = Date.now();
    const bucket = this.buckets.get(pid) ?? { count: 0, windowStart: now };
    if (now - bucket.windowStart >= FLOOD_WINDOW_MS) {
      bucket.count = 0;
      bucket.windowStart = now;
    }
    bucket.count++;
    this.buckets.set(pid, bucket);
    return bucket.count > FLOOD_MAX_MESSAGES;
  }
}

// ------------------------------------------------------------------ helpers --

function newPlayer(name, seat) {
  return {
    id: crypto.randomUUID(),
    tok: crypto.randomUUID(),
    name,
    seat,
    left: false,
  };
}

function reseat(players) {
  players.forEach((p, i) => {
    p.seat = i;
  });
}

/** Two people called "Sam" at one table is a real and common problem. */
function dedupeName(name, players, exceptId = null) {
  const taken = new Set(
    players.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/**
 * The always-public slice of room state. Deliberately contains no `tok` and
 * nothing game-secret — everything hidden lives behind the game's viewFor().
 */
function publicRoom(room, online) {
  return {
    code: room.code,
    gameId: room.gameId,
    phase: room.phase,
    hostId: room.hostId,
    config: room.config,
    scores: room.scores,
    lastResult: room.lastResult,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      left: p.left,
      online: online.has(p.id),
    })),
  };
}
