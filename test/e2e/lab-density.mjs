/**
 * The density budget.
 *
 * A coaching screen fails in a way no functional test catches: everything
 * works, and the learner still cannot read it. The first version of the Lab
 * put 168 words and seven competing type sizes on one decision, spread over
 * 2.97 screens, with the coaching entirely below the fold — so you chose your
 * action without ever seeing the advice. Every check here is a number that
 * would have caught that.
 *
 * The budgets come from research rather than taste:
 *   - people read about 20% of the words on a page, so a decision screen that
 *     needs 168 of them is not being read (Nielsen, "How Little Do Users
 *     Read?")
 *   - the thing you must see and the control you press must be co-visible;
 *     content below the fold gets a fraction of the attention
 *   - a type scale with seven active sizes has no hierarchy, because hierarchy
 *     is contrast and everything is contrasting with everything
 *
 * Run at three widths, because 320px is where dense layouts break and 430px is
 * where they get complacent.
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

/** The budgets. Each is a claim about attention, not about taste. */
const BUDGET = {
  decisionWords: 70,      // what you read while choosing
  feedbackWords: 130,     // after choosing you are willing to read more
  typeSizes: 6,           // distinct font sizes in one view
  bottomBar: 0.18,        // share of viewport the action bar may occupy
  minTap: 44,             // HIG 44pt / WCAG 2.5.5
};

/** Everything measurable about the current view. */
const measure = (page) => page.evaluate(() => {
  const flow = document.querySelector('.flow');
  const bar = document.querySelector('.bar--bottom');
  const text = (flow?.innerText ?? '').trim();
  // Only elements that actually SET type: a leaf with its own text, and not a
  // playing card. A card's rank is an illustration sized in container units —
  // counting it as a type size makes the metric measure the deck rather than
  // the hierarchy. Containers are excluded too; they merely inherit the body
  // size and would inflate the count without ever putting a word on screen.
  const sizes = [...document.querySelectorAll('.flow *')]
    .filter((n) => !n.closest('.pcard'))
    .filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
    .map((n) => parseFloat(getComputedStyle(n).fontSize))
    .filter((n) => n > 0);

  return {
    viewport: [window.innerWidth, window.innerHeight],
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    screens: flow ? +(flow.scrollHeight / flow.clientHeight).toFixed(2) : 0,
    typeSizes: new Set(sizes.map((s) => s.toFixed(1))).size,
    barHeight: Math.round(bar?.getBoundingClientRect().height ?? 0),
    taps: [...document.querySelectorAll('.bar--bottom button, .pokeract button')]
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { t: (n.innerText || '').slice(0, 14), h: Math.round(r.height), w: Math.round(r.width) };
      }),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    // Is the primary teaching element visible without scrolling? That is the
    // whole question — advice you have to scroll to is advice you act without.
    coachAboveFold: (() => {
      const c = document.querySelector('[data-teach]');
      if (!c || !flow) return null;
      const r = c.getBoundingClientRect();
      const f = flow.getBoundingClientRect();
      return r.top >= f.top - 1 && r.top < f.bottom;
    })(),
  };
});

const widths = [
  ['320', { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true }],
  ['390', { ...devices['iPhone 13'], hasTouch: true }],
  ['430', { viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true }],
];

for (const [label, device] of widths) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error @${label}] ${e.message}`); failures++; });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');
  await page.locator('.gametile[data-game="pokerlab"]').click();
  await page.fill('#startbar-name', 'Ana');
  await page.locator('.bar--bottom .btn--primary').click();
  await page.waitForSelector('.roomcode', { timeout: 20000 });
  await page.locator('.bar--bottom .btn--primary').click();
  await page.waitForSelector('.pokerhand', { timeout: 20000 });

  // --- the decision moment ---
  for (let i = 0; i < 150 && !(await page.locator('.pokeract').count()); i++) {
    await page.waitForTimeout(200);
  }
  const d = await measure(page);
  await page.screenshot({ path: `${OUT}/den-${label}-decide.png` });

  check(`${label} decision fits the reading budget`, d.words <= BUDGET.decisionWords,
    `${d.words} words (budget ${BUDGET.decisionWords})`);
  check(`${label} decision has a type hierarchy`, d.typeSizes <= BUDGET.typeSizes,
    `${d.typeSizes} distinct sizes`);
  check(`${label} the coaching is visible while you decide`, d.coachAboveFold !== false,
    'the teaching element is below the fold');
  check(`${label} the action bar leaves room for the lesson`,
    d.barHeight <= d.viewport[1] * BUDGET.bottomBar,
    `${d.barHeight}px of ${d.viewport[1]}px`);
  check(`${label} every action is reachable`, d.taps.every((t) => t.h >= BUDGET.minTap),
    JSON.stringify(d.taps));
  check(`${label} no horizontal overflow while deciding`, !d.overflowX);

  // --- the feedback moment ---
  for (let step = 0; step < 150; step++) {
    if (/Next hand/i.test(await page.locator('.bar--bottom').innerText().catch(() => ''))) break;
    // The table holds after every graded decision. Acknowledging is part of
    // playing the game now.
    const ack = page.locator('.bar--bottom .btn--primary', { hasText: /^Got it$/ });
    if (await ack.count()) {
      await ack.click().catch(() => {});
      await page.waitForTimeout(120);
      continue;
    }
    const primary = page.locator('.pokeract .btn--primary');
    if (await primary.count()) {
      await primary.click().catch(() => {});
      await page.waitForTimeout(150);
      continue;
    }
    await page.waitForTimeout(200);
  }
  const f = await measure(page);
  await page.screenshot({ path: `${OUT}/den-${label}-feedback.png` });

  check(`${label} feedback fits its budget`, f.words <= BUDGET.feedbackWords,
    `${f.words} words (budget ${BUDGET.feedbackWords})`);
  check(`${label} feedback has a type hierarchy`, f.typeSizes <= BUDGET.typeSizes,
    `${f.typeSizes} distinct sizes`);
  check(`${label} no horizontal overflow in feedback`, !f.overflowX);
  check(`${label} the feedback bar is not a wall of buttons`,
    f.barHeight <= f.viewport[1] * BUDGET.bottomBar,
    `${f.barHeight}px of ${f.viewport[1]}px`);

  console.log(`     ${label}: decide ${d.words}w/${d.screens} screens/${d.typeSizes} sizes`
    + ` · feedback ${f.words}w/${f.screens} screens/${f.typeSizes} sizes`
    + ` · bar ${d.barHeight}→${f.barHeight}px`);

  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall density checks passed');
process.exit(failures ? 1 : 0);
