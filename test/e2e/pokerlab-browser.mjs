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
// The board is not rendered preflop — five empty slots is 280px of nothing
// on the most valuable part of the screen. Wait for your own cards instead.
await page.waitForSelector('.pokerhand', { timeout: 15000 });

// -------------------------------------------------------------- the deal ---

check('no empty board is drawn before the flop',
  (await page.locator('.pokerboard').count()) === 0,
  'five empty card slots preflop is 280px of nothing');
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

// -------------------------------------------------- while you decide -------

// In learn mode the screen carries what a real table carries and one more
// thing: the NAME of the idea being tested. Not the answer — feedback only
// reliably helps when the learner attempted the problem first, and a screen
// that shows the solution first trains reading a dashboard rather than
// playing poker.
const prompt = page.locator('.labprompt');
check('the drill names the idea being tested', (await prompt.count()) === 1);
if (await prompt.count()) {
  const t = await prompt.innerText();
  check('and it is a named concept', /[A-Za-z]{4,}/.test(t), t);
  check('but it does not give the answer away',
    !/%|bb|fold|call|raise|check/i.test(t.replace(/this decision/i, '')), t);
}
check('no numbers panel is shown before you act',
  (await page.locator('.labhero').count()) === 0
  && (await page.locator('.labfeed').count()) === 0);

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
  const feed = page.locator('.labfeed');
  check('the feedback block appears after the hand', (await feed.count()) >= 1);
  if (await feed.count()) {
    const t = await feed.innerText();
    check('it leads with a grade band', /Optimal|Fine|Slight leak|Mistake|Blunder/.test(t), t.slice(0, 80));
    check('it explains in words before it shows a bar', /[a-z]{4,}\s+[a-z]{4,}/.test(t));
    check('it names the concept', (await feed.locator('.lablesson__tag').count()) >= 1);
    check('it prices every line as a bar', (await feed.locator('.labbar').count()) >= 2);
    check('exactly one line is marked best', (await feed.locator('.labbar.is-best').count()) === 1);
    check('and the line you took is marked', (await feed.locator('.labbar.is-chosen').count()) >= 1);
    // Level two of two, and never more.
    check('the numbers are behind one tap', (await feed.locator('.labmore').count()) === 1);
    check('and are collapsed until asked',
      !(await feed.locator('.labmore[open]').count()));
    await feed.locator('.labmore__sum').click();
    await page.waitForTimeout(300);
    check('tapping opens them in place', (await feed.locator('.labfact').count()) >= 2);
  }

  // Promise 3, and the one the whole design hangs on: the grade lands BEFORE
  // the cards do. If the runout is already on screen when the feedback
  // arrives, the student learns from the result instead of the decision.
  const screen = await page.locator('.flow').innerText();
  const graded = /Optimal|Fine|Slight leak|Mistake|Blunder/.test(screen);
  const revealBtn = page.locator('.bar--bottom button', { hasText: /Their cards/i });
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
  /bb lost/i.test(scoreText) && !/\/ 100/.test(scoreText), scoreText.slice(0, 200));

// ------------------------------------------------------------- the shell ---

const scroll = await page.evaluate(() => {
  const flow = document.querySelector('.flow');
  if (!flow) return { ok: false, body: false, why: 'no .flow element' };
  // Reset first. Asserting that setting scrollTop CHANGES it silently passes
  // only from the top of the page — if an earlier interaction already scrolled
  // us to the bottom, the assignment is a no-op and a perfectly scrollable
  // pane reports as stuck.
  flow.scrollTop = 0;
  flow.scrollTop = 9999;
  const scrolled = flow.scrollTop > 0;
  const fits = flow.scrollHeight <= flow.clientHeight + 1;
  return {
    ok: scrolled || fits,
    body: document.body.scrollHeight > window.innerHeight + 1,
    why: `scrollH ${flow.scrollHeight} clientH ${flow.clientHeight} reached ${flow.scrollTop}`,
  };
});
check('the lab screen scrolls or fits', scroll.ok, scroll.why);
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
