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
  // Deal until the human actually gets a decision.
  //
  // Not every hand gives you one: if all three bots fold to your big blind you
  // win the blinds without acting, and the hand is over before any advice
  // exists. Waiting on a single hand made this suite fail roughly one run in
  // five, and it failed with "the table stalled on a bot", which is a
  // completely different and much more alarming bug than the one that was
  // happening.
  let advised = null;
  for (let hand = 0; hand < 8 && !advised; hand++) {
    const seenBefore = frames.length;
    const next = await Promise.race([
      seen((f, i) => i >= seenBefore && f.view?.advice, 45_000),
      seen((f, i) => i >= seenBefore && f.view?.phase === 'handover', 45_000),
    ]);
    if (!next) break;
    if (next.view.advice) {
      advised = next;
      break;
    }
    // Nobody gave us a decision that hand. Deal the next one.
    ws.send(JSON.stringify({ t: 'action', action: { type: 'deal' } }));
    await new Promise((r) => setTimeout(r, 400));
  }
  check('the bots act on their own and the action reaches you', Boolean(advised),
    'no decision reached the human in eight hands — the table stalled on a bot');

  if (advised) {
    const a = advised.view.advice;
    const mode = advised.view.coach;
    check('the default mode is learn', mode === 'learn', String(mode));

    // THE REDACTION THAT MAKES IT A TRAINER. Before you act, the wire carries
    // the name of the idea being tested and nothing that resolves it. Not
    // hidden by CSS — absent, so a curious player cannot read the answer out
    // of the network tab any more than out of a real table.
    check('before you act, only the concept is sent', a.prompt === true, JSON.stringify(Object.keys(a)));
    check('and it names the idea', Boolean(a.lesson?.name), JSON.stringify(a.lesson));
    check('no equity is sent', a.equity === undefined);
    check('no recommendation is sent', a.best === undefined);
    check('no option list is sent', a.options === undefined);
    check('no facts are sent', a.facts === undefined);
    const raw = JSON.stringify(a);
    check('and nothing percentage-shaped leaks through', !/\d+(\.\d+)?%/.test(raw), raw.slice(0, 200));
    console.log(`     drilling: ${a.lesson?.name}`);

    // --------------------------------------------------- act, then learn ---

    const before = frames.length;
    // The wire shape the real client uses: a game action wrapped in `action`.
    ws.send(JSON.stringify({ t: 'action', action: { type: 'act', move: 'fold' } }));
    const graded = await seen((f, i) => i >= before && f.view?.lastGrade, 20_000);
    check('acting produces a grade', Boolean(graded), 'no graded frame arrived');

    if (graded) {
      const gr = graded.view.lastGrade;
      const full = graded.view.lastAdvice;

      check('the grade carries a band', typeof gr.label === 'string' && gr.label.length > 2, gr.label);
      check('and a verdict sentence', (gr.verdict?.length ?? 0) > 10, gr.verdict);
      check('and the loss in big blinds', Number.isFinite(gr.evLoss));
      // Normalised, which is the whole reason the same big blind can be a
      // mistake in one pot and nothing in another.
      check('and the loss as a share of the pot', Number.isFinite(gr.severity));
      check('the label is about the move, not the player',
        !/\byou\b/i.test(gr.verdict ?? ''), gr.verdict);

      check('a named lesson comes back with it', Boolean(gr.lesson?.name), JSON.stringify(gr.lesson?.name));
      check('the lesson explains this spot', (gr.lesson?.point?.length ?? 0) > 20, gr.lesson?.point);
      check('and gives a rule that transfers', (gr.lesson?.rule?.length ?? 0) > 20, gr.lesson?.rule);

      check('NOW the numbers arrive', Boolean(full?.facts?.length), 'no analysis after acting');
      check('with every line priced', (full?.options?.length ?? 0) >= 2,
        JSON.stringify(full?.options?.map((o) => [o.move, o.ev])));
      const eq = full?.facts?.find((f) => f.key === 'equity');
      check('equity is either exact or carries its error bar',
        eq ? (eq.exact ? /exact/.test(eq.detail) : /±/.test(eq.detail)) : false, eq?.detail);

      console.log(`     ${gr.label}: ${gr.verdict} | lesson: ${gr.lesson?.name}`);
    }

    // ------------------------------------------------------- the course ---
    const course = graded?.view?.course ?? advised.view.course;
    check('a course of named concepts is tracked', (course?.rows?.length ?? 0) >= 10,
      `${course?.rows?.length} concepts`);
    check('grouped into stages', (course?.stages?.length ?? 0) >= 3);
    check('every concept has a mastery band', course?.rows?.every((r) => r.band?.label));
    check('and there is something to work on next', Boolean(course?.next?.name), course?.next?.name);
  }
}

ws.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall Lab protocol checks passed');
process.exit(failures ? 1 : 0);
