/**
 * Cheat, driven through the real UI at phone size.
 *
 * The checks that matter: can anyone see a card that isn't theirs, is the
 * face-down play genuinely face down, does a half-built play survive a
 * re-render, and does the whole loop — claim, call, pick up — actually run.
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
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error p${i}] ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console p${i}] ${m.text()}`); });
  pages.push(page);
}
const [host, ...rest] = pages;

await host.goto(`${BASE}/`);
await host.waitForSelector('.gametile');
const tiles = await host.locator('.gametile').allInnerTexts();
check('cheat is on the home screen', tiles.some((t) => /Cheat/.test(t)), tiles.join('|').slice(0, 160));
check('and names what people call it', tiles.some((t) => /BS/.test(t)));

await host.locator('.gametile', { hasText: 'Cheat' }).click();
await host.fill('#startbar-name', 'Ana');
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.roomcode', { timeout: 15000 });
const code = (await host.locator('.roomcode__cells').innerText()).replace(/\s/g, '');

for (const [i, name] of ['Ben', 'Cleo', 'Dev'].entries()) {
  await rest[i].goto(`${BASE}/${code}`);
  await rest[i].waitForSelector('#name');
  await rest[i].fill('#name', name);
  await rest[i].locator('.bar--bottom .btn--primary').click();
  await rest[i].waitForSelector('.roomcode', { timeout: 15000 });
}
await host.waitForFunction(() => document.querySelectorAll('.ptile').length >= 4, { timeout: 15000 });
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.cheathand', { timeout: 15000 });

// ------------------------------------------------------------------ the deal

const handSizes = await Promise.all(pages.map((p) => p.locator('.cheathand .cheatcard').count()));
check('everyone is dealt a hand', handSizes.every((n) => n === 13), handSizes.join(','));
check('the whole deck is out', handSizes.reduce((a, b) => a + b, 0) === 52, String(handSizes));
check('the required rank is stated', /twos/i.test(await host.locator('.flow').innerText()));
await host.screenshot({ path: `${OUT}/40-cheat-deal.png` });

// Nobody sees anyone else's cards: every named card in the document is one of
// your own, and no two players see the same card.
const seen = await Promise.all(pages.map((p) => p.evaluate(() =>
  [...document.querySelectorAll('.cheathand .pcard[aria-label]')].map((n) => n.getAttribute('aria-label')))));
const flat = seen.flat();
check('no card is visible to two players', new Set(flat).size === flat.length,
  `${flat.length - new Set(flat).size} duplicated`);
const stray = await host.evaluate(() => {
  const mine = new Set([...document.querySelectorAll('.cheathand .pcard[aria-label]')].map((n) => n.getAttribute('aria-label')));
  return [...document.querySelectorAll('.pcard[aria-label]')]
    .map((n) => n.getAttribute('aria-label'))
    .filter((c) => !mine.has(c));
});
check('no face-up card exists outside your own hand', stray.length === 0, stray.join(', '));

// ------------------------------------------------------------------ a claim

// The on-turn button is deliberately DISABLED until cards are picked, so this
// matches on what the bar says rather than on whether it is clickable.
const onTurn = async () => {
  for (const p of pages) {
    const t = await p.locator('.bar--bottom').innerText();
    if (/pick cards|play \d/i.test(t)) return p;
  }
  return null;
};
const player = await onTurn();
check('exactly one player is on turn', player !== null);

if (player) {
  const cta = await player.locator('.bar--bottom .btn--primary').innerText();
  check('the button says what will be claimed', /twos/i.test(cta), cta);
  check('and is disabled until cards are picked',
    await player.locator('.bar--bottom .btn--primary').isDisabled());

  await player.locator('.cheatcard').nth(0).click();
  await player.locator('.cheatcard').nth(1).click();
  const cta2 = await player.locator('.bar--bottom .btn--primary').innerText();
  check('the button counts what you picked', /play 2 as twos/i.test(cta2), cta2);
  check('picked cards are visibly lifted', (await player.locator('.cheatcard.is-picked').count()) === 2);

  // A fifth card must be refused with a reason, not silently dropped.
  for (const n of [2, 3, 4]) await player.locator('.cheatcard').nth(n).click();
  await player.waitForTimeout(300);
  check('four cards is the cap', (await player.locator('.cheatcard.is-picked').count()) === 4);
  check('and the fifth tap explains itself', Boolean(await player.locator('.toast').first().boundingBox().catch(() => null)));
  await player.locator('.cheatcard.is-picked').nth(3).click();

  // A half-built play must survive an unrelated broadcast.
  const bystander = pages.find((p) => p !== player);
  await bystander.reload();
  await bystander.waitForSelector('.cheathand', { timeout: 15000 });
  await player.waitForTimeout(900);
  check('a half-built play survives someone reconnecting',
    (await player.locator('.cheatcard.is-picked').count()) === 3,
    `${await player.locator('.cheatcard.is-picked').count()} still picked`);
  await player.screenshot({ path: `${OUT}/41-cheat-picking.png` });

  await player.locator('.bar--bottom .btn--primary').click();
  await player.waitForTimeout(900);
}

// ------------------------------------------------------------ the challenge

const claimText = await host.locator('.flow').innerText();
check('everyone sees the claim', /says/i.test(claimText) && /twos/i.test(claimText), claimText.replace(/\n/g, ' | ').slice(0, 160));
const faceDown = await host.evaluate(() => document.querySelectorAll('.pcard--back').length);
check('the played cards are face down', faceDown >= 3, `${faceDown} backs`);

const caller = pages.find((p) => p !== player) ?? rest[0];
const callBar = await caller.locator('.bar--bottom').innerText();
check('others are offered the call', /cheat/i.test(callBar), callBar.replace(/\n/g, ' | '));
check('and the option to let it go', /let it go/i.test(callBar), callBar.replace(/\n/g, ' | '));
// A wrapped label is a label nobody reads under a 15-second clock.
{
  // Line boxes via a Range over the text, not height/lineHeight — button
  // padding makes the arithmetic version report a wrap that isn't there.
  const lines = await caller.locator('.bar--bottom .btn--secondary').evaluate((n) => {
    const r = document.createRange();
    r.selectNodeContents(n);
    return r.getClientRects().length;
  });
  check('both call buttons fit on one line', lines <= 1, `${lines} lines`);
}
// The face-down cards must actually look face down, not blank.
{
  const back = await caller.locator('.pcard--back').first().evaluate((n) => {
    const s = getComputedStyle(n);
    return { colour: s.backgroundColor, image: s.backgroundImage };
  });
  check('card backs are opaque', !/rgba\(0, 0, 0, 0\)|transparent/.test(back.colour), back.colour);
  check('and patterned', /gradient/.test(back.image), back.image.slice(0, 40));
}
const callBox = await caller.locator('.bar--bottom .btn--danger').boundingBox();
check('the call button is thumb-sized', callBox.height >= 44, `${Math.round(callBox.height)}px`);
await caller.screenshot({ path: `${OUT}/42-cheat-challenge.png` });

await caller.locator('.bar--bottom .btn--danger').click();
await host.waitForTimeout(1000);
const verdict = await host.locator('.flow').innerText();
check('the call resolves with a verdict', /was lying|it was true/i.test(verdict), verdict.replace(/\n/g, ' | ').slice(0, 200));
check('and says who picks the pile up', /takes \d+/i.test(verdict), verdict.replace(/\n/g, ' | ').slice(0, 200));

// The cards must now be face UP for everyone, not just the caller.
for (const [i, p] of pages.entries()) {
  const shown = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.card')].find((n) => /says/i.test(n.innerText));
    return card ? card.querySelectorAll('.pcard[aria-label]').length : 0;
  });
  check(`p${i} sees the turned-over cards`, shown >= 3, `${shown} face up`);
}
await host.screenshot({ path: `${OUT}/43-cheat-reveal.png` });

// -------------------------------------------------------------- the shell --

const layout = await host.evaluate(() => ({
  wide: document.documentElement.scrollWidth > window.innerWidth + 1,
  bodyScrolls: document.body.scrollHeight > window.innerHeight + 1,
}));
check('no horizontal overflow', !layout.wide);
check('the page body never scrolls', !layout.bodyScrolls);

{
  const narrow = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const np = await narrow.newPage();
  await np.goto(`${BASE}/${code}`);
  await np.waitForTimeout(1600);
  check('thirteen cards fit a 320px phone',
    !(await np.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await np.screenshot({ path: `${OUT}/44-cheat-320.png` });
  await narrow.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall cheat checks passed');
process.exit(failures ? 1 : 0);
