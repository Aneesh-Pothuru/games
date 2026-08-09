/**
 * User journeys, driven through the real UI.
 *
 * These are the paths where the app used to dead-end — states you could reach
 * with no button that moves you forward. Each one is written the way it
 * actually happens at a table, not as a sequence of API calls:
 *
 *   J1  you land on the site and want to know what a game is before committing
 *   J2  you follow a shared link and want to know whose room this is
 *   J3  the host closes their tab and everyone is stuck
 *   J4  you arrive ten minutes late
 *   J5  the host needs to remove someone or hand over
 *   J6  one more person than the game seats tries to get in
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
async function newPhone(label) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error ${label}] ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console ${label}] ${m.text()}`); });
  return { ctx, page };
}

/** Create a room and return its code. */
async function createRoom(page, gameText, name) {
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');
  await page.locator('.gametile', { hasText: gameText }).click();
  await page.fill('#startbar-name', name);
  await page.locator('.bar--bottom .btn--primary').click();
  await page.waitForSelector('.roomcode', { timeout: 15000 });
  return (await page.locator('.roomcode__cells').innerText()).replace(/\s/g, '');
}

async function joinRoom(page, code, name) {
  await page.goto(`${BASE}/${code}`);
  await page.waitForSelector('#name', { timeout: 15000 });
  await page.fill('#name', name);
  await page.locator('.bar--bottom .btn--primary').click();
}

// ---------------------------------------------------- J1: read before playing

{
  const { ctx, page } = await newPhone('J1');
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.gametile');

  // Before picking anything there is no bottom bar to read rules from — that
  // is fine, but once you pick a game the rules must be one tap away, without
  // having to create a room and gather five friends first.
  await page.locator('.gametile', { hasText: 'Hold' }).click();
  const barText = await page.locator('.bar--bottom').innerText();
  check('J1 picking a game offers its rules', /how to play/i.test(barText), barText.replace(/\n/g, ' | '));

  await page.locator('.bar--bottom .btn--ghost').click();
  await page.waitForTimeout(400);
  check('J1 the rules open from the home screen', await page.evaluate(() => document.getElementById('sheet').open));
  const rules = await page.locator('#sheet-body').innerText();
  check('J1 and they are the rules for the game you picked', /flop|blind|pot/i.test(rules), rules.slice(0, 80));
  await page.screenshot({ path: `${OUT}/30-rules-from-home.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Switching games must switch the rules, not keep showing the first one.
  await page.locator('.gametile', { hasText: 'Spectrum' }).click();
  await page.locator('.bar--bottom .btn--ghost').click();
  await page.waitForTimeout(400);
  const rules2 = await page.locator('#sheet-body').innerText();
  check('J1 the rules follow the selection', /dial|psychic|clue/i.test(rules2), rules2.slice(0, 80));
  await ctx.close();
}

// ------------------------------------------------ J2: following a shared link

{
  const a = await newPhone('J2-host');
  const code = await createRoom(a.page, 'Spectrum', 'Ana');

  const b = await newPhone('J2-guest');
  await b.page.goto(`${BASE}/${code}`);
  await b.page.waitForSelector('#name');
  await b.page.waitForTimeout(900); // the peek is fire-and-forget
  const intro = await b.page.locator('.flow').innerText();
  check('J2 the link says which game it is', /spectrum/i.test(intro), intro.replace(/\n/g, ' | ').slice(0, 120));
  check('J2 and whose room it is', /ana/i.test(intro), intro.replace(/\n/g, ' | ').slice(0, 120));
  check('J2 and how many are already in', /1 player/i.test(intro), intro.replace(/\n/g, ' | ').slice(0, 120));
  await b.page.screenshot({ path: `${OUT}/31-join-preview.png` });
  await a.ctx.close();
  await b.ctx.close();
}

// --------------------------------------------------- J3: the host disappears

{
  const a = await newPhone('J3-host');
  const code = await createRoom(a.page, 'Spectrum', 'Ana');
  const b = await newPhone('J3-guest');
  await joinRoom(b.page, code, 'Ben');
  await b.page.waitForSelector('.roomcode', { timeout: 15000 });

  // Before: nothing on this screen can start a game, and never will.
  await a.ctx.close();
  await b.page.waitForFunction(
    () => /dropped out/i.test(document.querySelector('.flow')?.innerText ?? ''),
    { timeout: 20000 },
  ).catch(() => {});
  const stranded = await b.page.locator('.flow').innerText();
  check('J3 the room says the host is gone', /dropped out/i.test(stranded), stranded.replace(/\n/g, ' | ').slice(0, 140));
  check('J3 and offers a way to take over', /take over as host/i.test(stranded));
  await b.page.screenshot({ path: `${OUT}/32-host-gone.png` });

  await b.page.locator('.btn', { hasText: 'Take over as host' }).click();
  await b.page.waitForTimeout(700);
  const nowHost = await b.page.locator('.bar--bottom').innerText();
  check('J3 the new host gets a real start button', /invite|start/i.test(nowHost), nowHost.replace(/\n/g, ' | '));
  check('J3 and the takeover banner is gone', !/take over as host/i.test(await b.page.locator('.flow').innerText()));
  await b.ctx.close();
}

// ------------------------------------------------------- J4: arriving late

{
  const a = await newPhone('J4-host');
  const code = await createRoom(a.page, 'Spectrum', 'Ana');
  const b = await newPhone('J4-b');
  await joinRoom(b.page, code, 'Ben');
  await b.page.waitForSelector('.roomcode', { timeout: 15000 });
  await a.page.waitForFunction(() => document.querySelectorAll('.ptile').length >= 2, { timeout: 15000 });
  await a.page.locator('.bar--bottom .btn--primary').click();
  await a.page.waitForFunction(
    () => !document.querySelector('.roomcode'),
    { timeout: 15000 },
  );

  const c = await newPhone('J4-late');
  await c.page.goto(`${BASE}/${code}`);
  await c.page.waitForSelector('#name', { timeout: 15000 });
  await c.page.waitForTimeout(900);
  const preview = await c.page.locator('.flow').innerText();
  check('J4 the join screen warns a round is running', /already running/i.test(preview), preview.replace(/\n/g, ' | ').slice(0, 140));
  const cta = await c.page.locator('.bar--bottom .btn--primary').innerText();
  check('J4 and the button promises a seat rather than entry', /hold me a seat/i.test(cta), cta);

  await c.page.fill('#name', 'Cleo');
  await c.page.locator('.bar--bottom .btn--primary').click();
  await c.page.waitForTimeout(1500);
  const held = await c.page.locator('.flow').innerText();
  check('J4 a late arrival is not turned away', !/already started/i.test(held));
  check('J4 and is told their seat is held', /next round/i.test(held), held.replace(/\n/g, ' | ').slice(0, 160));
  check('J4 with something to do while waiting',
    /read the rules/i.test(await c.page.locator('.bar--bottom').innerText()));
  // No game screen leaked to someone who is not in the round.
  check('J4 and no game board is rendered for them', (await c.page.locator('.dial, .rolecard, .pokerboard').count()) === 0);
  await c.page.screenshot({ path: `${OUT}/33-waiting-room.png` });

  // The host finishes and starts again: the late arrival is simply in.
  await a.page.locator('.iconbtn[aria-label="How to play"]').count(); // no-op, keeps the page alive
  await c.ctx.close();
  await a.ctx.close();
  await b.ctx.close();
}

// ------------------------------------------------------- J5: host controls

{
  const a = await newPhone('J5-host');
  const code = await createRoom(a.page, 'Spectrum', 'Ana');
  const b = await newPhone('J5-guest');
  await joinRoom(b.page, code, 'Ben');
  await b.page.waitForSelector('.roomcode', { timeout: 15000 });
  await a.page.waitForFunction(() => document.querySelectorAll('.ptile').length >= 2, { timeout: 15000 });

  // The host taps the other player; the guest's own tile must not be tappable.
  const guestTiles = await b.page.locator('.plist button.ptile').count();
  check('J5 a non-host cannot manage anyone', guestTiles === 0, `${guestTiles} tappable tiles`);

  const hostTiles = await a.page.locator('.plist button.ptile').count();
  check('J5 the host can manage everyone but themselves', hostTiles === 1, `${hostTiles} tappable tiles`);
  check('J5 and the list is still a list', (await a.page.locator('.plist > li').count()) === 2);

  await a.page.locator('.plist button.ptile').first().click();
  await a.page.waitForTimeout(400);
  const sheetText = await a.page.locator('#sheet-body').innerText();
  check('J5 offers handing over the room', /make ben the host/i.test(sheetText), sheetText.replace(/\n/g, ' | '));
  check('J5 offers removing them', /remove ben/i.test(sheetText));
  check('J5 and a way out that does neither', /cancel/i.test(sheetText));
  await a.page.screenshot({ path: `${OUT}/34-host-controls.png` });

  await a.page.locator('#sheet-body .btn--danger').click();
  await b.page.waitForTimeout(1200);
  const removed = await b.page.locator('.flow').innerText();
  check('J5 a removed player lands somewhere real', /closed|start|room|game/i.test(removed), removed.replace(/\n/g, ' | ').slice(0, 120));
  await a.page.waitForTimeout(500);
  check('J5 and the host sees them gone', (await a.page.locator('.ptile').count()) === 1);
  await a.ctx.close();
  await b.ctx.close();
}

// --------------------------------------------------------- J6: a full room

{
  const a = await newPhone('J6-host');
  // Spectrum seats sixteen, so use a game with a small ceiling to keep this
  // quick: hold'em is nine-handed.
  const code = await createRoom(a.page, 'Hold', 'Ana');

  const joiners = [];
  for (let i = 0; i < 8; i++) {
    const p = await newPhone(`J6-${i}`);
    joiners.push(p);
    await joinRoom(p.page, code, `P${i}`);
    await p.page.waitForSelector('.roomcode', { timeout: 15000 });
  }
  await a.page.waitForFunction(() => document.querySelectorAll('.ptile').length >= 9, { timeout: 20000 });
  check('J6 the room fills to the game maximum', (await a.page.locator('.ptile').count()) === 9);
  check('J6 and says so', /full/i.test(await a.page.locator('.flow').innerText()));

  // Arriving at a full room: you should be told before you type your name.
  const extra = await newPhone('J6-extra');
  await extra.page.goto(`${BASE}/${code}`);
  await extra.page.waitForTimeout(1400);
  const doorway = await extra.page.locator('.screen').innerText();
  check('J6 a full room says so on arrival', /full/i.test(doorway), doorway.replace(/\n/g, ' | ').slice(0, 140));
  check('J6 and does not ask for a name it cannot use', (await extra.page.locator('#name').count()) === 0);
  check('J6 but still offers a way forward',
    /start a room of your own/i.test(await extra.page.locator('.bar--bottom').innerText()));
  // …and not silently, into a lobby they cannot start from.
  check('J6 and does not end up holding a seat', (await extra.page.locator('.roomcode').count()) === 0);

  await extra.page.locator('.bar--bottom .btn--primary').click();
  await extra.page.waitForSelector('.gametile', { timeout: 10000 });
  check('J6 which actually gets them somewhere', (await extra.page.locator('.gametile').count()) > 0);
  await extra.page.screenshot({ path: `${OUT}/35-room-full.png` });

  await extra.ctx.close();
  for (const p of joiners) await p.ctx.close();
  await a.ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall journey checks passed');
process.exit(failures ? 1 : 0);
