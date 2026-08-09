/**
 * The Lab, driven through the real UI on a phone.
 *
 * This is a solo game, so the whole thing runs in one browser context — which
 * makes it the cheapest end-to-end suite in the project and the one most worth
 * running. What it checks, in rough order of how bad the bug would be:
 *
 *   1. a single player can actually start it (the lobby's minimum is 1)
 *   2. no bot's hole cards are anywhere in the DOM during a hand
 *   3. the grade lands BEFORE the runout is revealed
 *   4. the coach shows numbers, and distinguishes exact ones from estimates
 *   5. the bots act on their own, so the table never waits on nobody
 *   6. it fits a phone and does not scroll sideways
 */
import { devices } from 'playwright';
import { BASE, launchBrowser } from './launch.mjs';

const OUT = process.env.SHOT_DIR ?? '/tmp/parlour-shots';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));

const browser = await launchBrowser();
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
};

const phone = devices['iPhone 13'];
const ctx = await browser.newContext({ ...phone, hasTouch: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => { console.log(`  [js error] ${e.message}`); failures++; });
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${m.text()}`); });

// ------------------------------------------------------------ discovery ----

await page.goto(`${BASE}/`);
await page.waitForSelector('.gametile');
const tiles = await page.locator('.gametile').allInnerTexts();
check('the Lab is on the home screen', tiles.some((t) => /The Lab/i.test(t)), tiles.join(' | ').slice(0, 300));
check('and says it is a poker trainer', tiles.some((t) => /Poker trainer/i.test(t)));

// By id: text matching across a growing home screen is how e2e suites rot.
await page.locator('.gametile[data-game="pokerlab"]').click();
await page.fill('#startbar-name', 'Ana');
await page.locator('.bar--bottom .btn--primary').click();
await page.waitForSelector('.roomcode', { timeout: 15000 });

// A solo game must be startable alone. Anything that makes you wait for a
// second player here is a dead end, and it is the single most common way a
// solo mode ships broken.
const lobbyText = await page.locator('.screen').innerText();
check('the host can choose the table', /Table/i.test(lobbyText), lobbyText.slice(0, 200));
check('and can turn the coach off', /Coach/i.test(lobbyText));
await page.screenshot({ path: `${OUT}/40-lab-lobby.png` });

const startBtn = page.locator('.bar--bottom .btn--primary');
check('the start button is enabled with one player', await startBtn.isEnabled());
await startBtn.click();
await page.waitForSelector('.pokerboard', { timeout: 15000 });

// -------------------------------------------------------------- the deal ---

check('the board renders five slots', (await page.locator('.pokerboard .pcard').count()) === 5);
check('you are dealt two cards', (await page.locator('.pokerhand__cards .pcard').count()) === 2);

const seatCount = await page.locator('.ptile').count();
check('bots filled the empty seats', seatCount >= 3, `${seatCount} seats`);

// THE check. A trainer that leaks the bots' cards teaches nothing at all,
// because every decision you make is made with information you would not have.
const leak = await page.evaluate(() => {
  const label = (n) => n.getAttribute('aria-label');
  const mine = [...document.querySelectorAll('.pokerhand__cards .pcard')].map(label);
  const board = [...document.querySelectorAll('.pokerboard .pcard[aria-label]')].map(label);
  return [...document.querySelectorAll('.pcard[aria-label]')]
    .map(label)
    .filter((c) => !mine.includes(c) && !board.includes(c));
});
check('no bot’s cards are in the DOM during the hand', leak.length === 0, leak.join(', '));
await page.screenshot({ path: `${OUT}/41-lab-deal.png` });

// ------------------------------------------------------------ the bots act -

// Nobody else is here to press anything, so if the table ever sits on a bot's
// turn without advancing, the game is over for the player.
const waitForMyTurn = async (ms = 25000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.locator('.pokeract').count()) return true;
    if (/Next hand/i.test(await page.locator('.bar--bottom').innerText().catch(() => ''))) return true;
    await page.waitForTimeout(200);
  }
  return false;
};
check('the table reaches your decision without another human', await waitForMyTurn());

// ---------------------------------------------------------------- the coach -

const coach = page.locator('.coach');
let sawCoach = false;
if (await coach.count()) {
  sawCoach = true;
  const text = await coach.innerText();
  check('the coach quotes your equity', /equity/i.test(text), text.slice(0, 200));
  check('the coach quotes a percentage', /\d+\.\d%/.test(text), text.slice(0, 200));
  check('the coach names a recommended line', /fold|check|call|raise/i.test(
    await coach.locator('.coach__call').innerText(),
  ));

  const facts = await coach.locator('.coach__fact').count();
  check('the coach shows several facts, not one number', facts >= 2, `${facts} facts`);

  // Promise 2: an estimate must look different from arithmetic. Preflop the
  // equity is sampled and carries an error bar; the price never does.
  const estimated = await coach.locator('.coach__val.is-estimate').count();
  const hasErrorBar = /±/.test(text);
  check('a sampled number is marked as an estimate and shows its bar',
    estimated === 0 || hasErrorBar, `estimated=${estimated} bar=${hasErrorBar}`);

  const opts = await coach.locator('.coach__opt').count();
  check('every line is priced in big blinds', opts >= 2, `${opts} options`);
  const evText = await coach.locator('.coach__ev').first().innerText();
  check('and the price is a signed bb figure', /^[+-]?\d+\.\d\dbb$/.test(evText), evText);

  const best = await coach.locator('.coach__opt.is-best').count();
  check('exactly one line is marked best', best === 1, `${best} marked`);
  await page.screenshot({ path: `${OUT}/42-lab-coach.png` });
}
check('the coach panel appeared at all', sawCoach);

// ------------------------------------------------- act, and get graded ------

const actBar = page.locator('.pokeract');
if (await actBar.count()) {
  const labels = await actBar.locator('.btn').allInnerTexts();
  check('the action bar offers fold', labels.some((l) => /Fold/i.test(l)), labels.join('|'));
  check('the action bar offers call or check', labels.some((l) => /Call|Check/i.test(l)), labels.join('|'));
  const boxes = await actBar.locator('.btn').evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect()));
  check('every action target is thumb-sized', boxes.every((b) => b.height >= 44),
    JSON.stringify(boxes.map((b) => Math.round(b.height))));

  await actBar.locator('.btn--primary').click();
  await page.waitForTimeout(600);
}

// Play on until the hand ends, always taking the cheapest legal action.
let handover = false;
for (let step = 0; step < 120; step++) {
  if (/Next hand/i.test(await page.locator('.bar--bottom').innerText().catch(() => ''))) {
    handover = true;
    break;
  }
  const primary = page.locator('.pokeract .btn--primary');
  if (await primary.count()) {
    await primary.click().catch(() => {});
    await page.waitForTimeout(150);
    continue;
  }
  await page.waitForTimeout(200);
}
check('a hand plays to the end against the bots', handover);

if (handover) {
  // Promise 3, and the one the whole design hangs on: the grade lands BEFORE
  // the cards do. If the runout is already on screen when the feedback
  // arrives, the student learns from the result instead of the decision.
  const screen = await page.locator('.flow').innerText();
  const graded = /Solid|Slightly off|Mistake|Blunder|Either was fine/.test(screen);
  const revealBtn = page.locator('.bar--bottom .btn--secondary', { hasText: /Show me what they had/i });
  const stillHidden = (await revealBtn.count()) === 1;

  check('a grade is shown after the hand', graded, screen.slice(0, 300));
  check('the bots’ cards are still face down when it is shown', stillHidden);

  const leakAtHandover = await page.evaluate(() => {
    const label = (n) => n.getAttribute('aria-label');
    const mine = [...document.querySelectorAll('.pokerhand__cards .pcard')].map(label);
    const board = [...document.querySelectorAll('.pokerboard .pcard[aria-label]')].map(label);
    return [...document.querySelectorAll('.pcard[aria-label]')].map(label)
      .filter((c) => !mine.includes(c) && !board.includes(c));
  });
  check('and nothing has leaked them early', leakAtHandover.length === 0, leakAtHandover.join(', '));
  await page.screenshot({ path: `${OUT}/43-lab-grade.png` });

  if (stillHidden) {
    await revealBtn.click();
    await page.waitForTimeout(500);
    const shown = await page.locator('.pokerpeek .pcard').count();
    check('asking to see their cards actually shows them', shown >= 2, `${shown} cards`);
    await page.screenshot({ path: `${OUT}/44-lab-reveal.png` });
  }

  // Who you are playing, and why it matters — the seat cards.
  const tells = await page.locator('.card .log li').allInnerTexts();
  check('each opponent’s habit is written down', tells.length >= 2, tells.join(' | ').slice(0, 200));

  await page.locator('.bar--bottom .btn--primary', { hasText: /Next hand/i }).click();
  await page.waitForTimeout(800);
  const reHidden = (await page.locator('.pokerpeek .pcard').count()) === 0;
  check('the next hand hides their cards again', reHidden);
}

// ------------------------------------------------------------- the score ---

const scoreText = await page.locator('.flow').innerText();
check('the running score is shown', /decisions?/i.test(scoreText), scoreText.slice(0, 200));
// Under twenty decisions it must show the running TOTAL, not extrapolate a
// per-100 rate out of five samples.
check('and it does not extrapolate a rate from a handful of decisions',
  /bb lost so far/i.test(scoreText), scoreText.slice(0, 200));

// ------------------------------------------------------------- the shell ---

const scroll = await page.evaluate(() => {
  const flow = document.querySelector('.flow');
  const before = flow.scrollTop;
  flow.scrollTop = 9999;
  return {
    moved: flow.scrollTop !== before || flow.scrollHeight <= flow.clientHeight + 1,
    body: document.body.scrollHeight > window.innerHeight + 1,
  };
});
check('the lab screen scrolls or fits', scroll.moved);
check('the page body never scrolls', !scroll.body);
check('no horizontal overflow', !(await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth + 1,
)));

// The coach panel is dense. It has to survive the narrowest phone we support.
{
  const narrow = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const np = await narrow.newPage();
  await np.goto(page.url());
  await np.waitForTimeout(1800);
  const wide = await np.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no horizontal overflow at 320px', !wide);
  await np.screenshot({ path: `${OUT}/45-lab-320.png` });
  await narrow.close();
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
