/**
 * Design-system integrity.
 *
 * CSS fails silently. An invalid value drops one declaration and everything
 * still renders — just wrong — so none of the other suites notice. Both of the
 * bugs this file exists for shipped and were caught by eye, not by a test:
 *
 *   - `linear-gradient(in oklab, 180deg, …)` puts the interpolation method in
 *     the wrong place. The whole declaration was dropped and the primary button
 *     lost its fill on every screen.
 *   - container query units used ON the container resolve against the viewport
 *     instead of the element, so a `5.5cqw` card-back frame came out 21px wide
 *     on a 46px card and swallowed the face. The matching `@container` rule for
 *     the card itself never applied at all, because a container query can only
 *     style DESCENDANTS of its container.
 *
 * So: assert computed values, in both themes, rather than assert that a
 * stylesheet was served.
 */
import { devices } from 'playwright';
import { BASE, launchBrowser } from './launch.mjs';

const browser = await launchBrowser();
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
};

const phone = devices['iPhone 13'];

for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error] ${e.message}`); failures++; });
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');

  // --- the primary action must actually be filled -------------------------
  await page.locator('.gametile').first().click();
  const btn = await page.evaluate(() => {
    const n = document.querySelector('.bar--bottom .btn--primary');
    const s = getComputedStyle(n);
    return { image: s.backgroundImage, colour: s.backgroundColor, text: s.color, shadow: s.boxShadow };
  });
  check(`${scheme}: the primary button has a real fill`,
    btn.image.includes('gradient') || btn.colour !== 'rgba(0, 0, 0, 0)', JSON.stringify(btn).slice(0, 120));
  check(`${scheme}: and a shadow`, btn.shadow !== 'none');

  // --- every game gets its own accent -------------------------------------
  const accents = await page.evaluate(() =>
    [...document.querySelectorAll('.gametile')].map((n) => ({
      game: n.dataset.game,
      accent: getComputedStyle(n).getPropertyValue('--game-accent').trim(),
    })));
  check(`${scheme}: every game declares an accent`, accents.every((a) => a.accent),
    JSON.stringify(accents.filter((a) => !a.accent)));
  check(`${scheme}: accents are distinct`, new Set(accents.map((a) => a.accent)).size === accents.length,
    JSON.stringify(accents));

  // --- hairlines are sub-pixel on a 2x+ screen ----------------------------
  const hair = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--hair').trim());
  check(`${scheme}: hairlines are sub-pixel on a retina phone`, hair === '0.5px', hair);

  await ctx.close();
}

// --- cards, measured ------------------------------------------------------
{
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');

  const card = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = `
      <span class="pcard pcard--md" id="m" data-suit="&#9824;"><span class="pcard__rank">A</span><span class="pcard__suit">&#9824;</span></span>
      <span class="pcard pcard--lg" id="l" data-suit="&#9824;"><span class="pcard__rank">A</span><span class="pcard__suit">&#9824;</span></span>
      <span class="pcard pcard--md pcard--back" id="b"></span>`;
    document.body.append(host);
    const px = (v) => parseFloat(v) || 0;
    const read = (id) => {
      const n = document.getElementById(id);
      const s = getComputedStyle(n);
      return {
        w: n.getBoundingClientRect().width,
        h: n.getBoundingClientRect().height,
        radius: px(s.borderTopLeftRadius),
        rank: px(getComputedStyle(n.querySelector('.pcard__rank') ?? n).fontSize),
        bg: s.backgroundColor,
        // Widest inset spread in the box-shadow — the card-back frame.
        frame: Math.max(0, ...[...s.boxShadow.matchAll(/(-?[\d.]+)px(?=[^,]*inset)/g)].map((m) => px(m[1]))),
        pad: px(s.paddingTop),
      };
    };
    return { md: read('m'), lg: read('l'), back: read('b') };
  });

  check('a card keeps its 2.5:3.5 proportions', Math.abs(card.md.h / card.md.w - 1.4) < 0.02,
    `${card.md.w}x${card.md.h}`);
  check('the corner radius is card-like, not pill-like',
    card.md.radius > 1 && card.md.radius < card.md.w * 0.12, `${card.md.radius}px on ${card.md.w}px`);
  check('the rank is legible at board size', card.md.rank >= 13, `${card.md.rank}px`);
  check('the big card has the biggest rank', card.lg.rank > card.md.rank,
    `lg ${card.lg.rank} vs md ${card.md.rank}`);
  check('the big card is actually padded', card.lg.pad > 2 && card.lg.pad < card.lg.w * 0.15,
    `${card.lg.pad}px`);
  // The bug: a frame sized in cqw came out 21px on a 46px card.
  check('the card back is opaque', card.back.bg !== 'rgba(0, 0, 0, 0)', card.back.bg);
  check('and its stock frame is a fraction of the card, not most of it',
    card.back.frame > 0 && card.back.frame < card.back.w * 0.14, `${card.back.frame}px on ${card.back.w}px`);

  await ctx.close();
}

// --- reduced motion removes travel, not information -----------------------
{
  const ctx = await browser.newContext({ ...phone, hasTouch: true, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');
  const motion = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--motion').trim());
  check('reduced motion zeroes the travel token', motion === '0', motion);
  const visible = await page.evaluate(() => {
    const n = document.querySelector('.gametile');
    return getComputedStyle(n).opacity;
  });
  check('but content is still visible', Number(visible) > 0.9, visible);
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall visual checks passed');
process.exit(failures ? 1 : 0);
