// End-to-end: the real page in Chromium against a local Hardhat node (mock SqueekCore), with a fake injected wallet.
const { chromium } = require('playwright');
const { ethers } = require('ethers');
const fs = require('fs');
const E = JSON.parse(fs.readFileSync(__dirname + '/../build/e2e.json', 'utf8'));
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
const HTML = fs.readFileSync(process.env.E2E_HTML || (__dirname + '/../../index.html'), 'utf8')
  .replace(/const RAID = '0x[0-9a-fA-F]*';/, `const RAID = '${E.raid}';`).replace(/const DEPLOY_BLOCK = \d+;/, 'const DEPLOY_BLOCK = 0;')
  .replace("const CORE = '0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4';", `const CORE = '${E.core}';`);
const OUT = __dirname + '/../build/';
const FD = __dirname + '/../node_modules/@fontsource/';
const face = (fam, dir, w) => `@font-face{font-family:"${fam}";font-style:normal;font-weight:${w};src:url(https://fonts.gstatic.com/f/${dir}/files/${dir}-latin-${w}-normal.woff2) format("woff2")}`;
const FONTCSS = [face('Bungee', 'bungee', 400), ...[400, 500, 600, 700].map(w => face('Barlow', 'barlow', w)), face('JetBrains Mono', 'jetbrains-mono', 400), face('JetBrains Mono', 'jetbrains-mono', 600)].join('');
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const NODE = 'http://127.0.0.1:8545';

(async () => {
  const provider = new ethers.JsonRpcProvider(NODE); const admin = await provider.getSigner(0); const me = await provider.getSigner(5);
  const core = new ethers.Contract(E.core, art.MockCore.abi, admin); const R = new ethers.Contract(E.raid, art.WheelRaid.abi, admin);
  const meAddr = await me.getAddress();
  let running = true;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const node = async (method, params = []) => { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; };
  const waitToast = async (pg, re, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await pg.$eval('#toast', e => e.hidden ? '' : e.textContent).catch(() => ''); if (re.test(t)) return t; await sleep(150); } return ''; };
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await sleep(300); } return false; };
  async function page(viewport, wallet = true, rpcDown = false, apiHang = false) {
    const pg = await browser.newPage({ viewport });
    pg.on('pageerror', e => errors.push('pageerror ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await pg.route('https://raid.test/', r => r.fulfill({ body: HTML, contentType: 'text/html' }));
    await pg.route('https://raid.test/favicon.svg', r => r.fulfill({ body: fs.readFileSync(__dirname + '/../../favicon.svg'), contentType: 'image/svg+xml' }));
    await pg.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: FONTCSS }));
    await pg.route('https://fonts.gstatic.com/f/**', r => { const f = r.request().url().split('/f/')[1]; r.fulfill({ contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(FD + f) }); });
    for (const host of ['https://ethereum-sepolia-rpc.publicnode.com/**', 'https://1rpc.io/**']) await pg.route(host, async r => {
      if (rpcDown) return r.fulfill({ status: 503, body: 'down', headers: { 'access-control-allow-origin': '*' } });
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
      const res = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.request().postData() });
      r.fulfill({ status: 200, body: await res.text(), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' } }); });
    await pg.route('https://api.squeekchain.com/**', r => apiHang ? undefined : r.fulfill({ body: JSON.stringify({ measurement: { freshness: 'online', rpmMilli: running ? 62000 : 0 }, builder: { anchor: { settledThroughRound: '0' } } }), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }));
    if (wallet) await pg.exposeFunction('__node', async (method, params) => { const res = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await res.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; });
    if (wallet) await pg.addInitScript(addr => {
      let on = (() => { try { return localStorage.getItem('__mockon') === '1'; } catch { return false; } })(); const L = {};
      const provider = { isMetaMask: true, on: (e, f) => { (L[e] = L[e] || []).push(f); }, removeListener() {},
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') { on = true; try { localStorage.setItem('__mockon', '1'); } catch {} return [addr]; }
          if (method === 'eth_accounts') return on ? [addr] : [];
          if (method === 'eth_chainId') return '0xaa36a7';
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'eth_sendTransaction') { if (params[0].chainId !== '0xaa36a7') throw new Error('wrong chainId'); const t = { ...params[0] }; delete t.chainId; return window.__node('eth_sendTransaction', [t]); }
          throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); } };
      const info = { uuid: 'test', name: 'Test Wallet', icon: '', rdns: 'test.wallet' };
      window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } })));
    }, meAddr);
    await pg.goto('https://raid.test/'); return pg;
  }
  const text = (pg, id) => pg.$eval('#' + id, e => e.textContent);
  const clickText = async (pg, t) => { await pg.locator('button', { hasText: t }).first().click(); };
  const kick = pg => pg.evaluate(() => window.__raid.refresh(true));

  // 1. a viewer without a wallet sees the boss, the board, the hall and the log
  const v = await page({ width: 1280, height: 900 }, false);
  ok(await until(async () => /Boss #2/.test(await text(v, 'bossEyebrow'))), 'shows the current boss: ' + await text(v, 'bossEyebrow'));
  const b1 = await R.currentBoss();
  ok((await text(v, 'bossName')) === b1.name && (await text(v, 'hpTxt')) === '5,225 / 5,600', 'boss name and HP from the contract: ' + await text(v, 'hpTxt'));
  ok(await v.$('#bossArt img') !== null, 'boss portrait drawn from bossSvg');
  ok(await until(async () => (await v.$$('#board tr')).length === 1 && /1 raider on boss #2/.test(await text(v, 'boardCount'))), 'board lists the raider on this boss');
  ok(await until(async () => (await v.$$('#hall .card')).length === 1 && /Fell in round/.test(await text(v, 'hall'))), 'hall shows the fallen boss');
  ok(await until(async () => /fell in round/.test(await text(v, 'feed')) && /3 raiders charged, he ran 1,500 → 5,850 damage \(rally \+20%\)/.test(await text(v, 'feed')) && /claimed a Gold trophy/.test(await text(v, 'feed'))), 'raid log reads hits, the kill and the trophy from events');
  ok(/Squeektoshi is running/.test(await text(v, 'runTxt')) && /\d/.test(await text(v, 'rNow')) && await v.$eval('#arena', e => e.classList.contains('running')), 'live wheel status, round clock, spinning wheel');
  ok(/Connect to charge/.test(await v.locator('#actions').textContent()), 'no wallet: offers to connect');
  ok(/Contracts: WheelRaid 0x/.test(await text(v, 'links')), 'footer links the contract');
  await v.screenshot({ path: OUT + 'e2e-viewer.png', fullPage: true });

  // 2. connect and charge the round in progress
  const p = await page({ width: 1280, height: 900 });
  await until(async () => /Connect wallet/.test(await p.locator('#wBtns').textContent()));
  await clickText(p, 'Connect wallet');
  ok(await until(async () => /Test Wallet/.test(await text(p, 'wState')) && /Sepolia/.test(await text(p, 'wState'))), 'wallet connects');
  ok(await until(async () => /Charge! · round/.test(await p.locator('#actions').textContent()) && (await text(p, 'stPower')) === '1.00×'), 'offers "Charge!" with my power');
  const r = Number(await R.currentRound());
  await clickText(p, 'Charge!'); const t1 = await waitToast(p, /Charged round/);
  ok(t1.startsWith(`Charged round ${r.toLocaleString('en-US')}!`), 'toast names the round charged: ' + t1);
  ok(await until(async () => /Charged round [\d,]+ ✓/.test(await p.locator('#actions').textContent()) && /waiting for settlement/.test(await text(p, 'myQueue')) && (await text(p, 'stNow')) === '1'), 'button, queue and raider count update');
  ok(await p.locator('#actions button').first().isDisabled(), 'cannot charge the same round twice');
  // 3. the round settles: incoming damage, then anyone applies it
  await (await core.setWork(r, 2000)).wait(); await (await core.settle(r)).wait();
  await kick(p);
  ok(await until(async () => /−2,000 landing from 1 settled round/.test(await text(p, 'hpIncoming')) && await p.locator('button', { hasText: 'Apply 1 settled hit' }).count() === 1), 'settled charge shows as incoming damage');
  await clickText(p, 'Apply 1 settled hit');
  ok(await until(async () => (await text(p, 'hpTxt')) === '3,225 / 5,600'), 'applied: 5,225 → 3,225 HP');
  ok(await until(async () => (await text(p, 'stDmg')) === '2,000' && (await p.$$('#board tr')).length === 2), 'my damage and board row');
  ok(await p.$eval('#hpGhost', e => e.style.width) === (100 * 3225 / 5600).toFixed(2) + '%', 'HP bar width follows the contract');
  await p.screenshot({ path: OUT + 'e2e-hit.png' });
  // 4. next round: charge again, the wheel turns hard, the boss falls, a new one spawns, claim the trophy
  await node('evm_increaseTime', [600]); await node('evm_mine'); await kick(p);
  const r2 = Number(await R.currentRound());
  ok(await until(async () => new RegExp(`Charge! · round ${r2.toLocaleString('en-US')}`).test(await p.locator('#actions').textContent())), 'next round offers a new charge');
  await clickText(p, 'Charge!'); await waitToast(p, /Charged round/);
  await (await core.setWork(r2, 4000)).wait(); await (await core.settle(r2)).wait();
  await node('evm_increaseTime', [600]); await node('evm_mine');
  await kick(p);
  await until(async () => await p.locator('button', { hasText: 'Apply 1 settled hit' }).count() === 1);
  await clickText(p, 'Apply 1 settled hit');
  const t3 = await waitToast(p, /A new boss appears/, 25000);
  ok(/A new boss appears/.test(t3) && /Boss #3/.test(await text(p, 'bossEyebrow')) && (await text(p, 'hpTxt')) === '7,840 / 7,840', 'boss #2 falls, a level 2 boss with 7,840 HP appears');
  ok(await until(async () => await p.locator('#hall button', { hasText: 'Claim trophy' }).count() === 1 && /You dealt 6,000 \(Gold\)/.test(await text(p, 'hall'))), 'hall offers my Gold trophy');
  await p.locator('#hall button', { hasText: 'Claim trophy' }).click();
  const t4 = await waitToast(p, /trophy claimed/);
  ok(t4 === 'Gold trophy claimed', 'toast: ' + t4);
  ok(await until(async () => /Gold trophy: .* · yours/.test(await text(p, 'hall'))), 'hall shows the claimed trophy');
  const tid = Number(await R.trophyOf(1, meAddr)); const tr = await R.trophy(tid);
  ok(tid > 0 && tr.owner === meAddr && Number(tr.tier) === 3 && tr.killingBlow && Number(tr.damage) === 6000, 'trophy on chain: gold, killing blow, 6,000 damage');
  // 5. the wallet leaves Sepolia while a transaction is being prepared: nothing is sent
  await kick(p);
  await until(async () => /Charge! · round/.test(await p.locator('#actions').textContent()));
  await p.evaluate(() => { const W = window.__raid.Wal; const orig = W.prov.request.bind(W.prov); window.__sent = 0;
    W.prov.request = async a => { if (a.method === 'eth_chainId') return '0x1'; if (a.method === 'eth_sendTransaction') { window.__sent++; throw new Error('should not send'); } return orig(a); };
    window.__restore = () => { W.prov.request = orig; }; });
  await clickText(p, 'Charge!'); const tt = await waitToast(p, /left Sepolia/);
  ok(/left Sepolia/.test(tt) && await p.evaluate(() => window.__sent) === 0, 'wallet switched away mid-flight: no transaction sent');
  await p.evaluate(() => window.__restore());
  // 6. reload reconnects quietly
  await p.reload();
  ok(await until(async () => /Test Wallet/.test(await text(p, 'wState')) && (await p.$$('#board tr.me')).length === 0 && /Boss #3/.test(await text(p, 'bossEyebrow'))), 'reload reconnects quietly');
  ok(await until(async () => (await p.$$('#hall .card')).length === 2 && /yours/.test(await text(p, 'hall'))), 'hall keeps the trophy after reload');
  await p.screenshot({ path: OUT + 'e2e-desktop.png', fullPage: true });
  // 7. resting hint and phone layout
  running = false;
  const ph = await page({ width: 390, height: 844 }); await until(async () => /Boss #3/.test(await text(ph, 'bossEyebrow')));
  await until(async () => /He's resting/.test(await text(ph, 'chargeHint')));
  ok(/He's resting/.test(await text(ph, 'chargeHint')), 'resting: warns a charge will most likely miss');
  const sw = await ph.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 390, 'phone: no horizontal scroll (' + sw + ')');
  await ph.screenshot({ path: OUT + 'e2e-phone.png', fullPage: true });
  const sm = await page({ width: 320, height: 700 }, false); await sleep(3000);
  ok(await sm.evaluate(() => document.documentElement.scrollWidth) <= 320, '320 px: no horizontal scroll');
  // 8. a hanging wheel-status API does not block the raid
  const hg = await page({ width: 1280, height: 900 }, false, false, true);
  ok(await until(async () => /Boss #3/.test(await text(hg, 'bossEyebrow')) && await hg.$eval('#notDeployed', e => e.hidden)), 'status API hanging: boss still loads, no false notice');
  await hg.close();
  // 9. Sepolia unreachable: says so
  const dn = await page({ width: 1280, height: 900 }, false, true);
  ok(await until(async () => /Can't reach Sepolia/.test(await text(dn, 'notDeployedTxt')) && !(await dn.$eval('#notDeployed', e => e.hidden))), 'RPC down: "Can\'t reach Sepolia" notice');
  const errs = errors.filter(e => !/503|Failed to fetch/.test(e)); errors.length = 0; errors.push(...errs);
  ok(errors.length === 0, 'no console errors ' + errors.slice(0, 3).join(' / '));
  await browser.close();
  console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
