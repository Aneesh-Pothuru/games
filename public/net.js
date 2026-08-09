/**
 * Connection to a lobby.
 *
 * Disconnection is the normal case, not the error case: Safari and Chrome both
 * deliberately close WebSockets when a page enters bfcache, and a backgrounded
 * phone routinely comes back with a zombie socket and no `onclose` ever firing.
 * So this reconnects aggressively, probes on every wake signal, and never
 * trusts `readyState` alone.
 */

const HEARTBEAT_REQUEST = 'p';
const HEARTBEAT_PERIOD_MS = 20_000;
const HEARTBEAT_DEADLINE_MS = 8_000;
const WAKE_DEADLINE_MS = 3_000;
/** Cap at 8s, not 30s: this is a co-located game and the phone is in a hand. */
const BACKOFF_CAP_MS = 8_000;
const STABLE_AFTER_MS = 5_000;
/** Suppress the reconnecting banner below this — a sub-2s blip that flashes a
 *  banner makes a perfectly good connection feel broken. */
export const BANNER_DELAY_MS = 2_000;

export class Connection {
  constructor({ code, pid, tok, onState, onEvent, onStatus, onFatal }) {
    this.url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?code=${encodeURIComponent(code)}&pid=${encodeURIComponent(pid)}&tok=${encodeURIComponent(tok)}`;
    this.onState = onState;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.onFatal = onFatal;

    this.ws = null;
    this.seq = -1;
    this.attempt = 0;
    this.stopped = false;
    this.timers = { beat: 0, dead: 0, retry: 0, stable: 0 };

    this._wake = () => this.#wake();
    addEventListener('online', this._wake);
    addEventListener('focus', this._wake);
    addEventListener('pageshow', this._wake);
    document.addEventListener('visibilitychange', this._wake);
    // Close cleanly on the way out so we are bfcache-friendly.
    addEventListener('pagehide', () => {
      try {
        this.ws?.close(1000, 'pagehide');
      } catch {
        /* nothing to do */
      }
    });
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.timers.retry);
    this.#clearTimers();

    const ws = (this.ws = new WebSocket(this.url));

    ws.onopen = () => {
      this.onStatus('online');
      this.timers.beat = setInterval(() => this.#probe(HEARTBEAT_DEADLINE_MS), HEARTBEAT_PERIOD_MS);
      // Reset backoff only once the link proves stable. Resetting in onopen
      // turns an accept-then-drop server into a hot reconnect loop.
      this.timers.stable = setTimeout(() => {
        this.attempt = 0;
      }, STABLE_AFTER_MS);
      this.send({ t: 'resync' });
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'pong') {
        clearTimeout(this.timers.dead);
        return;
      }
      if (msg.t === 'state') {
        // >= not >: presence-only updates legitimately reuse the same seq.
        if (msg.seq < this.seq) return;
        this.seq = msg.seq;
        this.onState(msg);
        return;
      }
      this.onEvent?.(msg);
    };

    ws.onclose = (e) => {
      this.#clearTimers();
      if (this.stopped) return;
      // 4001 means our own newer socket replaced this one — not an outage.
      if (e.code === 4001) return;
      if (e.code === 4003 || e.code === 4004 || e.code === 4002) {
        this.onStatus('fatal');
        this.onFatal?.(e.code);
        return;
      }
      this.onStatus('offline');
      this.timers.retry = setTimeout(() => this.connect(), this.#backoff());
    };

    ws.onerror = () => {
      /* onclose always follows; nothing useful to do here */
    };
  }

  send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  action(action, ref) {
    return this.send({ t: 'action', action, ref });
  }

  close() {
    this.stopped = true;
    this.#clearTimers();
    removeEventListener('online', this._wake);
    removeEventListener('focus', this._wake);
    removeEventListener('pageshow', this._wake);
    document.removeEventListener('visibilitychange', this._wake);
    try {
      this.ws?.close(1000, 'left');
    } catch {
      /* already gone */
    }
  }

  /** Full jitter. Every deploy disconnects every socket at once, and without
   *  jitter the whole table stampedes back in the same millisecond. */
  #backoff() {
    const cap = Math.min(BACKOFF_CAP_MS, 500 * 1.7 ** this.attempt++);
    return Math.random() * cap;
  }

  #probe(deadline) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // The DO answers this via setWebSocketAutoResponse without waking up.
    // It has to be an application-level ping: browsers cannot send WebSocket
    // protocol ping frames from JavaScript.
    this.ws.send(HEARTBEAT_REQUEST);
    clearTimeout(this.timers.dead);
    this.timers.dead = setTimeout(() => {
      try {
        this.ws.close(4000, 'no pong');
      } catch {
        /* onclose will reconnect */
      }
    }, deadline);
  }

  #wake() {
    if (this.stopped) return;
    if (document.visibilityState !== 'visible') return;
    // Being visible does not mean the socket is alive. Probe, don't assume.
    if (this.ws?.readyState === WebSocket.OPEN) this.#probe(WAKE_DEADLINE_MS);
    else {
      clearTimeout(this.timers.retry);
      this.connect();
    }
  }

  #clearTimers() {
    clearInterval(this.timers.beat);
    clearTimeout(this.timers.dead);
    clearTimeout(this.timers.stable);
  }
}

// ------------------------------------------------------------------- seats --

const seatKey = (code) => `parlour:seat:${code}`;
const SEAT_TTL_MS = 6 * 60 * 60 * 1000;

export function saveSeat(code, seat) {
  const record = JSON.stringify({ ...seat, exp: Date.now() + SEAT_TTL_MS });
  try {
    localStorage.setItem(seatKey(code), record);
    sessionStorage.setItem(seatKey(code), record);
  } catch {
    /* private mode: we simply lose reconnection across reloads */
  }
}

export function loadSeat(code) {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(seatKey(code));
      if (!raw) continue;
      const seat = JSON.parse(raw);
      if (seat.exp && seat.exp < Date.now()) continue;
      if (seat.pid && seat.tok) return seat;
    } catch {
      /* corrupt entry; fall through */
    }
  }
  return null;
}

export function clearSeat(code) {
  try {
    localStorage.removeItem(seatKey(code));
    sessionStorage.removeItem(seatKey(code));
  } catch {
    /* nothing to do */
  }
}

export function rememberName(name) {
  try {
    localStorage.setItem('parlour:name', name);
  } catch {
    /* nothing to do */
  }
}

export function recalledName() {
  try {
    return localStorage.getItem('parlour:name') ?? '';
  } catch {
    return '';
  }
}

// --------------------------------------------------------------------- api --

export async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: 'bad_response' }));
  if (!res.ok) throw Object.assign(new Error(data.error ?? 'request_failed'), { code: data.error });
  return data;
}
