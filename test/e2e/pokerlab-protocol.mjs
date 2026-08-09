/**
 * The Lab, over the wire, against whatever is deployed.
 *
 * The browser suite drives the UI; this drives the Durable Object. It exists
 * for two reasons the browser suite cannot cover:
 *
 *   IT RUNS AGAINST PRODUCTION. Point BASE_URL at the deployed site and this
 *   checks the thing users actually load, not a local build of the same
 *   commit. Some environments cannot navigate Chromium to a remote host at
 *   all; a WebSocket goes anywhere fetch goes.
 *
 *   IT EXERCISES A REAL ALARM. The bots act on a Durable Object alarm, and
 *   alarms are the one part of the runtime that a local `wrangler dev` and the
 *   edge do not share an implementation of. A bug that stalls the table on a
 *   bot's turn is invisible to every test that does not wait for one — and
 *   there was exactly such a bug: a fired alarm left `armedAt` set, so the
 *   next deadline inside its 30-second epsilon was silently never written.
 *
 * The redaction check is done on the FRAME rather than on the DOM, so it is
 * testing the server's redaction boundary and not the client's discretion.
 *
 *   node test/e2e/pokerlab-protocol.mjs
 *   BASE_URL=https://games.example.com node test/e2e/pokerlab-protocol.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
};

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// ------------------------------------------------------------- discovery ---

const manifest = await (await fetch(`${BASE}/api/games`)).json();
const lab = (Array.isArray(manifest) ? manifest : manifest.games).find((g) => g.id === 'pokerlab');
check('the Lab is in the deployed manifest', Boolean(lab));
check('and it is playable alone', lab?.minPlayers === 1, JSON.stringify(lab?.minPlayers));
check('and it ships its rules', Array.isArray(lab?.rules) && lab.rules.length >= 4);

const made = await post('/api/create', { game: 'pokerlab', name: 'Probe' });
check('a room is created', made.status === 200, JSON.stringify(made.json).slice(0, 160));
const { code, pid, tok } = made.json ?? {};
check('with a room code', /^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(code ?? ''), String(code));
if (!code) {
  console.log('\ncannot continue without a room');
  process.exit(1);
}

// ------------------------------------------------------------- the socket --

const frames = [];
const ws = new WebSocket(`${WS}/ws?code=${code}&pid=${pid}&tok=${tok}`);
ws.addEventListener('message', (e) => {
  try {
    frames.push(JSON.parse(e.data));
  } catch {
    /* not a frame we speak */
  }
});

/** Wait for a frame matching `pred`, or give up. Returns null on timeout. */
const seen = (pred, ms = 30_000) => new Promise((resolve) => {
  const hit = frames.find(pred);
  if (hit) return resolve(hit);
  const poll = setInterval(() => {
    const f = frames.find(pred);
    if (f) {
      clearInterval(poll);
      clearTimeout(give);
      resolve(f);
    }
  }, 150);
  const give = setTimeout(() => {
    clearInterval(poll);
    resolve(null);
  }, ms);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () => reject(new Error('websocket refused')));
});
check('the websocket connects to the lobby', ws.readyState === 1);
await seen((f) => f.room);

// One player, no waiting for anybody. A solo game that cannot start alone is
// a dead end, and it is the most common way a solo mode ships broken.
ws.send(JSON.stringify({ t: 'start' }));

const dealt = await seen((f) => f.view?.game === 'pokerlab' && f.view?.seats?.length >= 3);
check('the table deals, with bots in the empty seats', Boolean(dealt), 'no dealt frame arrived');

if (dealt) {
  const seats = dealt.view.seats;
  const mine = seats.find((s) => s.id === pid);
  check('you are dealt two cards', mine?.hole?.length === 2);

  // The check that matters. Not "does the client hide them" — does the SERVER
  // ever put them on the wire. A trainer that leaks the bots' cards teaches
  // nothing, because every decision is made with information you would not
  // have at a real table.
  const leaked = seats.filter((s) => s.id !== pid && s.hole);
  check('and no bot’s cards are on the wire', leaked.length === 0,
    JSON.stringify(leaked.map((s) => s.id)));
  check('the runout is not revealed yet', dealt.view.revealed === false);

  const bots = seats.filter((s) => s.bot);
  check('every seat is filled', seats.length >= 3, `${seats.length} seats`);
  check('and every bot advertises the habit you are meant to punish',
    bots.length > 0 && bots.every((s) => s.tell), JSON.stringify(bots.map((s) => s.personality)));

  const stacks = seats.map((s) => s.stack + (s.totalCommitted ?? 0));
  check('everyone starts on the same stack', new Set(stacks).size === 1, JSON.stringify(stacks));

  // ------------------------------------------------------- the real alarm --

  // Nobody else is here to press anything. If the table ever sits on a bot's
  // turn without advancing, the game is over for the player — and on the edge
  // this is a genuine Durable Object alarm, not a local emulation of one.
  const advised = await seen((f) => f.view?.advice, 45_000);
  check('the bots act on their own and the action reaches you', Boolean(advised),
    'no advice frame arrived within 45s — the table stalled on a bot');

  if (advised) {
    const a = advised.view.advice;
    check('the coach states a line', Boolean(a.best?.move), JSON.stringify(a.best));
    check('and explains it', (a.best?.why?.length ?? 0) > 20);
    check('with several facts behind it', a.facts.length >= 2, `${a.facts.length} facts`);

    const eq = a.facts.find((f) => f.key === 'equity');
    check('equity is reported', Boolean(eq));
    // Promise: an estimate never wears the clothes of arithmetic. Postflop the
    // engine enumerates and the number is exact; preflop it samples and must
    // carry its error bar.
    check('and is either exact or carries its error bar',
      eq.exact ? /exact/.test(eq.detail) : /±/.test(eq.detail), eq.detail);
    check('facts are individually flagged exact or estimated',
      a.facts.every((f) => typeof f.exact === 'boolean'));

    check('every line is priced in big blinds',
      a.options.length >= 2 && a.options.every((o) => Number.isFinite(o.ev)),
      JSON.stringify(a.options.map((o) => [o.move, o.ev])));
    check('folding is exactly zero',
      a.options.find((o) => o.move === 'fold')?.ev === 0);
    check('the best line is the top of the list',
      a.options.every((o) => o.ev <= a.best.ev));
    // Never state a mixed spot as a pure one.
    check('a mix is reported as a mix, or not at all',
      a.mixed === null || a.mixed.length > 1, JSON.stringify(a.mixed));

    console.log(`     coach: ${a.mixed ? `${a.mixed.join(' or ')} — same value` : a.best.move}`
      + ` | ${a.facts.map((f) => `${f.label} ${f.value}`).join(' | ')}`);
  }
}

ws.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall Lab protocol checks passed');
process.exit(failures ? 1 : 0);
