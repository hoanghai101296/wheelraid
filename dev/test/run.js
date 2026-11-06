// Wheel Raid contract tests on Hardhat's in-process network (cancun), using the exact solc 0.8.26 bytecode.
const hre = require('hardhat');
const { ethers } = require('ethers');
const fs = require('fs');
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; if (process.env.V) console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const D = 600;
const json = (k, v) => typeof v === 'bigint' ? v.toString() : v;

async function main() {
  const provider = new ethers.BrowserProvider(hre.network.provider);
  const S = await Promise.all([0, 1, 2, 3, 4, 5].map(i => provider.getSigner(i)));
  const [a, b, c, d, e, f] = S;
  const A = await Promise.all(S.map(s => s.getAddress()));
  const send = (m, p = []) => hre.network.provider.send(m, p);
  const now = async () => parseInt((await send('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
  const setTime = async t => { const cur = await now(); if (t > cur) await send('evm_increaseTime', [t - cur]); await send('evm_mine'); };
  const deploy = async (name, args, from = a) => { const fct = new ethers.ContractFactory(art[name].abi, art[name].bytecode, from); const k = await fct.deploy(...args); await k.waitForDeployment(); return k; };
  const iface = new ethers.Interface(art.WheelRaid.abi);
  const errSel = (name, s) => { const fr = iface.getError(name); return fr && s.includes(fr.selector.slice(2)); };
  const reverts = async (p, name) => { try { const tx = await p; if (tx && tx.wait) await tx.wait(); return false; } catch (err) { const s = String(err.shortMessage || err.message) + JSON.stringify(err.revert || '', json) + (err.data || ''); return name ? s.includes(name) || (err.revert && err.revert.name === name) || errSel(name, s) : true; } };
  const G = { gasLimit: 6_000_000 };

  const t0 = await now();
  const genesis = t0 - 1000 * D + 400; // round 1000 is in progress
  const core = await deploy('MockCore', [genesis, D]);
  const sq = await deploy('MockSqueeks', []);
  const wl = await deploy('MockSqueeks', []);
  await (await sq.give(A[1])).wait();
  await (await sq.give(A[2])).wait();
  await (await wl.give(A[2])).wait();
  const RA = await deploy('RaidArt', []);
  console.log('art deploy gas', (await (await RA.deploymentTransaction()).wait()).gasUsed.toString());
  const R = await deploy('WheelRaid', [await core.getAddress(), await sq.getAddress(), await wl.getAddress(), await RA.getAddress()]);
  const rc = await (await R.deploymentTransaction()).wait();
  console.log('deploy gas', rc.gasUsed.toString());
  const r_ = who => R.connect(who);
  const round = async () => Number(await R.currentRound());
  const nextRound = async (k = 1) => { const cr = await round(); await setTime(Math.max(genesis + (cr + k - 1) * D + 5, (await now()) + 1)); return round(); };
  const work = async (r, w) => (await core.setWork(r, w)).wait();
  const settle = async r => (await core.settle(r)).wait();
  const charge = async who => { const tx = await r_(who).charge(G); return tx.wait(); };
  const cur = async () => R.currentBoss();

  // ---------------------------------------------------------------- setup
  ok(await R.genesis() == BigInt(genesis) && await R.roundDuration() == 600n && await R.maxWork() == 10000n, 'reads genesis, round length and max work from SqueekCore');
  ok(await reverts(deploy('WheelRaid', [await sq.getAddress(), await sq.getAddress(), await wl.getAddress(), await RA.getAddress()])), 'refuses a core that is not SqueekCore');
  ok(await reverts(deploy('WheelRaid', [await core.getAddress(), await sq.getAddress(), await wl.getAddress(), A[3]]), 'BadArt'), 'refuses an art address without code');
  ok(await R.art() === await RA.getAddress(), 'points at the art renderer');
  let B = await cur();
  ok(await R.bossCount() == 1n && B.id == 0n && B.level == 0n && B.maxHp == 4000n && B.hpLeft == 4000n && B.fate == 0n && Number(B.spawnRound) === await round(), 'boss 0 stands from the deploy round with 4,000 HP');
  ok(B.fleeRound == B.spawnRound + 1008n, 'a boss flees a week after it spawns');
  ok(/^[A-Z][a-z]+ the [A-Z]/.test(B.name), 'boss has a name: ' + B.name);
  const svg0 = await R.bossSvg(0);
  ok(svg0.startsWith('<svg') && svg0.endsWith('</svg>') && !svg0.includes('undefined'), 'boss portrait is an SVG');
  ok(await R.hpFor(1) == 5600n && await R.hpFor(2) == 7840n && await R.hpFor(200) == await R.hpFor(60), 'HP grows x1.4 per level and is capped');
  ok(await R.rallyOf(0) == 100n && await R.rallyOf(1) == 100n && await R.rallyOf(2) == 110n && await R.rallyOf(6) == 150n && await R.rallyOf(50) == 150n, 'rally: +10% per extra raider, up to +50%');
  ok(await R.powerOf(A[0]) == 100n && await R.powerOf(A[1]) == 125n && await R.powerOf(A[2]) == 150n, 'power: +25% Squeek holder, +25% Wheeling owner');
  ok(await R.tierOf(1000, 4000) == 3n && await R.tierOf(320, 4000) == 2n && await R.tierOf(319, 4000) == 1n, 'trophy tiers at 25% and 8% of max HP');

  // ---------------------------------------------------------------- first strike
  let r1 = await round();
  let rec = await charge(a);
  console.log('charge gas (first)', rec.gasUsed.toString());
  ok(await reverts(r_(a).charge.staticCall(), 'AlreadyCharged'), 'one charge per raider per round');
  await charge(c);
  let rd = await R.rounds(r1);
  ok(rd.raiders == 2n && rd.power == 250n && !rd.done, 'round records raiders and their power');
  ok(await R.queueLength() == 1n && (await R.queued(10))[0].map(Number).join() === String(r1), 'the round waits in the queue');
  await work(r1, 1000);
  await (await r_(e).advance(10, G)).wait();
  ok((await cur()).damage == 0n, 'an unsettled round does not hit');
  await settle(r1);
  ok(await R.roundWork(r1) == 1000n, 'roundWork reads the settled page');
  rec = await (await r_(e).sync(A[0], G)).wait();
  B = await cur();
  ok(B.damage == 2750n && B.hpLeft == 1250n && B.strikes == 1n, 'two raiders, 1,000 work: 1,000 x 2.5 power x 1.1 rally = 2,750 damage');
  let ra = await R.raider(A[0], 0), rcv = await R.raider(A[2], 0);
  ok(ra.damage == 1100n && ra.onBoss == 1100n && ra.hits == 1n && ra.pending.length === 0, 'raider A credited 1,100 (1x power)');
  ok(rcv.damage == 0n && rcv.uncredited == 1650n && rcv.onBoss == 1650n && rcv.pending.length === 1, 'raider C sees 1,650 before crediting');
  ok(await R.damageOf(0, A[0]) == 1100n, 'damageOf by boss');
  const struck = rec.logs.map(l => { try { return iface.parseLog(l); } catch { return null; } }).filter(x => x && x.name === 'RoundStruck');
  ok(struck.length === 1 && struck[0].args.hpLeft == 1250n && struck[0].args.raiders == 2n, 'RoundStruck event carries work, raiders and HP left');

  // nap
  let r2 = await nextRound();
  await charge(a);
  await work(r2, 0);
  await settle(r2);
  await (await r_(a).sync(A[0], G)).wait();
  ra = await R.raider(A[0], 0);
  ok((await cur()).damage == 2750n && ra.damage == 1100n && ra.hits == 1n && ra.charges == 2n, 'a still wheel is a miss');

  // RoundSettled: the round in progress already settled (only a misbehaving core could do that)
  let r3 = await nextRound();
  await settle(r3);
  ok(await reverts(r_(b).charge.staticCall(), 'RoundSettled'), 'cannot charge a settled round');

  // ---------------------------------------------------------------- the kill
  let r4 = await nextRound();
  await charge(a); await charge(b); await charge(c);
  let r5 = await nextRound();
  await charge(d);           // charged before the kill is applied, lands on the next boss
  await work(r4, 600);       // 600 x (100+125+150) x 1.2 = 2,700 >= 1,250 left
  await work(r5, 500);
  await settle(r5);
  rec = await (await r_(e).advance(10, G)).wait();
  const b0 = await R.boss(0), b1 = await R.boss(1);
  ok(b0.fate == 1n && b0.hpLeft == 0n && b0.endRound == BigInt(r4), 'boss 0 falls in the round that empties its HP');
  ok(await R.bossCount() == 2n && b1.level == 1n && b1.maxHp == 5600n && b1.spawnRound == BigInt(r4 + 1), 'a level 1 boss spawns the next round');
  ok(b1.damage == 500n && (await R.rounds(r5)).boss == 1n, 'a charge after the kill hits the new boss');
  ok(b1.name !== b0.name || b1.seed !== b0.seed, 'the new boss has a new seed');
  ok((await R.bossSvg(0)).includes('M140 165'), 'a fallen boss is drawn with X eyes');
  await (await r_(e).sync(A[0], G)).wait();
  ok(await R.killingBlow(0, A[0]) && (await R.raider(A[0], 0)).kills == 1n, 'raiders in the killing round get the killing blow');
  ok(await R.damageOf(0, A[0]) == 1100n + 720n, 'overkill still credits the raider (600 x 1 x 1.2 = 720)');

  // ---------------------------------------------------------------- trophies
  ok(await reverts(r_(d).claim.staticCall(0), 'NoDamage'), 'no trophy without damage on that boss');
  ok(await reverts(r_(a).claim.staticCall(1), 'NotDefeated'), 'no trophy for a standing boss');
  ok(await reverts(r_(a).claim.staticCall(9), 'NoSuchBoss'), 'unknown boss');
  rec = await (await r_(a).claim(0, G)).wait();
  console.log('claim gas', rec.gasUsed.toString());
  await (await r_(b).claim(0, G)).wait();  // b only hit the killing round: 600 x 1.25 x 1.2 = 900 (22.5%) silver
  await (await r_(c).claim(0, G)).wait();  // c: 1,650 + 1,080 = 2,730 (68%) gold
  ok(await reverts(r_(a).claim.staticCall(0), 'AlreadyClaimed'), 'one trophy per raider per boss');
  const t1 = await R.trophy(1), t2 = await R.trophy(2), t3 = await R.trophy(3);
  ok(t1.owner === A[0] && t1.tier == 3n && t1.damage == 1820n && t1.killingBlow, 'A: gold (45%), killing blow');
  ok(t2.tier == 2n && t2.damage == 900n && t3.tier == 3n && t3.damage == 2730n, 'B silver, C gold');
  ok(await R.totalSupply() == 3n && await R.balanceOf(A[0]) == 1n && await R.ownerOf(2) === A[1] && await R.trophyOf(0, A[2]) == 3n, 'ERC-721 views');
  ok(await R.locked(1) && await reverts(r_(a).transferFrom.staticCall(A[0], A[4], 1), 'Soulbound') && await reverts(r_(a).approve.staticCall(A[4], 1), 'Soulbound'), 'trophies are soulbound');
  ok(await R.supportsInterface('0x80ac58cd') && await R.supportsInterface('0x5b5e139f') && await R.supportsInterface('0xb45a3c0e') && !(await R.supportsInterface('0xffffffff')), 'ERC-165 interfaces');
  ok(await reverts(R.ownerOf(99), 'NoSuchTrophy') && await reverts(R.balanceOf(ethers.ZeroAddress), 'NoSuchTrophy'), 'unknown trophy, balanceOf(0)');
  const uri = await R.tokenURI(1);
  const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString());
  const img = Buffer.from(meta.image.split(',')[1], 'base64').toString();
  ok(meta.name.startsWith('Gold trophy: ') && meta.attributes.find(x => x.trait_type === 'Killing blow').value === 'Yes' && meta.attributes.find(x => x.trait_type === 'Damage').value === 1820, 'tokenURI JSON: ' + meta.name);
  ok(img.startsWith('<svg') && img.endsWith('</svg>') && img.includes('KILLING BLOW') && img.includes('GOLD TROPHY'), 'trophy SVG');
  fs.writeFileSync(__dirname + '/../build/sample.json', JSON.stringify({ boss: [svg0, await R.bossSvg(0), await R.bossSvg(1)], trophy: [img, Buffer.from(JSON.parse(Buffer.from((await R.tokenURI(2)).split(',')[1], 'base64')).image.split(',')[1], 'base64').toString()] }));

  // views
  const bl = await R.bosses(99, 10);
  ok(bl.length === 2 && bl[0].id == 1n && bl[1].id == 0n && (await R.bosses(0, 5)).length === 1 && (await R.bosses(5, 0)).length === 0, 'bosses() newest first');
  ok(await R.raiderCount() == 4n && (await R.raiders(0, 0, 100)).length === 4 && (await R.raiders(0, 3, 100)).length === 1 && (await R.raiders(0, 9, 1)).length === 0, 'raiders() pages');
  const board0 = await R.raiders(0, 0, 10);
  ok(board0.map(x => Number(x.onBoss)).join() === '1820,2730,900,0', 'board damage on boss 0: ' + board0.map(x => Number(x.onBoss)).join());

  // ---------------------------------------------------------------- pending limit
  for (let i = 0; i < 24; i++) { await nextRound(); await charge(e); }
  await nextRound();
  ok(await reverts(r_(e).charge.staticCall(), 'TooManyPending'), 'at most 24 charges wait for settlement');
  let rr = await round();
  for (let q = Number(await core.settled()) + 1; q <= rr - 1; q++) await work(q, 10);
  await settle(rr - 1);
  rec = await charge(e); // applies 6 queued rounds, credits them, then the slot frees
  console.log('charge gas (applying 6 rounds)', rec.gasUsed.toString());
  ok((await R.raider(A[4], 1)).pending.length === 24 - 6 + 1, 'a charge applies six settled rounds and frees their slots');
  for (let k = 0; k < 4; k++) await (await r_(f).advance(48, G)).wait();
  await (await r_(f).sync(A[4], G)).wait();
  ok((await R.raider(A[4], 1)).pending.length === 1 && Number(await R.queueHead()) === Number(await R.queueLength()) - 1, 'advance and sync catch up');

  // ---------------------------------------------------------------- core outage
  await core.setBroken(true);
  let rb = await nextRound();
  await charge(a);
  await work(rb, 300);
  await settle(rb);
  const head0 = await R.queueHead();
  await (await r_(f).advance(10, G)).wait();
  ok(await R.queueHead() == head0 && !(await R.rounds(rb)).done, 'if SqueekCore cannot serve a settled round, the raid waits');
  await nextRound(145);
  await (await r_(f).advance(10, G)).wait();
  ok((await R.rounds(rb)).done && (await R.rounds(rb)).work == 0n, 'a day later it counts as a miss so the raid moves on');
  await core.setBroken(false);

  // ---------------------------------------------------------------- flee
  B = await cur();
  const lvl = B.level, id1 = B.id;
  await setTime(genesis + Number(B.fleeRound + 2n) * D - 300);
  let rf = await round();
  await charge(b);
  await work(rf, 100);
  for (let q = Number(await core.settled()) + 300; q < rf; q += 300) await settle(q);
  await settle(rf);
  await (await r_(f).advance(10, G)).wait();
  const fled = await R.boss(id1), nb = await cur();
  ok(fled.fate == 2n && fled.endRound == fled.fleeRound, 'a boss left standing for a week flees');
  ok(nb.id == id1 + 1n && nb.level == lvl && nb.damage == 125n && nb.spawnRound == BigInt(rf), 'a new boss of the same level takes the hit');
  ok(await reverts(r_(b).claim.staticCall(id1), 'NotDefeated'), 'no trophies from a boss that fled');

  // ---------------------------------------------------------------- randomized model
  const model = { bosses: [], queue: [], rounds: {}, dmg: {} };
  for (let i = 0; i < Number(await R.bossCount()); i++) { const x = await R.boss(i); model.bosses.push({ level: Number(x.level), maxHp: Number(x.maxHp), damage: Number(x.damage), spawn: Number(x.spawnRound), end: Number(x.endRound), fate: Number(x.fate) }); }
  const ql = Number(await R.queueLength()), qh = Number(await R.queueHead());
  ok(ql === qh, 'queue empty before the model run');
  const players = [a, b, c, d, f]; const pw = { [A[0]]: 100, [A[1]]: 125, [A[2]]: 150, [A[3]]: 100, [A[5]]: 100 };
  const startBoss = model.bosses.length - 1;
  for (const ad of A) { const d0 = Number(await R.damageOf(startBoss, ad)) + 0; const rv = await R.raider(ad, startBoss); const d = Number(rv.onBoss); if (d) model.dmg[startBoss + ':' + ad] = d; }
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const charged = {}; const workMap = {};
  const hpFor = l => { let h = 4000; for (let i = 0; i < Math.min(l, 60); i++) h = Math.floor(h * 7 / 5); return h; };
  const rally = n => n <= 1 ? 100 : 100 + Math.min(n - 1, 5) * 10;
  const hit = (w, p, n) => Math.floor(w * p * rally(n) / 10000);
  let settledNow = Number(await core.settled());
  for (let step = 0; step < 90; step++) {
    const x = rnd();
    if (x < 0.35) { const k = await nextRound(); workMap[k] = rnd() < 0.55 ? Math.floor(rnd() * 2500) : 0; await work(k, workMap[k]); }
    else if (x < 0.8) { const who = players[Math.floor(rnd() * players.length)]; const ad = await who.getAddress(); const k = await round(); charged[k] = charged[k] || [];
      const rv = await reverts(r_(who).charge.staticCall());
      const expect = !charged[k].includes(ad) && k > settledNow && (await R.raider(ad, 0)).pending.length < 24;
      if (!rv) { await charge(who); charged[k].push(ad); }
      if (rv === expect) { ok(false, 'charge outcome differs from the model at step ' + step); break; } }
    else { const target = Math.min(await round() - 1, settledNow + 1 + Math.floor(rnd() * 3)); if (target > settledNow) { await settle(target); settledNow = target; } }
  }
  const last = await round(); await nextRound(); await settle(last); settledNow = last;
  for (let k = 0; k < 6; k++) await (await r_(f).advance(48, G)).wait();
  for (const who of players) await (await r_(f).sync(await who.getAddress(), G)).wait();
  // replay in JS
  let bi = startBoss;
  for (const k of Object.keys(charged).map(Number).filter(k => charged[k].length).sort((p, q) => p - q)) {
    let bb = model.bosses[bi];
    if (k > bb.spawn + 1008) { bb.fate = 2; bb.end = bb.spawn + 1008; model.bosses.push({ level: bb.level, maxHp: hpFor(bb.level), damage: 0, spawn: k, end: 0, fate: 0 }); bi++; bb = model.bosses[bi]; }
    const wk = workMap[k] || 0; const n = charged[k].length; const P = charged[k].reduce((s, ad) => s + pw[ad], 0);
    const dmg = hit(wk, P, n);
    for (const ad of charged[k]) { const key = bi + ':' + ad; model.dmg[key] = (model.dmg[key] || 0) + hit(wk, pw[ad], n); }
    const left = bb.maxHp - bb.damage;
    if (dmg >= left) { bb.damage = bb.maxHp; bb.fate = 1; bb.end = k; model.bosses.push({ level: bb.level + 1, maxHp: hpFor(bb.level + 1), damage: 0, spawn: k + 1, end: 0, fate: 0 }); bi++; }
    else bb.damage += dmg;
  }
  let same = Number(await R.bossCount()) === model.bosses.length;
  for (let i = startBoss; i < model.bosses.length && same; i++) { const x = await R.boss(i), m = model.bosses[i];
    if (Number(x.damage) !== m.damage || Number(x.fate) !== m.fate || Number(x.level) !== m.level || Number(x.maxHp) !== m.maxHp || Number(x.spawnRound) !== m.spawn) { same = false; console.log('  boss diff', i, x.toArray().map(String).join(' '), JSON.stringify(m)); } }
  for (const key of Object.keys(model.dmg)) { const [bs, ad] = key.split(':'); if (Number(await R.damageOf(Number(bs), ad)) !== model.dmg[key]) { same = false; console.log('  dmg diff', key, Number(await R.damageOf(Number(bs), ad)), model.dmg[key]); } }
  ok(same, `90 random steps match the reference model (${model.bosses.length - startBoss} bosses, ${Object.keys(charged).length} rounds)`);

  console.log(fail ? `FAILED ${fail} (passed ${pass})` : `ALL PASS (${pass})`);
  process.exitCode = fail ? 1 : 0;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
