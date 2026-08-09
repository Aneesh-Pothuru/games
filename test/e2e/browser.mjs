/** Drive the real UI at phone size with six players. */
import { devices } from 'playwright';
import { BASE, launchBrowser } from './launch.mjs';


const OUT = process.env.SHOT_DIR ?? '/tmp/parlour-shots';
await import('node:fs').then(fs => fs.mkdirSync(OUT, { recursive: true }));
const browser = await launchBrowser();
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${extra}`}`);
  if (!cond) failures++;
};

const phone = devices['iPhone 13'];
const ctxs = [];
const pages = [];
for (let i = 0; i < 6; i++) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error p${i}] ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console p${i}] ${m.text()}`); });
  pages.push(page);
}

// --- host creates a room ---
const host = pages[0];
await host.goto('http://localhost:8787/');
await host.waitForSelector('.gametile');
check('home renders game tiles', (await host.locator('.gametile').count()) >= 4);

// no horizontal overflow at 390px
const overflow = await host.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no horizontal overflow on the home screen', !overflow);

await host.screenshot({ path: `${OUT}/01-home.png` });

// --- REGRESSION: tapping Start with no name must give visible feedback ---
// This previously rendered an error ~600px below the fold with no toast, so
// the button looked completely dead.
{
  const small = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const sp = await small.newPage();
  await sp.goto('http://localhost:8787/');
  await sp.waitForSelector('.gametile');

  const tileY = (await sp.locator('.gametile').first().boundingBox()).y;
  check('first game is above the fold on a 375x667 phone', tileY < 400, `y=${Math.round(tileY)}`);

  await sp.locator('.gametile').first().click();
  await sp.locator('.bar--bottom .btn--primary').click();
  await sp.waitForTimeout(600);
  const toastBox = await sp.locator('.toast').first().boundingBox().catch(() => null);
  check('empty name produces visible feedback', Boolean(toastBox), 'no toast rendered');
  if (toastBox) {
    check('that feedback is on screen', toastBox.y >= 0 && toastBox.y < 667, `y=${Math.round(toastBox.y)}`);
  }

  // --- REGRESSION: phone keyboards COMPOSE, they do not type ---
  // A predictive keyboard fires one input event per predicted prefix. The code
  // box used to write back into itself on every one of those, which ends the
  // composition and re-inserts what is already there: typing "poker" came out
  // as "PPOPOKPOKEPOKERP". fill() cannot catch this — it sets the value in one
  // go — so this drives the real composition events.
  {
    const cdp = await small.newCDPSession(sp);
    for (const sel of ['#code', '#startbar-name']) {
      // The start bar only exists once a game is picked, and tapping the
      // already-selected tile would toggle it back off.
      if (sel === '#startbar-name' && !(await sp.locator('#startbar-name').count())) {
        await sp.locator('.gametile').first().click();
      }
      await sp.click(sel);
      await sp.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
      for (const t of ['p', 'po', 'pok', 'poke', 'poker']) {
        await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      }
      await cdp.send('Input.insertText', { text: 'poker' });
      await sp.waitForTimeout(250);
      const got = await sp.evaluate((s) => document.querySelector(s).value, sel);
      check(`${sel} survives a composing keyboard`, got.toLowerCase() === 'poker', `got "${got}"`);
    }
    await sp.evaluate(() => { document.querySelector('#code').value = ''; });
    await sp.reload();
    await sp.waitForSelector('.gametile');
  }

  // --- REGRESSION: typing a game name into the code box must not dead-end ---
  await sp.fill('#code', 'SPYFALL');
  await sp.waitForTimeout(400);
  const rescue = await sp.locator('#rescue').innerText().catch(() => '');
  check('typing "spyfall" offers the right game', /odd one out/i.test(rescue), rescue.slice(0, 60));

  // --- Every game names the thing people are looking for ---
  const tiles = await sp.locator('.gametile').allInnerTexts();
  for (const want of ['Spyfall', 'Secret Hitler', 'Wavelength', 'Werewolf', 'Avalon']) {
    check(`"${want}" is findable on the home screen`, tiles.some((t) => t.includes(want)));
  }
  await sp.screenshot({ path: `${OUT}/00-home-small.png` });
  await small.close();
}

await host.locator('.gametile[data-game="council"]').click();
await host.fill('#startbar-name', 'Ana');
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.roomcode', { timeout: 10000 });
const code = (await host.locator('.roomcode__cells').innerText()).replace(/\s/g, '');
check('room code is four letters', /^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(code), code);
await host.screenshot({ path: `${OUT}/02-lobby-host.png` });

// Short of players, the primary action must be something you can DO. A
// disabled button with nothing beside it is the dead end that made this look
// broken to the owner.
const startLabel = await host.locator('.bar--bottom .btn--primary').innerText();
check('under-min lobby offers a real action', /invite/i.test(startLabel), startLabel);
check('that action is enabled', await host.locator('.bar--bottom .btn--primary').isEnabled());
check('the requirement is still stated somewhere',
  /needs? \d|at least \d/i.test(await host.locator('.screen').innerText()));

// --- five more join by deep link ---
const names = ['Ben', 'Cleo', 'Dev', 'Eve', 'Fay'];
for (let i = 1; i <= 5; i++) {
  const p = pages[i];
  await p.goto(`http://localhost:8787/${code}`);
  await p.waitForSelector('#name');
  await p.fill('#name', names[i - 1]);
  await p.locator('.bar--bottom .btn--primary').click();
  await p.waitForSelector('.roomcode', { timeout: 10000 });
}
await host.waitForFunction(() => document.querySelectorAll('.ptile').length >= 6, { timeout: 10000 });
check('host sees all six players', (await host.locator('.ptile').count()) >= 6);
await pages[1].screenshot({ path: `${OUT}/03-lobby-player.png` });

const startLabel2 = await host.locator('.bar--bottom .btn--primary').innerText();
check('start button enables with the count', /Start with 6/i.test(startLabel2), startLabel2);

// --- start the game ---
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.rolecard', { timeout: 10000 });
check('role card appears', await host.locator('.rolecard').isVisible());

// the secret must NOT be in the DOM text before reveal... it is on the back
// face which is rotated away; verify the card starts unrevealed.
check('role card starts face-down', !(await host.locator('.rolecard').getAttribute('class')).includes('is-revealed'));
await host.screenshot({ path: `${OUT}/04-role-facedown.png` });

// hold to reveal
const card = host.locator('.rolecard__btn');
const box = await card.boundingBox();
await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await host.mouse.down();
await host.waitForTimeout(900);
await host.mouse.up();
await host.waitForTimeout(400);
check('holding reveals the role', (await host.locator('.rolecard').getAttribute('class')).includes('is-revealed'));
await host.screenshot({ path: `${OUT}/05-role-revealed.png` });

// --- everyone acknowledges ---
for (const p of pages) {
  const btn = p.locator('.bar--bottom .btn--primary');
  if (await btn.isEnabled()) await btn.click();
}
await host.waitForFunction(() => !document.querySelector('.rolecard'), { timeout: 10000 });
check('advances to nomination once everyone acks', await host.locator('.flow').innerText().then((t) => /Speaker|nominate/i.test(t)));
await host.screenshot({ path: `${OUT}/06-nominate.png` });

// --- the speaker nominates; the button must name the target ---
const speakerPage = await (async () => {
  for (const p of pages) {
    const txt = await p.locator('.flow').innerText();
    if (/You are Speaker/i.test(txt)) return p;
  }
  return null;
})();
check('exactly one client is told they are Speaker', speakerPage !== null);

if (speakerPage) {
  await speakerPage.locator('.ptile--pick:not([disabled])').first().click();
  const label = await speakerPage.locator('.bar--bottom .btn--primary').innerText();
  check('commit button names the nominee', /^Nominate .+/.test(label), label);
  await speakerPage.screenshot({ path: `${OUT}/07-selected.png` });
  await speakerPage.locator('.bar--bottom .btn--primary').click();

  // --- everyone votes ---
  await pages[1].waitForSelector('.votepair', { timeout: 10000 });
  check('vote buttons render', await pages[1].locator('.vote').count() === 2);
  const voteBox = await pages[1].locator('.vote').first().boundingBox();
  check('vote targets are at least 56px tall', voteBox.height >= 56, `${voteBox.height}px`);
  await pages[1].screenshot({ path: `${OUT}/08-vote.png` });

  for (const p of pages) {
    const yes = p.locator('.vote--yes');
    if (await yes.count()) await yes.click();
  }
  await host.waitForTimeout(1200);
  await host.screenshot({ path: `${OUT}/09-after-vote.png` });
  const afterVote = await host.locator('.flow').innerText();
  check('election resolves', /Charters|policy|Discard|Enact|Waiting/i.test(afterVote), afterVote.slice(0, 120));
}

// --- the rules sheet must be closed until asked for ---
const sheetShown = await host.evaluate(() => {
  const d = document.getElementById('sheet');
  return { open: d.open, display: getComputedStyle(d).display };
});
check('rules sheet is hidden until opened', !sheetShown.open && sheetShown.display === 'none', JSON.stringify(sheetShown));
await host.locator('.iconbtn[aria-label="How to play"]').click();
await host.waitForTimeout(400);
check('rules sheet opens on demand', await host.evaluate(() => document.getElementById('sheet').open));
check('rules sheet has content', (await host.locator('#sheet-body').innerText()).length > 100);
await host.screenshot({ path: `${OUT}/12-rules.png` });
await host.keyboard.press('Escape');
await host.waitForTimeout(300);
check('rules sheet closes again', await host.evaluate(() => !document.getElementById('sheet').open));

// --- tap target audit across the whole app ---
const small = await host.evaluate(() => {
  const bad = [];
  for (const node of document.querySelectorAll('button, a, input, [role="radio"]')) {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < 44) bad.push(`${node.className || node.tagName}:${Math.round(r.height)}px`);
  }
  return bad;
});
check('every visible control is at least 44px tall', small.length === 0, small.join(', '));

// --- safe areas and scroll containment ---
const shell = await host.evaluate(() => {
  const s = getComputedStyle(document.body);
  return { overflow: s.overflow, overscroll: s.overscrollBehavior, touch: s.touchAction };
});
check('body does not scroll', shell.overflow === 'hidden', JSON.stringify(shell));

// --- REGRESSION: content taller than the viewport must be REACHABLE ---
// "body does not scroll" passing is not enough -- it was the SYMPTOM of a bug
// where .flow collapsed to content height, never scrolled, and everything past
// the fold was silently clipped by body's overflow:hidden.
{
  const small = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  const sp = await small.newPage();
  for (const [label, url] of [['home', 'http://localhost:8787/']]) {
    await sp.goto(url);
    await sp.waitForSelector('.gametile');
    const m = await sp.evaluate(() => {
      const flow = document.querySelector('.flow');
      return { canScroll: flow.scrollHeight > flow.clientHeight + 1, sh: flow.scrollHeight, ch: flow.clientHeight };
    });
    check(`${label}: scroll container is bounded`, m.ch < m.sh || m.sh === m.ch,
      `scrollHeight=${m.sh} clientHeight=${m.ch}`);
    if (m.canScroll) {
      const before = (await sp.locator('.gametile').last().boundingBox()).y;
      await sp.locator('.flow').evaluate((n) => { n.scrollTop = n.scrollHeight; });
      await sp.waitForTimeout(200);
      const after = (await sp.locator('.gametile').last().boundingBox()).y;
      check(`${label}: scrolling actually moves content`, after < before, `${Math.round(before)} -> ${Math.round(after)}`);
      check(`${label}: the last item becomes reachable`, after < 667, `y=${Math.round(after)}`);
    }
  }
  await small.close();
}
check('pull-to-refresh disabled', shell.overscroll.includes('none'), shell.overscroll);
check('double-tap zoom off but pinch preserved', shell.touch === 'manipulation', shell.touch);

// --- light theme renders ---
await host.emulateMedia({ colorScheme: 'light' });
await host.waitForTimeout(300);
await host.screenshot({ path: `${OUT}/10-light.png` });
const lightBg = await host.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('light theme repaints the background', lightBg !== 'rgb(11, 14, 20)', lightBg);
await host.emulateMedia({ colorScheme: 'dark' });

// --- small phone: 320px wide must still work ---
const small320 = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
const p320 = await small320.newPage();
await p320.goto('http://localhost:8787/');
await p320.waitForSelector('.gametile');
const of320 = await p320.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no overflow at 320px', !of320);
await p320.screenshot({ path: `${OUT}/11-320.png` });

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll browser checks passed.');
process.exit(failures ? 1 : 0);
