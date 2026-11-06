// Deploys MockCore (the real Sepolia genesis/round length), two balance mocks and WheelRaid to a running hardhat node,
// then plays a short history: boss 0 falls, boss 1 takes a hit. Writes the addresses for e2e.js.
const { ethers } = require('ethers'); const fs = require('fs');
const art = JSON.parse(fs.readFileSync(__dirname + '/../build/artifacts.json', 'utf8'));
const NODE = 'http://127.0.0.1:8545';
const node = async (method, params = []) => { const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; };
(async () => {
  const provider = new ethers.JsonRpcProvider(NODE); const a = await provider.getSigner(0);
  const dep = async (n, args) => { const k = await new ethers.ContractFactory(art[n].abi, art[n].bytecode, a).deploy(...args); await k.waitForDeployment(); return k; };
  const core = await dep('MockCore', [1793735400, 600]); const sq = await dep('MockSqueeks', []); const wl = await dep('MockSqueeks', []);
  const RA = await dep('RaidArt', []);
  const R = await dep('WheelRaid', [await core.getAddress(), await sq.getAddress(), await wl.getAddress(), await RA.getAddress()]);
  const [s1, s2, s3] = await Promise.all([1, 2, 3].map(i => provider.getSigner(i)));
  await (await sq.give(await s2.getAddress())).wait();
  const G = { gasLimit: 6_000_000 };
  let r = Number(await R.currentRound());
  for (const s of [s1, s2, s3]) await (await R.connect(s).charge(G)).wait();
  await (await core.setWork(r, 1500)).wait(); await (await core.settle(r)).wait();
  await node('evm_increaseTime', [600]); await node('evm_mine');
  await (await R.connect(s2).charge(G)).wait();          // lands on the next boss
  const r2 = Number(await R.currentRound());
  await (await core.setWork(r2, 300)).wait(); await (await core.settle(r2)).wait();
  await node('evm_increaseTime', [600]); await node('evm_mine');
  await (await R.advance(48, G)).wait();
  await (await R.connect(s1).claim(0, G)).wait();
  fs.writeFileSync(__dirname + '/../build/e2e.json', JSON.stringify({ core: await core.getAddress(), squeeks: await sq.getAddress(), wheelings: await wl.getAddress(), raid: await R.getAddress(), round: Number(await R.currentRound()) }));
  const b = await R.currentBoss();
  console.log('deployed', await R.getAddress(), 'round', Number(await R.currentRound()), 'boss', Number(b.id), Number(b.hpLeft), '/', Number(b.maxHp));
})().catch(e => { console.error(e); process.exit(1); });
