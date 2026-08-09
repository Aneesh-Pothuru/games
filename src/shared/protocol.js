/**
 * Wire protocol shared by the Worker, the Durable Object, and the browser.
 *
 * Design rules that the rest of the system depends on:
 *
 *  1. Clients send *intents*, never state. The Durable Object is the only
 *     authority on what is true.
 *  2. Every broadcast is a per-player redacted projection. A single shared
 *     state blob would put every hidden role straight into devtools, which is
 *     the classic way amateur social-deduction implementations get broken by
 *     a player who is "just curious".
 *  3. `seq` is monotonic per lobby so a client can detect a gap and resync.
 */

// ---- client -> server -------------------------------------------------------
export const C = {
  RESYNC: 'resync',
  ACTION: 'action',
  SET_NAME: 'setName',
  SET_CONFIG: 'setConfig',
  START: 'start',
  KICK: 'kick',
  MAKE_HOST: 'makeHost',
  // Taken, not given: the host closing their tab must not strand the room.
  CLAIM_HOST: 'claimHost',
  LEAVE: 'leave',
  PLAY_AGAIN: 'playAgain',
};

// ---- server -> client -------------------------------------------------------
export const S = {
  STATE: 'state',
  REJECT: 'reject',
  EVENT: 'event',
  PONG: 'pong',
};

/**
 * Heartbeat. The DO registers this exact pair with setWebSocketAutoResponse,
 * so the edge answers it *without waking the object from hibernation* and
 * without accruing duration charges.
 *
 * This has to be an application-level ping because browsers cannot send
 * WebSocket protocol ping frames from JavaScript — the WebSocket API has no
 * ping() method.
 */
export const HEARTBEAT_REQUEST = 'p';
export const HEARTBEAT_RESPONSE = JSON.stringify({ t: S.PONG });

/**
 * Cloudflare deliberately does not publish its WebSocket idle timeout, and
 * third-party reports cluster around 100s. 20s is comfortably under any
 * plausible value while staying cheap.
 */
export const HEARTBEAT_PERIOD_MS = 20_000;
export const HEARTBEAT_DEADLINE_MS = 8_000;

// ---- close codes ------------------------------------------------------------
// Close reasons must stay under 123 UTF-8 bytes or the runtime throws.
export const CLOSE = {
  REPLACED: 4001, // same seat opened a newer socket
  EXPIRED: 4002, // lobby TTL elapsed
  NO_SESSION: 4003, // socket had no valid attachment
  GONE: 4004, // lobby storage was deleted
  FLOOD: 4008, // per-connection rate limit tripped
  BAD_FRAME: 4009, // oversized / non-string / unparseable
};

/** Codes where reconnecting cannot possibly help. */
export const FATAL_CLOSE_CODES = new Set([CLOSE.NO_SESSION, CLOSE.GONE, CLOSE.EXPIRED]);

// ---- limits -----------------------------------------------------------------
export const MAX_FRAME_BYTES = 4096;
export const FLOOD_WINDOW_MS = 10_000;
export const FLOOD_MAX_MESSAGES = 40;
export const MAX_PLAYERS = 16;
export const LOBBY_TTL_MS = 90 * 60 * 1000;
