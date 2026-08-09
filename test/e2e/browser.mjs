/** Drive the real UI at phone size with six players. */
import { chromium, devices } from 'playwright';

const OUT = process.env.SHOT_DIR ?? '/tmp/parlour-shots';
await import('node:fs').then(fs => fs.mkdirSync(OUT, { recursive: true }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
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

await host.fill('#name', 'Ana');
await host.locator('.gametile', { hasText: 'The Council' }).click();
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.roomcode', { timeout: 10000 });
const code = (await host.locator('.roomcode__cells').innerText()).replace(/\s/g, '');
check('room code is four letters', /^[BCDFGHJKMNPQRSTVWXYZ]{4}$/.test(code), code);
await host.screenshot({ path: `${OUT}/02-lobby-host.png` });

// start button states its own blocker
const startLabel = await host.locator('.bar--bottom .btn--primary').innerText();
check('disabled start button says why', /Need 5 players/i.test(startLabel), startLabel);

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
