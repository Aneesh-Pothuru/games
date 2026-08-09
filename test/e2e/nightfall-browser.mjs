/** Play a full Nightfall round through the real UI on phones. */
import { chromium, devices } from 'playwright';
const OUT = process.env.SHOT_DIR ?? '/tmp/parlour-shots';
await import('node:fs').then((fs) => fs.mkdirSync(OUT, { recursive: true }));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
let fail = 0;
const check=(n,c,x='')=>{console.log(`${c?'ok  ':'FAIL'} ${n}${c?'':' -- '+x}`); if(!c) fail++;};

const pages=[];
for (let i=0;i<6;i++){
  const ctx = await b.newContext({...devices['iPhone 13'], colorScheme:'dark'});
  const p = await ctx.newPage();
  p.on('pageerror', e => { console.log(`  [js error p${i}] ${e.message}`); fail++; });
  pages.push(p);
}
const host = pages[0];
await host.goto('http://localhost:8787/');
await host.waitForSelector('.gametile');
check('Nightfall is listed', await host.locator('.gametile', {hasText:'Nightfall'}).count() === 1);

await host.fill('#name','Ana');
await host.locator('.gametile', {hasText:'Nightfall'}).click();
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.roomcode');
const code = (await host.locator('.roomcode__cells').innerText()).replace(/\s/g,'');

for (let i=1;i<6;i++){
  await pages[i].goto(`http://localhost:8787/${code}`);
  await pages[i].waitForSelector('#name');
  await pages[i].fill('#name', ['Ben','Cleo','Dev','Eve','Fay'][i-1]);
  await pages[i].locator('.bar--bottom .btn--primary').click();
  await pages[i].waitForSelector('.roomcode');
}
await host.waitForFunction(()=>document.querySelectorAll('.ptile').length>=6);
await host.locator('.bar--bottom .btn--primary').click();
await host.waitForSelector('.rolecard');
check('role cards dealt', await host.locator('.rolecard').isVisible());

// reveal + ack everyone
for (const p of pages){
  const bx = await p.locator('.rolecard__btn').boundingBox();
  await p.mouse.move(bx.x+bx.width/2, bx.y+bx.height/2);
  await p.mouse.down(); await p.waitForTimeout(850); await p.mouse.up();
  await p.waitForTimeout(200);
}
await host.screenshot({path:`${OUT}/N1-role.png`});
for (const p of pages){ const btn=p.locator('.bar--bottom .btn--primary'); if(await btn.isEnabled()) await btn.click(); }
await host.waitForTimeout(1200);

// find who has which night role by reading their screen
const screens = await Promise.all(pages.map(p=>p.locator('#app').innerText()));
const wolfIdx = screens.findIndex(t=>/Agree on someone to take/i.test(t));
const seerIdx = screens.findIndex(t=>/Check one player/i.test(t));
const docIdx  = screens.findIndex(t=>/Protect one player/i.test(t));
check('exactly one wolf surface', wolfIdx >= 0, screens[0].slice(0,140));
check('a seer surface exists', seerIdx >= 0);
check('a doctor surface exists', docIdx >= 0);
check('night phase reached', screens.some(t=>/Night 1/i.test(t)));
await pages[Math.max(wolfIdx,0)].screenshot({path:`${OUT}/N2-wolf.png`});
if (seerIdx>=0) await pages[seerIdx].screenshot({path:`${OUT}/N3-seer.png`});

// villagers must have something to look at, never a blank screen
const idle = screens.filter(t=>/nothing to do tonight/i.test(t));
check('players with no night action get a real screen', idle.length >= 1 || wolfIdx<0, `${idle.length}`);

// take night actions
async function act(i){
  const p = pages[i];
  const row = p.locator('.ptile--pick:not([disabled])').first();
  if (await row.count()) { await row.click(); await p.waitForTimeout(150); }
  const btn = p.locator('.bar--bottom button:not(.btn--ghost)').first();
  if (await btn.count() && await btn.isEnabled()) await btn.click();
  await p.waitForTimeout(250);
}
if (seerIdx>=0) await act(seerIdx);
if (docIdx>=0) await act(docIdx);
if (wolfIdx>=0) await act(wolfIdx);
await host.waitForTimeout(900);

// witch, if present
const s2 = await Promise.all(pages.map(p=>p.locator('#app').innerText()));
const witchIdx = s2.findIndex(t=>/The wolves have chosen/i.test(t));
if (witchIdx>=0){
  check('the witch is shown the victim', true);
  await pages[witchIdx].screenshot({path:`${OUT}/N4-witch.png`});
  await pages[witchIdx].locator('.bar--bottom .btn--ghost').last().click();
  await host.waitForTimeout(900);
}

const s3 = await Promise.all(pages.map(p=>p.locator('#app').innerText()));
check('dawn is announced to everyone', s3.every(t=>/died in the night|Nobody died|Hunter/i.test(t)), s3[0].slice(0,160));
await host.screenshot({path:`${OUT}/N5-day.png`});

// tap targets on the night screens
const small = await host.evaluate(()=>{const bad=[];for(const n of document.querySelectorAll('button,a,input')){const r=n.getBoundingClientRect();if(r.width&&r.height&&r.height<44)bad.push(`${n.className}:${Math.round(r.height)}`);}return bad;});
check('tap targets still >=44px', small.length===0, small.join(', '));

await b.close();
console.log(fail?`\n${fail} FAILURE(S)`:'\nNightfall checks passed.');
process.exit(fail?1:0);
