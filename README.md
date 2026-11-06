# Wheel Raid

A co-op boss raid powered by Squeektoshi's real wheel.

One boss stands at a time. While the hamster runs, raiders **charge** the 10-minute round in progress (free on Sepolia, one charge per wallet per round). When SqueekCore settles that round, everyone who charged it hits the boss for the round's **real wheel work**, read straight from `SqueekCore.roundPage`. A round where the wheel stood still is a miss.

- **Rally:** +10% damage for each other raider in the same round, up to +50%. Bring friends.
- **Perks:** +25% power for Squeek NFT holders, +25% for Wheeling owners (stacking to 1.5×).
- **Bosses:** 4,000 HP at level 0, ×1.4 per level. A fallen boss is replaced the next round by a stronger one. A boss left standing for a week (1,008 rounds) flees and a fresh one of the same level steps in.
- **Trophies:** everyone who hurt a fallen boss can claim a soulbound on-chain trophy (ERC-721 + ERC-5192). Gold for 25%+ of its max HP, Silver for 8%+, Bronze otherwise, plus a **Killing blow** ribbon for every raider in the final round.
- **All on-chain:** boss names and portraits are generated from a seed and drawn by the contract (`bossSvg`), trophies are SVG + JSON in `tokenURI`. No owner, no admin, no upgrade, no ETH.

## How a round is scored

1. `charge()` records the round in progress with the raider's power. Up to 24 charges per raider can wait for settlement.
2. SqueekCore settles rounds in batches. Charged rounds are applied to the boss in order by `charge`, `claim`, `sync(raider)` or `advance(steps)` (anyone may call the last two).
3. For each charged round ≤ `settledThroughRound`: work = `end.cumulativeWork − start.cumulativeWork` of `roundPage(r−1, r, 1)`, capped at `maxWorkPerRound`. Round damage = work × Σpower/100 × rally(raiders)/100. Each raider is credited work × power/100 × rally/100 on the boss that round hit.
4. If the round empties the boss's HP it falls in that round (overkill still counts for the raiders) and a level+1 boss spawns the next round. If a charged round comes more than a week after the boss spawned, the boss flees first.
5. If SqueekCore cannot serve a settled round, the raid waits for it; a full day later the round counts as a still wheel so the raid never locks.

## Contracts (Sepolia)

| | |
|---|---|
| SqueekCore | `0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4` |
| Squeek NFT (perk) | `0xc4c7982657f00509548f3a3a41db7fa439a6856b` |
| Wheelings (perk) | `0x13c421454de930e373647cb45dd35a963c21c0a3` |
| RaidArt | [`0xbbeb05ccb7ce3529e6221ab52b2ebc7d5ffc0c0c`](https://sepolia.etherscan.io/address/0xbbeb05ccb7ce3529e6221ab52b2ebc7d5ffc0c0c) |
| WheelRaid | [`0x77240d974bb7a4ccb85021ff2c40ca0324f57896`](https://sepolia.etherscan.io/address/0x77240d974bb7a4ccb85021ff2c40ca0324f57896) (block 12074799) |

Constructor: `WheelRaid(address core, address squeeks, address wheelings, address art)`. Compiler: solc 0.8.26, optimizer on (200 runs), EVM `cancun`. `release/standard-input.json` is the exact compiler input for verification.

## Files

- `index.html` — the whole dapp (no build step, no external scripts). Multi-wallet connect (EIP-6963 + injected), reads Sepolia over public RPCs and the live wheel from `api.squeekchain.com`.
- `contracts/WheelRaid.sol` — WheelRaid and RaidArt.
- `release/` — ABI, standard JSON input, metadata.
- `dev/` — tests: contract unit + randomized model test (Hardhat), Playwright end-to-end against a mock SqueekCore.

Testnet only. Nothing here has value.
