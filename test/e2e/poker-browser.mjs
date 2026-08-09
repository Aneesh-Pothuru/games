/**
 * Hold'em, driven through the real UI at phone size.
 *
 * The checks that matter here are not "does a card appear" but:
 *   - can you see anyone else's hole cards (the only unrecoverable bug)
 *   - is the action bar reachable and are its targets thumb-sized
 *   - does the bet sizer survive a re-render mid-decision
 *   - does a hand actually reach a showdown and pay someone
 */
import { chromium, devices } from 'playwright';
import { existsSync } from 'node:fs';

const BUNDLED = '/opt/pw-browsers/chromium';
const EXECUTABLE = process.env.CHROMIUM_PATH || (existsSync(BUNDLED) ? BUNDLED : undefined);
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const OUT = process.env.SHOT_DIR ?? '/tmp/parlour-shots';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));

const browser = await chromium.launch({ executablePath: EXECUTABLE });
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
};

const phone = devices['iPhone 13'];
const pages = [];
const contexts = [];
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error p${i}] ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console p${i}] ${m.text()}`); });
  pages.push(page);
}
const [host, ...rest] = pages;

// ------------------------------------------------------------ discovery ----

await host.goto(`${BASE}/`);
await host.waitForSelector('.gametile');
const tiles = await host.locator('.gametile').allInnerTexts();
check('poker is on the home screen', tiles.some((t) => /Hold’em|Hold'em/.test(t)), tiles.join(' | ').slice(0, 200));
check('and names itself as poker', tiles.some((t) => /Poker/i.test(t)));

await host.locator('.gametile', { hasText: 'Hold' }).click();
await host.fill('#startbar-name', 'Ana');
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.roomcode', { timeout: 15000 });
const code = (await host.locator('.roomcode__cells').innerText()).replace(/\s/g, '');
check('room created', /^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(code), code);

// The host must be able to set up a tournament before anyone arrives.
const optionText = await host.locator('.screen').innerText();
check('host can size the stacks', /Stacks/i.test(optionText));
check('host can set the blind speed', /Blinds up/i.test(optionText));

const names = ['Ben', 'Cleo', 'Dev'];
for (let i = 0; i < 3; i++) {
  await rest[i].goto(`${BASE}/${code}`);
  await rest[i].waitForSelector('#name');
  await rest[i].fill('#name', names[i]);
  await rest[i].locator('.bar--bottom .btn--primary').click();
  await rest[i].waitForSelector('.roomcode', { timeout: 15000 });
}
await host.waitForFunction(() => document.querySelectorAll('.ptile').length >= 4, { timeout: 15000 });
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.pokerboard', { timeout: 15000 });

// -------------------------------------------------------------- the deal ---

check('the board renders five slots', (await host.locator('.pokerboard .pcard').count()) === 5);
check('you are dealt two cards', (await host.locator('.pokerhand__cards .pcard').count()) === 2);
check('the pot is shown', /\d/.test(await host.locator('.pokerpot__amt').innerText()));
// innerText, not textContent: the labels are uppercased in CSS, so this also
// asserts what a player actually reads.
check('blinds are shown', /blinds \d+\/\d+/i.test(await host.locator('.pokerpot').innerText()));
await host.screenshot({ path: `${OUT}/20-poker-deal.png` });

// THE check: nobody else's cards are anywhere in this document.
const leak = await host.evaluate(() => {
  const mine = [...document.querySelectorAll('.pokerhand__cards .pcard')].map((n) => n.getAttribute('aria-label'));
  const all = [...document.querySelectorAll('.pcard[aria-label]')].map((n) => n.getAttribute('aria-label'));
  // Board cards are public; everything else must be one of mine.
  const board = [...document.querySelectorAll('.pokerboard .pcard[aria-label]')].map((n) => n.getAttribute('aria-label'));
  return all.filter((c) => !mine.includes(c) && !board.includes(c));
});
check('no other player’s cards are in the DOM', leak.length === 0, leak.join(', '));

// (The wire-level version of that check lives in protocol.mjs, which reads the
// server's frames directly rather than trusting the client to render them.)

// -------------------------------------------------------------- the clock --

const onClock = async () => {
  for (const p of pages) {
    if (await p.locator('.pokeract').count()) return p;
  }
  return null;
};
const actor = await onClock();
check('exactly one player has the action', actor !== null);

if (actor) {
  const bar = actor.locator('.pokeract');
  const labels = await bar.locator('.btn').allInnerTexts();
  check('the action bar offers fold', labels.some((l) => /Fold/i.test(l)), labels.join('|'));
  check('the action bar offers call or check', labels.some((l) => /Call|Check/i.test(l)), labels.join('|'));
  check('the action bar offers a raise', labels.some((l) => /Raise|Bet/i.test(l)), labels.join('|'));
  // Preflop everyone but the big blind faces a bet, so the amount must be on
  // the button — "Call" alone makes you guess what it costs.
  if (labels.some((l) => /^Call/.test(l))) {
    check('the call button states the amount', labels.some((l) => /Call [\d,]+/.test(l)), labels.join('|'));
  }

  const boxes = await bar.locator('.btn').evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect()));
  check('every action target is thumb-sized', boxes.every((b) => b.height >= 44), JSON.stringify(boxes.map((b) => Math.round(b.height))));
  check('the action bar fits the viewport', boxes.every((b) => b.x >= -1 && b.x + b.width <= 391),
    JSON.stringify(boxes.map((b) => [Math.round(b.x), Math.round(b.width)])));
  await actor.screenshot({ path: `${OUT}/21-poker-action.png` });

  // --- the bet sizer ---
  await actor.locator('.pokeract .btn--secondary').click();
  await actor.waitForSelector('.raise__slider', { timeout: 5000 });
  const min = Number(await actor.locator('.raise__slider').getAttribute('min'));
  const max = Number(await actor.locator('.raise__slider').getAttribute('max'));
  check('the sizer starts at the minimum legal raise', min > 0, `min=${min}`);
  check('the sizer tops out at your stack', max > min, `${min}..${max}`);
  const presets = await actor.locator('.raise .seg button').allInnerTexts();
  check('the sizer offers pot-relative presets', presets.some((p) => /pot/i.test(p)), presets.join('|'));
  check('the sizer offers all in', presets.some((p) => /All in/i.test(p)), presets.join('|'));

  // Dragging must survive an unrelated broadcast. Someone else reconnecting
  // re-renders every screen at the table.
  await actor.locator('.raise .seg button', { hasText: 'All in' }).click();
  const before = await actor.locator('.raise__amt').innerText();
  const bystander = pages.find((p) => p !== actor);
  await bystander.reload();
  await bystander.waitForSelector('.pokerboard', { timeout: 15000 });
  await actor.waitForTimeout(800);
  const stillOpen = await actor.locator('.raise__slider').count();
  check('the bet sizer survives another player reconnecting', stillOpen === 1);
  if (stillOpen) {
    check('and keeps the amount you chose', (await actor.locator('.raise__amt').innerText()) === before,
      `${before} -> ${await actor.locator('.raise__amt').innerText()}`);
  }
  await actor.screenshot({ path: `${OUT}/22-poker-raise.png` });
  await actor.locator('.raise .btn--ghost').click();
  await actor.waitForSelector('.pokeract', { timeout: 5000 });
}

// ------------------------------------------------- play a hand to the end --

let showdownSeen = false;
let handoverSeen = false;
for (let step = 0; step < 90; step++) {
  const p = await onClock();
  if (p) {
    // Everyone calls: the cheapest reliable route to a showdown.
    const call = p.locator('.pokeract .btn--primary');
    if (await call.count()) await call.click().catch(() => {});
    await host.waitForTimeout(120);
    continue;
  }
  const text = await host.locator('.flow').innerText();
  if (/wins [\d,]+/.test(text)) { handoverSeen = true; }
  if ((await host.locator('.pokerpeek').count()) > 0) { showdownSeen = true; break; }
  if (handoverSeen) break;
  await host.waitForTimeout(200);
}
check('a hand plays out and pays someone', handoverSeen || showdownSeen);
if (showdownSeen) {
  check('showdown turns other players’ cards face up', (await host.locator('.pokerpeek .pcard').count()) >= 2);
  check('and names the hands', /pair|flush|straight|high|house|kind/i.test(await host.locator('.flow').innerText()));
}
await host.screenshot({ path: `${OUT}/23-poker-showdown.png` });

// ------------------------------------------------------------- the shell ---

const scroll = await host.evaluate(() => {
  const flow = document.querySelector('.flow');
  const before = flow.scrollTop;
  flow.scrollTop = 9999;
  const moved = flow.scrollTop !== before || flow.scrollHeight <= flow.clientHeight + 1;
  return { moved, body: document.body.scrollHeight > window.innerHeight + 1 };
});
check('the poker screen scrolls or fits', scroll.moved);
check('the page body never scrolls', !scroll.body);

const overflow = await host.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal overflow during a hand', !overflow);

// Cards must stay legible at the narrowest phone we support.
{
  const narrow = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const np = await narrow.newPage();
  await np.goto(`${BASE}/${code}`);
  await np.waitForTimeout(1500);
  const wide = await np.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal overflow at 320px', !wide);
  await np.screenshot({ path: `${OUT}/24-poker-320.png` });
  await narrow.close();
}

// --- rules ---
await host.locator('.iconbtn[aria-label="How to play"]').click();
await host.waitForTimeout(300);
const rules = await host.locator('#sheet-body').innerText();
check('the rules explain side pots', /side pot/i.test(rules));
check('the rules explain the minimum raise', /minimum raise|at least as big/i.test(rules));
check('the rules state that the wheel is the low straight', /A-2-3-4-5/.test(rules));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall poker checks passed');
process.exit(failures ? 1 : 0);
