/**
 * Typing must survive everything the app does on its own schedule.
 *
 * The bug this exists for: the countdown called the global render() once a
 * second, which tore the whole DOM down and rebuilt it. During Spectrum's
 * 90-second clue phase the psychic's input was destroyed and recreated empty
 * every single second, so a clue could never be typed at all. Nothing in the
 * suite caught it, because every other test typed and asserted inside the same
 * second.
 *
 * So the checks here are all about TIME PASSING while a field is focused.
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
const pages = [];
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext({ ...phone, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`  [js error p${i}] ${e.message}`); failures++; });
  pages.push(page);
}
const [host, ...rest] = pages;

// --- get four players into a Spectrum round -------------------------------

await host.goto(`${BASE}/`);
await host.waitForSelector('.gametile');
await host.locator('.gametile[data-game="spectrum"]').click();
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
await host.waitForFunction(() => !document.querySelector('.roomcode'), { timeout: 15000 });

const psychic = await (async () => {
  for (const p of pages) {
    if (await p.locator('#clue').count()) return p;
  }
  return null;
})();
check('the psychic gets a clue box', psychic !== null);

// --- the countdown must not rebuild the page ------------------------------

{
  const p = psychic ?? host;
  check('a countdown is running', (await p.locator('.timer').count()) === 1);

  // Tag live nodes, wait past several ticks, and see whether they are the same
  // nodes. If the clock re-renders, the tags are gone.
  await p.evaluate(() => {
    document.querySelector('.flow').dataset.probe = 'alive';
    document.querySelector('.bar--bottom')?.setAttribute('data-probe', 'alive');
  });
  const before = await p.locator('.timer__t').innerText();
  await p.waitForTimeout(3200);
  const survived = await p.evaluate(() => ({
    flow: document.querySelector('.flow')?.dataset.probe === 'alive',
    bar: document.querySelector('.bar--bottom')?.getAttribute('data-probe') === 'alive',
  }));
  const after = await p.locator('.timer__t').innerText();
  check('the countdown does not rebuild the page', survived.flow && survived.bar, JSON.stringify(survived));
  check('but the countdown still counts down', before !== after, `${before} -> ${after}`);
}

// --- the clue survives the clock ------------------------------------------

if (psychic) {
  await psychic.click('#clue');
  await psychic.keyboard.type('Everest');
  // Longer than several ticks of the countdown, which is exactly what used to
  // wipe it.
  await psychic.waitForTimeout(3400);
  const held = await psychic.evaluate(() => ({
    value: document.querySelector('#clue')?.value,
    focused: document.activeElement?.id,
  }));
  check('a typed clue survives the countdown', held.value === 'Everest', JSON.stringify(held));
  check('and the field keeps focus', held.focused === 'clue', JSON.stringify(held));

  // Keep typing after the wait — a real person pauses mid-word.
  await psychic.keyboard.type(' base camp');
  await psychic.waitForTimeout(300);
  const full = await psychic.evaluate(() => document.querySelector('#clue')?.value);
  check('and you can keep typing after a pause', full === 'Everest base camp', full);

  // Someone else joining mid-clue re-renders every screen at the table.
  await rest[2].reload();
  await rest[2].waitForFunction(() => !!document.querySelector('.dial, .flow'), { timeout: 15000 });
  await psychic.waitForTimeout(1200);
  const afterPeer = await psychic.evaluate(() => document.querySelector('#clue')?.value);
  check('and it survives another player reconnecting', afterPeer === 'Everest base camp', afterPeer);

  await psychic.locator('.bar--bottom .btn--primary').click();
  await psychic.waitForTimeout(900);
  const moved = await host.locator('.flow').innerText();
  check('the clue actually sends', /everest/i.test(moved), moved.replace(/\n/g, ' | ').slice(0, 120));
}

// --- an empty clue must say so rather than doing nothing ------------------

if (psychic) {
  const text = await psychic.locator('.flow').innerText();
  check('the round moved on to guessing', /clue|dial|drag/i.test(text), text.replace(/\n/g, ' | ').slice(0, 120));
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall typing checks passed');
process.exit(failures ? 1 : 0);
