/** End-to-end smoke test against a live wrangler dev instance. */
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
let failures = 0;

function check(name, cond, extra = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
}

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// --- static assets ---
const home = await fetch(BASE + '/');
check('serves index.html', home.ok && (await home.text()).includes('Parlour'));
const css = await fetch(BASE + '/styles.css');
check('serves styles.css', css.ok && css.headers.get('content-type')?.includes('css'));
const spa = await fetch(BASE + '/BCDF');
check('SPA fallback for /CODE routes', spa.ok);

// --- manifest ---
const manifest = await fetch(BASE + '/api/games');
const games = await manifest.json();
check('game manifest lists games', Array.isArray(games) && games.length >= 4, JSON.stringify(games).slice(0, 120));
check('manifest carries rules text', games.every((g) => Array.isArray(g.rules) && g.rules.length));

// --- validation happens in the Worker, before any DO is created ---
check('rejects unknown game', (await post('/api/create', { game: 'nope', name: 'A' })).status === 400);
check('rejects empty name', (await post('/api/create', { game: 'oddoneout', name: '  ' })).status === 400);
check('rejects malformed code', (await post('/api/join', { code: 'AEIO', name: 'A' })).status === 400);
check('unknown room 404s', (await post('/api/join', { code: 'ZZZZ', name: 'A' })).status === 404);
const upgrade = await fetch(BASE + '/ws?code=BCDF');
check('rejects ws without Upgrade header', upgrade.status === 426);

// --- create a room ---
const created = await post('/api/create', { game: 'oddoneout', name: 'Ana' });
check('creates a room', created.status === 200 && /^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(created.body.code), JSON.stringify(created.body));
const code = created.body.code;
const host = created.body;

const peek = await fetch(`${BASE}/api/room?code=${code}`);
const info = await peek.json();
check('peek reports the room', info.playerCount === 1 && info.gameId === 'oddoneout', JSON.stringify(info));

// --- join four more players ---
const seats = [host];
for (const name of ['Ben', 'Cleo', 'Dev', 'Eve']) {
  const res = await post('/api/join', { code, name });
  check(`${name} joins`, res.status === 200 && res.body.pid, JSON.stringify(res.body));
  seats.push(res.body);
}

// --- duplicate names get disambiguated ---
const dup = await post('/api/join', { code, name: 'Ana' });
check('duplicate name accepted', dup.status === 200);
seats.push(dup.body);

// --- websockets ---
const sockets = [];
const inbox = seats.map(() => []);

function open(i) {
  return new Promise((resolve, reject) => {
    const seat = seats[i];
    const ws = new WebSocket(`ws://localhost:8787/ws?code=${code}&pid=${seat.pid}&tok=${seat.tok}`);
    ws.addEventListener('message', (e) => {
      if (e.data === '{"t":"pong"}') return inbox[i].push({ t: 'pong' });
      inbox[i].push(JSON.parse(e.data));
    });
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', reject);
    sockets.push(ws);
  });
}

for (let i = 0; i < seats.length; i++) sockets[i] = await open(i);
await new Promise((r) => setTimeout(r, 400));
check('all six sockets receive state', inbox.every((box) => box.some((m) => m.t === 'state')), JSON.stringify(inbox.map((b) => b.length)));

const latest = (i) => [...inbox[i]].reverse().find((m) => m.t === 'state');
check('presence is derived and everyone shows online', latest(0).room.players.every((p) => p.online));
check('duplicate name was disambiguated', latest(0).room.players.filter((p) => p.name === 'Ana').length === 1
  && latest(0).room.players.some((p) => p.name === 'Ana 2'), latest(0).room.players.map((p) => p.name).join(','));
check('tokens never appear in a broadcast', !JSON.stringify(latest(0)).includes(seats[1].tok));

// --- heartbeat is auto-answered without waking the DO ---
sockets[0].send('p');
await new Promise((r) => setTimeout(r, 300));
check('heartbeat auto-response works', inbox[0].some((m) => m.t === 'pong'));

// --- non-host cannot start ---
sockets[1].send(JSON.stringify({ t: 'start' }));
await new Promise((r) => setTimeout(r, 300));
check('non-host cannot start the game', inbox[1].some((m) => m.t === 'reject' && m.why === 'host_only'));

// --- host starts ---
sockets[0].send(JSON.stringify({ t: 'start' }));
await new Promise((r) => setTimeout(r, 500));
check('game started', latest(0).room.phase === 'playing');

// --- THE critical check: the spy's payload must not contain the location ---
const views = seats.map((_, i) => latest(i).view);
const spies = views.filter((v) => v.amSpy);
check('exactly one spy at six players', spies.length === 1, `got ${spies.length}`);
const nonSpy = views.find((v) => !v.amSpy);
check('non-spies get a location and a role', Boolean(nonSpy.myLocation && nonSpy.myRole));
const spyView = spies[0];
check('spy gets no location', spyView.myLocation === null);
check('spy gets no role', spyView.myRole === null);
check('the real location is absent from the spy payload',
  !JSON.stringify(spyView).includes(`"myLocation":"${nonSpy.myLocation}"`));
const locations = new Set(views.filter((v) => !v.amSpy).map((v) => v.myLocation));
check('all non-spies share one location', locations.size === 1);
const roles = views.filter((v) => !v.amSpy).map((v) => v.myRole);
check('roles are distinct', new Set(roles).size === roles.length);

// --- reconnection restores the same seat and the same secret ---
const spyIndex = views.findIndex((v) => v.amSpy);
const beforeName = latest(spyIndex).room.players.find((p) => p.id === seats[spyIndex].pid).name;
sockets[spyIndex].close();
await new Promise((r) => setTimeout(r, 300));
inbox[spyIndex].length = 0;
sockets[spyIndex] = await open(spyIndex);
await new Promise((r) => setTimeout(r, 500));
const after = latest(spyIndex);
check('reconnect restores the same seat', after.you === seats[spyIndex].pid);
check('reconnect restores the same name', after.room.players.find((p) => p.id === after.you).name === beforeName);
check('reconnect restores the spy role', after.view.amSpy === true);

// --- bad token is refused (a real socket, since undici blocks manual Upgrade) ---
const badToken = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:8787/ws?code=${code}&pid=${seats[0].pid}&tok=deadbeef`);
  ws.addEventListener('open', () => { ws.close(); resolve('opened'); });
  ws.addEventListener('error', () => resolve('refused'));
  setTimeout(() => resolve('timeout'), 3000);
});
check('a wrong seat token is refused', badToken === 'refused', `got ${badToken}`);

const unknownSeat = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:8787/ws?code=${code}&pid=nobody&tok=nothing`);
  ws.addEventListener('open', () => { ws.close(); resolve('opened'); });
  ws.addEventListener('error', () => resolve('refused'));
  setTimeout(() => resolve('timeout'), 3000);
});
check('an unknown seat is refused', unknownSeat === 'refused', `got ${unknownSeat}`);

// --- room locks once started ---
check('cannot join a game in progress', (await post('/api/join', { code, name: 'Late' })).status === 409);

// --- oversized frames are rejected ---
inbox[1].length = 0;
sockets[1].send(JSON.stringify({ t: 'action', action: { type: 'ack' }, pad: 'x'.repeat(5000) }));
await new Promise((r) => setTimeout(r, 300));
check('oversized frame closes the socket', sockets[1].readyState === WebSocket.CLOSED || sockets[1].readyState === WebSocket.CLOSING);

for (const ws of sockets) { try { ws.close(); } catch {} }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);
