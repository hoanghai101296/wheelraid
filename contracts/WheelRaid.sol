// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Wheel Raid
/// @notice A co-op boss raid powered by Squeektoshi's real wheel. One boss stands at a time. While the hamster runs,
/// raiders "charge" the 10-minute round in progress. When SqueekCore settles that round on Sepolia, every raider who
/// charged it hits the boss for the round's real wheel work, read straight from SqueekCore's certified round page.
/// The more raiders charge the same round, the bigger the rally bonus. A boss that falls spawns a stronger one;
/// a boss left standing for a week flees. Everyone who hurt a fallen boss can claim a soulbound on-chain trophy.
/// @dev No owner, no admin, no upgrade, no ETH. The only external calls are view calls to SqueekCore, the Squeek
/// collection and the Wheelings collection (balanceOf, for the +25% damage perks).

interface ISqueekCore {
    struct CoreState {
        uint64 settledThroughRound;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint64 blockHeight;
        uint96 blockProgress;
        uint32 workPerThousandBlocks;
        uint256 authorizationNonce;
        bool paused;
    }

    struct CoreConfiguration {
        bytes32 streamId;
        uint64 genesisTimestamp;
        uint64 roundDuration;
        uint64 maxWorkPerRound;
        uint16 maxRoundsPerBatch;
        address guardian;
        address reporter;
        uint32 initialWorkPerThousandBlocks;
        uint64 targetBlocksPerActiveRound;
        uint64 difficultySmoothingRounds;
        uint96 blockUnitsPerBlock;
    }

    struct LedgerPosition {
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint32 workPerThousandBlocks;
    }

    struct RoundCheckpoint {
        uint64 roundId;
        uint64 cumulativeWork;
        uint96 cumulativeBlockUnits;
        uint32 workPerThousandBlocks;
        bytes32 dataHash;
    }

    struct RoundPage {
        uint64 certifiedThroughRound;
        LedgerPosition start;
        LedgerPosition end;
        RoundCheckpoint[] rounds;
    }

    function state() external view returns (CoreState memory);
    function configuration() external view returns (CoreConfiguration memory);
    function roundPage(uint64 afterRound, uint64 throughRound, uint256 maxRecords) external view returns (RoundPage memory);
}

contract WheelRaid {
    // ---------------------------------------------------------------- errors / events
    error WheelNotStarted();
    error AlreadyCharged(uint64 round);
    error RoundSettled(uint64 round);
    error TooManyPending();
    error NoSuchBoss();
    error NotDefeated();
    error NoDamage();
    error AlreadyClaimed();
    error NoSuchTrophy();
    error Soulbound();
    error BadCore();
    error BadCorePage(uint64 round);
    error BadArt();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Locked(uint256 tokenId); // ERC-5192: trophies are bound to the raider who earned them
    event BossSpawned(uint256 indexed boss, uint32 level, uint64 maxHp, uint64 round);
    event Charged(address indexed raider, uint64 indexed round, uint16 power);
    event RoundStruck(uint64 indexed round, uint256 indexed boss, uint64 work, uint32 raiders, uint64 damage, uint64 hpLeft);
    event BossDefeated(uint256 indexed boss, uint64 round);
    event BossFled(uint256 indexed boss, uint64 round);
    event Credited(address indexed raider, uint64 indexed round, uint256 indexed boss, uint64 damage);
    event TrophyClaimed(uint256 indexed id, address indexed raider, uint256 indexed boss, uint8 tier, bool killingBlow);

    // ---------------------------------------------------------------- config
    string public constant name = "Wheel Raid Trophies";
    string public constant symbol = "RAID";
    uint256 public constant MAX_PENDING = 24;     // four hours of charges can wait for settlement
    uint64 public constant ESCAPE_ROUNDS = 1008;  // a boss flees after a week of 10-minute rounds
    uint64 public constant LOST_AFTER = 144;      // a settled round SqueekCore can't serve for a day counts as still
    uint64 public constant BASE_HP = 4000;
    uint256 public constant STEPS = 6;            // settled rounds applied per charge / claim
    uint16 public constant BASE_POWER = 100;
    uint16 public constant PERK = 25;             // +25% for a Squeek holder, +25% for a Wheeling owner

    ISqueekCore public immutable core;
    address public immutable squeeks;
    address public immutable wheelings;
    RaidArt public immutable art;
    uint64 public immutable genesis;
    uint64 public immutable roundDuration;
    uint64 public immutable maxWork;

    // ---------------------------------------------------------------- state
    struct Boss {
        uint64 seed;
        uint64 maxHp;
        uint64 damage;      // capped at maxHp
        uint64 spawnRound;  // first round it can be hit in
        uint64 endRound;    // round it fell in, or the round it fled after
        uint32 level;
        uint32 strikes;     // charged rounds applied to it
        uint8 fate;         // 0 standing, 1 defeated, 2 fled
    }

    struct Round {
        uint32 raiders;
        uint32 power;       // sum of the raiders' power, 100 = 1x
        uint64 work;
        uint32 boss;
        bool done;
    }

    struct Pending {
        uint64 round;
        uint16 power;
    }

    struct Raider {
        uint64 lastCharge;
        uint32 charges;
        uint32 hits;
        uint32 kills;       // killing blows
        uint64 damage;      // credited, all bosses
        Pending[] pending;  // charged rounds not credited yet, ascending
    }

    struct Trophy {
        address owner;
        uint32 boss;
        uint8 tier;         // 1 bronze, 2 silver, 3 gold
        bool killingBlow;
        uint64 damage;
    }

    Boss[] private _bosses;
    mapping(uint64 => Round) public rounds;
    uint64[] private _queue;          // charged rounds in order; applied up to queueHead
    uint256 public queueHead;
    mapping(address => Raider) private _raiders;
    address[] private _raiderList;
    mapping(uint256 => mapping(address => uint64)) public damageOf;     // boss => raider => credited damage
    mapping(uint256 => mapping(address => bool)) public killingBlow;    // boss => raider charged the round it fell in
    mapping(uint256 => mapping(address => uint256)) public trophyOf;    // boss => raider => trophy id
    mapping(uint256 => Trophy) private _trophies;
    mapping(address => uint256) private _balance;
    uint256 public totalSupply;

    constructor(address core_, address squeeks_, address wheelings_, address art_) {
        core = ISqueekCore(core_);
        squeeks = squeeks_;
        wheelings = wheelings_;
        if (art_.code.length == 0) revert BadArt();
        art = RaidArt(art_);
        ISqueekCore.CoreConfiguration memory c = ISqueekCore(core_).configuration();
        if (c.roundDuration == 0 || c.genesisTimestamp == 0 || c.maxWorkPerRound == 0) revert BadCore();
        genesis = c.genesisTimestamp;
        roundDuration = c.roundDuration;
        maxWork = c.maxWorkPerRound;
        uint64 r = currentRound();
        if (r == 0) revert WheelNotStarted();
        _spawn(0, r, uint64(uint256(keccak256(abi.encode(block.prevrandao, block.timestamp, address(this))))));
    }

    // ---------------------------------------------------------------- rounds
    /// @notice The round in progress: round N ends at genesis + N * roundDuration.
    function currentRound() public view returns (uint64) {
        if (block.timestamp < genesis) return 0;
        return uint64((block.timestamp - genesis) / roundDuration) + 1;
    }

    function settledThroughRound() public view returns (uint64) {
        return core.state().settledThroughRound;
    }

    /// @notice Work the wheel did in one settled round, read from SqueekCore's certified round page.
    function roundWork(uint64 round) external view returns (uint64 work) {
        bool ok;
        (ok, work,) = _readWork(round);
        if (!ok) revert BadCorePage(round);
    }

    /// @dev Never reverts. ok = false means "not readable yet". Odd pages are clamped.
    function _readWork(uint64 round) private view returns (bool ok, uint64 work, bytes32 dh) {
        if (round == 0) return (false, 0, 0);
        try core.roundPage(round - 1, round, 1) returns (ISqueekCore.RoundPage memory p) {
            if (p.certifiedThroughRound < round) return (false, 0, 0);
            if (p.rounds.length > 0) dh = p.rounds[0].dataHash;
            if (p.end.cumulativeWork <= p.start.cumulativeWork) return (true, 0, dh);
            work = p.end.cumulativeWork - p.start.cumulativeWork;
            if (work > maxWork) work = maxWork;
            return (true, work, dh);
        } catch {
            return (false, 0, 0);
        }
    }

    // ---------------------------------------------------------------- play
    /// @notice Charge the boss in the round in progress. Once SqueekCore settles it, you hit for the round's real
    /// wheel work times your power and the rally bonus. A still wheel means a miss. Settled hits are applied first.
    function charge() external {
        uint64 r = currentRound();
        if (r == 0) revert WheelNotStarted();
        Raider storage me = _raiders[msg.sender];
        if (r <= me.lastCharge) revert AlreadyCharged(r);
        uint64 settled = _advance(STEPS);
        if (r <= settled) revert RoundSettled(r);
        _credit(msg.sender, me);
        if (me.pending.length >= MAX_PENDING) revert TooManyPending();
        uint16 pw = powerOf(msg.sender);
        if (me.charges == 0) _raiderList.push(msg.sender);
        me.lastCharge = r;
        ++me.charges;
        me.pending.push(Pending(r, pw));
        Round storage rd = rounds[r];
        if (rd.raiders == 0) _queue.push(r);
        ++rd.raiders;
        rd.power += pw;
        emit Charged(msg.sender, r, pw);
    }

    /// @notice Apply up to `steps` settled charged rounds to the boss. Anyone may call it.
    function advance(uint256 steps) external {
        _advance(steps > 48 ? 48 : steps);
    }

    /// @notice Apply settled rounds, then credit a raider's damage. Anyone may call it for anyone.
    function sync(address raider) external {
        _advance(STEPS * 2);
        _credit(raider, _raiders[raider]);
    }

    /// @notice Claim the soulbound trophy for a fallen boss you hurt.
    function claim(uint256 bossId) external returns (uint256 id) {
        if (bossId >= _bosses.length) revert NoSuchBoss();
        _advance(STEPS);
        Raider storage me = _raiders[msg.sender];
        _credit(msg.sender, me);
        Boss storage b = _bosses[bossId];
        if (b.fate != 1) revert NotDefeated();
        uint64 d = damageOf[bossId][msg.sender];
        if (d == 0) revert NoDamage();
        if (trophyOf[bossId][msg.sender] != 0) revert AlreadyClaimed();
        uint8 tier = tierOf(d, b.maxHp);
        bool kb = killingBlow[bossId][msg.sender];
        id = ++totalSupply;
        _trophies[id] = Trophy(msg.sender, uint32(bossId), tier, kb, d);
        trophyOf[bossId][msg.sender] = id;
        ++_balance[msg.sender];
        emit Transfer(address(0), msg.sender, id);
        emit Locked(id);
        emit TrophyClaimed(id, msg.sender, bossId, tier, kb);
    }

    function _advance(uint256 maxSteps) private returns (uint64 settled) {
        settled = core.state().settledThroughRound;
        uint64 now_ = currentRound();
        uint256 h = queueHead;
        uint256 n = _queue.length;
        uint256 steps;
        while (h < n && steps < maxSteps) {
            uint64 r = _queue[h];
            if (r > settled) break;
            (bool ok, uint64 work, bytes32 dh) = _readWork(r);
            if (!ok) {
                if (now_ <= r + LOST_AFTER) break; // keep waiting for SqueekCore to serve it
                work = 0;                          // a full day later it counts as a still wheel
            }
            _strike(r, work, dh);
            ++h;
            ++steps;
        }
        if (h != queueHead) queueHead = h;
    }

    function _strike(uint64 r, uint64 work, bytes32 dh) private {
        Round storage rd = rounds[r];
        uint256 bi = _bosses.length - 1;
        Boss storage b = _bosses[bi];
        if (r > b.spawnRound + ESCAPE_ROUNDS) {
            b.fate = 2;
            b.endRound = b.spawnRound + ESCAPE_ROUNDS;
            emit BossFled(bi, b.endRound);
            bi = _spawn(b.level, r, uint64(uint256(keccak256(abi.encode(b.seed, r, "fled")))));
            b = _bosses[bi];
        }
        uint64 dmg = hitFor(work, rd.power, rd.raiders);
        rd.work = work;
        rd.boss = uint32(bi);
        rd.done = true;
        ++b.strikes;
        uint64 left = b.maxHp - b.damage;
        if (dmg >= left) {
            b.damage = b.maxHp;
            left = 0;
        } else {
            b.damage += dmg;
            left -= dmg;
        }
        emit RoundStruck(r, bi, work, rd.raiders, dmg, left);
        if (left == 0) {
            b.fate = 1;
            b.endRound = r;
            emit BossDefeated(bi, r);
            _spawn(b.level + 1, r + 1, uint64(uint256(keccak256(abi.encode(b.seed, r, dh, work)))));
        }
    }

    function _spawn(uint32 level, uint64 round, uint64 seed) private returns (uint256 id) {
        id = _bosses.length;
        uint64 hp = hpFor(level);
        _bosses.push(Boss(seed, hp, 0, round, 0, level, 0, 0));
        emit BossSpawned(id, level, hp, round);
    }

    function _credit(address who, Raider storage me) private {
        uint256 n = me.pending.length;
        uint256 done;
        while (done < n) {
            Pending memory p = me.pending[done];
            Round storage rd = rounds[p.round];
            if (!rd.done) break;
            uint64 d = hitFor(rd.work, p.power, rd.raiders);
            if (d > 0) {
                damageOf[rd.boss][who] += d;
                me.damage += d;
                ++me.hits;
                Boss storage b = _bosses[rd.boss];
                if (b.fate == 1 && b.endRound == p.round && !killingBlow[rd.boss][who]) {
                    killingBlow[rd.boss][who] = true;
                    ++me.kills;
                }
            }
            emit Credited(who, p.round, rd.boss, d);
            ++done;
        }
        if (done == 0) return;
        for (uint256 i = done; i < n; ++i) me.pending[i - done] = me.pending[i];
        for (uint256 i = 0; i < done; ++i) me.pending.pop();
    }

    // ---------------------------------------------------------------- rules (pure)
    /// @notice Boss HP: 4,000 at level 0, x1.4 per level.
    function hpFor(uint32 level) public pure returns (uint64 hp) {
        hp = BASE_HP;
        uint32 l = level > 60 ? 60 : level;
        for (uint32 i = 0; i < l; ++i) hp = hp * 7 / 5;
    }

    /// @notice Rally bonus in percent: +10% for each other raider in the same round, up to +50%.
    function rallyOf(uint32 n) public pure returns (uint64) {
        if (n <= 1) return 100;
        uint64 extra = n - 1 > 5 ? 5 : uint64(n - 1);
        return 100 + extra * 10;
    }

    /// @notice Damage for `work` at `power` (100 = 1x) with `n` raiders in the round.
    function hitFor(uint64 work, uint256 power, uint32 n) public pure returns (uint64) {
        return uint64(uint256(work) * power * rallyOf(n) / 10000);
    }

    function tierOf(uint64 damage, uint64 maxHp) public pure returns (uint8) {
        uint256 share = uint256(damage) * 10000 / maxHp;
        if (share >= 2500) return 3;
        if (share >= 800) return 2;
        return 1;
    }

    /// @notice Raid power, 100 = 1x: +25 for holding a Squeek, +25 for owning a Wheeling.
    function powerOf(address who) public view returns (uint16 p) {
        p = BASE_POWER;
        if (_holds(squeeks, who)) p += PERK;
        if (_holds(wheelings, who)) p += PERK;
    }

    function _holds(address token, address who) private view returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory ret) = token.staticcall{gas: 50_000}(abi.encodeWithSignature("balanceOf(address)", who));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) > 0;
    }

    // ---------------------------------------------------------------- views
    struct BossView {
        uint256 id;
        string name;
        uint64 seed;
        uint32 level;
        uint64 maxHp;
        uint64 damage;
        uint64 hpLeft;
        uint64 spawnRound;
        uint64 endRound;
        uint64 fleeRound;   // last round it can be hit in
        uint32 strikes;
        uint8 fate;         // 0 standing, 1 defeated, 2 fled
    }

    function bossCount() external view returns (uint256) {
        return _bosses.length;
    }

    function boss(uint256 id) public view returns (BossView memory v) {
        if (id >= _bosses.length) revert NoSuchBoss();
        Boss storage b = _bosses[id];
        v.id = id;
        v.name = art.bossName(b.seed);
        v.seed = b.seed;
        v.level = b.level;
        v.maxHp = b.maxHp;
        v.damage = b.damage;
        v.hpLeft = b.maxHp - b.damage;
        v.spawnRound = b.spawnRound;
        v.endRound = b.endRound;
        v.fleeRound = b.spawnRound + ESCAPE_ROUNDS;
        v.strikes = b.strikes;
        v.fate = b.fate;
    }

    /// @notice Newest bosses first: ids from `fromId` down, at most `count`.
    function bosses(uint256 fromId, uint256 count) external view returns (BossView[] memory list) {
        uint256 n = _bosses.length;
        if (n == 0 || count == 0) return new BossView[](0);
        if (fromId >= n) fromId = n - 1;
        if (count > fromId + 1) count = fromId + 1;
        list = new BossView[](count);
        for (uint256 i = 0; i < count; ++i) list[i] = boss(fromId - i);
    }

    function currentBoss() external view returns (BossView memory) {
        return boss(_bosses.length - 1);
    }

    struct RaiderView {
        address raider;
        uint16 power;
        uint64 lastCharge;
        uint32 charges;
        uint32 hits;
        uint32 kills;
        uint64 damage;        // credited
        uint64 uncredited;    // already applied to a boss, not yet written to the raider
        uint64 onBoss;        // damage on the boss asked for, credited + uncredited
        uint64[] pending;     // charged rounds not credited yet
    }

    function raider(address who, uint256 bossId) public view returns (RaiderView memory v) {
        Raider storage me = _raiders[who];
        v.raider = who;
        v.power = powerOf(who);
        v.lastCharge = me.lastCharge;
        v.charges = me.charges;
        v.hits = me.hits;
        v.kills = me.kills;
        v.damage = me.damage;
        v.onBoss = damageOf[bossId][who];
        uint256 n = me.pending.length;
        v.pending = new uint64[](n);
        for (uint256 i = 0; i < n; ++i) {
            Pending memory p = me.pending[i];
            v.pending[i] = p.round;
            Round storage rd = rounds[p.round];
            if (!rd.done) continue;
            uint64 d = hitFor(rd.work, p.power, rd.raiders);
            v.uncredited += d;
            if (rd.boss == bossId) v.onBoss += d;
        }
    }

    function raiderCount() external view returns (uint256) {
        return _raiderList.length;
    }

    /// @notice A page of raiders (in order of their first charge) with their damage on `bossId`.
    function raiders(uint256 bossId, uint256 start, uint256 count) external view returns (RaiderView[] memory list) {
        uint256 n = _raiderList.length;
        if (start >= n) return new RaiderView[](0);
        if (count > n - start) count = n - start;
        list = new RaiderView[](count);
        for (uint256 i = 0; i < count; ++i) list[i] = raider(_raiderList[start + i], bossId);
    }

    /// @notice Charged rounds waiting to hit the boss (settled or not), oldest first, at most `count`.
    function queued(uint256 count) external view returns (uint64[] memory list, uint32[] memory raidersIn, uint32[] memory powerIn) {
        uint256 h = queueHead;
        uint256 n = _queue.length - h;
        if (count > n) count = n;
        list = new uint64[](count);
        raidersIn = new uint32[](count);
        powerIn = new uint32[](count);
        for (uint256 i = 0; i < count; ++i) {
            uint64 r = _queue[h + i];
            list[i] = r;
            raidersIn[i] = rounds[r].raiders;
            powerIn[i] = rounds[r].power;
        }
    }

    function queueLength() external view returns (uint256) {
        return _queue.length;
    }

    // ---------------------------------------------------------------- ERC-721 (soulbound trophies)
    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert NoSuchTrophy();
        return _balance[owner];
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _trophy(id).owner;
    }

    function trophy(uint256 id) external view returns (Trophy memory) {
        return _trophy(id);
    }

    function getApproved(uint256 id) external view returns (address) {
        _trophy(id);
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }

    function locked(uint256 id) external view returns (bool) {
        _trophy(id);
        return true;
    }

    function approve(address, uint256) external pure { revert Soulbound(); }
    function setApprovalForAll(address, bool) external pure { revert Soulbound(); }
    function transferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256) external pure { revert Soulbound(); }
    function safeTransferFrom(address, address, uint256, bytes calldata) external pure { revert Soulbound(); }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x01ffc9a7 // ERC-165
            || i == 0x80ac58cd // ERC-721
            || i == 0x5b5e139f // ERC-721 Metadata
            || i == 0xb45a3c0e; // ERC-5192 (soulbound)
    }

    function _trophy(uint256 id) private view returns (Trophy storage t) {
        t = _trophies[id];
        if (t.owner == address(0)) revert NoSuchTrophy();
    }

    function tierName(uint8 t) external view returns (string memory) {
        return art.tierName(t);
    }

    function tokenURI(uint256 id) external view returns (string memory) {
        Trophy storage t = _trophy(id);
        Boss storage b = _bosses[t.boss];
        return art.trophyURI(b.seed, b.level, b.endRound, t.tier, t.killingBlow, t.damage);
    }

    function bossName(uint64 seed) external view returns (string memory) {
        return art.bossName(seed);
    }

    function bossSvg(uint256 id) external view returns (string memory) {
        if (id >= _bosses.length) revert NoSuchBoss();
        Boss storage b = _bosses[id];
        return art.bossSvg(b.seed, b.level, b.fate == 1);
    }
}


/// @title Wheel Raid art
/// @notice Pure renderer for boss names, boss portraits and trophy metadata. Deployed first; WheelRaid points at it.
contract RaidArt {
    function tierName(uint8 t) public pure returns (string memory) {
        return t == 3 ? "Gold" : t == 2 ? "Silver" : "Bronze";
    }

    function trophyURI(uint64 seed, uint32 level, uint64 endRound, uint8 tier, bool kb, uint64 damage) external pure returns (string memory) {
        string memory bn = bossName(seed);
        bytes memory json = abi.encodePacked(
            '{"name":"', tierName(tier), ' trophy: ', bn,
            '","description":"Earned in Wheel Raid by hurting a boss that fell to Squeektoshi\'s real wheel. Damage is the settled SqueekCore work of every round this raider charged.",',
            '"image":"data:image/svg+xml;base64,', _b64(bytes(_trophySvg(seed, level, endRound, tier, kb, damage, bn))), '","attributes":['
        );
        json = abi.encodePacked(json,
            '{"trait_type":"Tier","value":"', tierName(tier), '"},',
            '{"trait_type":"Boss","value":"', bn, '"},',
            '{"trait_type":"Killing blow","value":"', kb ? "Yes" : "No", '"},'
        );
        json = abi.encodePacked(json,
            '{"display_type":"number","trait_type":"Boss level","value":', _u(level), '},',
            '{"display_type":"number","trait_type":"Damage","value":', _u(damage), '},',
            '{"display_type":"number","trait_type":"Fell in round","value":', _u(endRound), '}]}'
        );
        return string(abi.encodePacked("data:application/json;base64,", _b64(json)));
    }

    // ---------------------------------------------------------------- names and art
    function bossName(uint64 seed) public pure returns (string memory) {
        string[16] memory a = ["Grumble", "Snarl", "Gloom", "Rust", "Bramble", "Mildew", "Thorn", "Soot", "Crag", "Murk", "Grizzle", "Wobble", "Ember", "Frost", "Hollow", "Cinder"];
        string[8] memory b = ["maw", "fang", "claw", "tooth", "whisk", "gut", "horn", "snout"];
        string[16] memory c = ["Cheese Golem", "Vacuum Wraith", "Owl King", "Cat of Cinders", "Rusty Gear", "Broom Knight", "Sock Hydra", "Mousetrap Baron", "Dust Bunny", "Moth Queen", "Night Heron", "Clockwork Crow", "Pellet Thief", "Tin Snake", "Fog Toad", "Lantern Eater"];
        return string(abi.encodePacked(a[seed % 16], b[(seed >> 8) % 8], " the ", c[(seed >> 16) % 16]));
    }

    function bossSvg(uint64 seed, uint32 level, bool down) external pure returns (string memory) {
        return string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#160d1f"/>',
            '<circle cx="200" cy="190" r="170" fill="', _hue(seed, 1), '" opacity=".16"/>',
            '<ellipse cx="200" cy="352" rx="130" ry="16" fill="#000" opacity=".45"/>',
            _monster(seed, level, down), '</svg>'
        ));
    }

    function _trophySvg(uint64 seed, uint32 level, uint64 endRound, uint8 tier, bool kb, uint64 damage, string memory bn) private pure returns (string memory) {
        string memory m = tier == 3 ? "#ffc861" : tier == 2 ? "#d7dde8" : "#d08a55";
        bytes memory out = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#120b1a"/>',
            '<rect x="14" y="14" width="372" height="372" rx="22" fill="none" stroke="', m, '" stroke-width="6"/>',
            '<rect x="26" y="26" width="348" height="348" rx="14" fill="none" stroke="', m, '" stroke-width="1.5" opacity=".5"/>'
        );
        out = abi.encodePacked(out, '<g transform="translate(70 40) scale(.65)">', _monster(seed, level, true), '</g>');
        out = abi.encodePacked(out,
            '<text x="200" y="58" text-anchor="middle" font-family="monospace" font-size="15" fill="', m, '" letter-spacing="3">', _upper(tierName(tier)), ' TROPHY</text>'
        );
        out = abi.encodePacked(out, '<text x="200" y="314" text-anchor="middle" font-family="Georgia,serif" font-size="17" fill="#f4ead6">', bn, '</text>');
        out = abi.encodePacked(out,
            '<text x="200" y="340" text-anchor="middle" font-family="monospace" font-size="13" fill="#bda9c9">LV ', _u(level), ' - ', _u(damage), ' DMG - ROUND ', _u(endRound), '</text>'
        );
        if (kb) out = abi.encodePacked(out, '<rect x="130" y="352" width="140" height="22" rx="11" fill="#ff5a4f"/><text x="200" y="368" text-anchor="middle" font-family="monospace" font-size="12" fill="#fff" letter-spacing="2">KILLING BLOW</text>');
        return string(abi.encodePacked(out, '</svg>'));
    }

    function _upper(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; ++i) if (b[i] >= 0x61 && b[i] <= 0x7a) b[i] = bytes1(uint8(b[i]) - 32);
        return string(b);
    }

    function _hue(uint64 seed, uint256 k) private pure returns (string memory) {
        string[8] memory body = ["#7d5ba6", "#4f8a6b", "#a2493f", "#3f6d9e", "#8c6a3a", "#6b4f8a", "#9a4b77", "#4a7f86"];
        string[8] memory glow = ["#c18cff", "#7bd389", "#ff7a59", "#7cc7ff", "#ffc861", "#b59cff", "#ff8fc4", "#7fe0d6"];
        uint256 i = (seed >> 24) % 8;
        return k == 0 ? body[i] : glow[i];
    }

    /// @dev A cute-scary blob monster. Shape, colour, eyes, horns and teeth come from the seed; crowns and spikes
    /// from the level. `down` draws it defeated (X eyes).
    function _monster(uint64 seed, uint32 level, bool down) private pure returns (bytes memory out) {
        string memory f = _hue(seed, 0);
        string memory g = _hue(seed, 1);
        uint256 shape = (seed >> 32) % 3;
        string memory ink = ' stroke="#1b0f22" stroke-width="5" stroke-linejoin="round"';
        // horns behind the body
        uint256 horn = (seed >> 36) % 3;
        if (horn == 1) out = abi.encodePacked('<path d="M140 120 L110 40 L175 100Z M260 120 L290 40 L225 100Z" fill="#f1e4c8"', ink, '/>');
        else if (horn == 2) out = abi.encodePacked('<path d="M150 110 Q100 60 120 20 Q150 70 185 95Z M250 110 Q300 60 280 20 Q250 70 215 95Z" fill="#f1e4c8"', ink, '/>');
        if (level >= 2) out = abi.encodePacked(out, '<path d="M86 150 L30 120 L80 190Z M314 150 L370 120 L320 190Z M76 215 L28 222 L78 250Z M324 215 L372 222 L322 250Z" fill="', g, '"', ink, '/>');
        // feet and clawed arms behind the body
        out = abi.encodePacked(out,
            '<ellipse cx="150" cy="345" rx="34" ry="16" fill="', f, '"', ink, '/><ellipse cx="250" cy="345" rx="34" ry="16" fill="', f, '"', ink, '/>'
        );
        out = abi.encodePacked(out,
            '<path d="M92 250 Q40 262 44 300 Q66 296 100 286Z M308 250 Q360 262 356 300 Q334 296 300 286Z" fill="', f, '"', ink, '/>',
            '<path d="M44 300 l-6 10 M54 300 l-2 12 M356 300 l6 10 M346 300 l2 12" stroke="#f1e4c8" stroke-width="5" stroke-linecap="round"/>'
        );
        // body
        if (shape == 0) out = abi.encodePacked(out, '<path d="M200 90 C300 90 330 180 320 260 C312 330 260 350 200 350 C140 350 88 330 80 260 C70 180 100 90 200 90Z" fill="', f, '"', ink, '/>');
        else if (shape == 1) out = abi.encodePacked(out, '<path d="M200 80 C280 80 310 140 330 210 C350 290 300 350 200 350 C100 350 50 290 70 210 C90 140 120 80 200 80Z" fill="', f, '"', ink, '/>');
        else out = abi.encodePacked(out, '<path d="M120 110 Q200 60 280 110 Q340 150 330 250 Q320 350 200 350 Q80 350 70 250 Q60 150 120 110Z" fill="', f, '"', ink, '/>');
        // markings, belly, sheen
        uint256 mark = (seed >> 48) % 3;
        if (mark == 1) out = abi.encodePacked(out, '<g fill="#1b0f22" opacity=".18"><circle cx="112" cy="200" r="13"/><circle cx="292" cy="186" r="10"/><circle cx="276" cy="300" r="15"/><circle cx="124" cy="296" r="8"/></g>');
        else if (mark == 2) out = abi.encodePacked(out, '<path d="M170 98 q30 -8 60 0 M160 116 q40 -10 80 0" stroke="#1b0f22" stroke-width="7" fill="none" stroke-linecap="round" opacity=".22"/>');
        out = abi.encodePacked(out,
            '<ellipse cx="200" cy="275" rx="78" ry="58" fill="#fff" opacity=".13"/>',
            '<ellipse cx="160" cy="140" rx="34" ry="18" fill="#fff" opacity=".18" transform="rotate(-20 160 140)"/>',
            '<ellipse cx="122" cy="236" rx="16" ry="10" fill="#ff8fa8" opacity=".35"/><ellipse cx="278" cy="236" rx="16" ry="10" fill="#ff8fa8" opacity=".35"/>'
        );
        out = abi.encodePacked(out, _eyes(seed, down), _mouth(seed, down));
        if (level >= 3 && !down) out = abi.encodePacked(out, '<path d="M118 132 L176 150 M282 132 L224 150" stroke="#1b0f22" stroke-width="9" stroke-linecap="round"/>');
        if (level >= 4) out = abi.encodePacked(out, '<path d="M150 92 L160 50 L185 78 L200 40 L215 78 L240 50 L250 92Z" fill="#ffc861"', ink, '/><circle cx="200" cy="66" r="6" fill="#ff5a4f"/>');
        if (!down) out = abi.encodePacked(out, '<g fill="', g, '" opacity=".7"><circle cx="70" cy="110" r="4"/><circle cx="335" cy="140" r="3"/><circle cx="350" cy="250" r="4"/><circle cx="52" cy="240" r="3"/></g>');
    }

    function _eyes(uint64 seed, bool down) private pure returns (bytes memory) {
        uint256 n = 1 + (seed >> 40) % 3;
        if (down) {
            return abi.encodePacked('<path d="M140 165 l30 30 m0 -30 l-30 30 M230 165 l30 30 m0 -30 l-30 30" stroke="#1b0f22" stroke-width="8" stroke-linecap="round"/>');
        }
        string memory pupil = '" r="11" fill="#1b0f22"/>';
        if (n == 1) return abi.encodePacked('<circle cx="200" cy="180" r="40" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/><circle cx="208', '" cy="186', pupil, '<circle cx="214" cy="178" r="4" fill="#fff"/>');
        if (n == 2) return abi.encodePacked(
            '<circle cx="155" cy="180" r="26" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/><circle cx="245" cy="180" r="26" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/>',
            '<circle cx="161" cy="186', pupil, '<circle cx="251" cy="186', pupil,
            '<path d="M128 146 L180 160 M272 146 L220 160" stroke="#1b0f22" stroke-width="7" stroke-linecap="round"/>'
        );
        return abi.encodePacked(
            '<circle cx="150" cy="190" r="20" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/><circle cx="250" cy="190" r="20" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/><circle cx="200" cy="150" r="24" fill="#fff8ea" stroke="#1b0f22" stroke-width="5"/>',
            '<circle cx="155" cy="194', pupil, '<circle cx="255" cy="194', pupil, '<circle cx="205" cy="155', pupil
        );
    }

    function _mouth(uint64 seed, bool down) private pure returns (bytes memory) {
        if (down) return abi.encodePacked('<path d="M165 270 Q200 250 235 270" stroke="#1b0f22" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M240 120 q10 14 0 22 q-10 -8 0 -22z" fill="#7cc7ff"/>');
        uint256 m = (seed >> 44) % 2;
        if (m == 0) return abi.encodePacked(
            '<path d="M140 245 Q200 300 260 245 Q200 270 140 245Z" fill="#3a0f1e" stroke="#1b0f22" stroke-width="5" stroke-linejoin="round"/>',
            '<path d="M160 252 l8 14 l8 -12 M224 254 l8 12 l8 -14" fill="#fff8ea" stroke="#1b0f22" stroke-width="2"/>'
        );
        return abi.encodePacked(
            '<path d="M150 250 Q200 230 250 250 Q250 290 200 292 Q150 290 150 250Z" fill="#3a0f1e" stroke="#1b0f22" stroke-width="5" stroke-linejoin="round"/>',
            '<path d="M158 250 l10 16 l10 -18 l10 16 l12 -18 l12 18 l10 -16 l10 18 l10 -16" fill="#fff8ea" stroke="#1b0f22" stroke-width="2" stroke-linejoin="round"/>'
        );
    }

    // ---------------------------------------------------------------- utils
    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) ++len;
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }

    /// @dev Base64 encoding, adapted from OpenZeppelin Contracts (MIT), Base64.sol.
    function _b64(bytes memory data) private pure returns (string memory result) {
        if (data.length == 0) return "";
        string memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        result = new string(4 * ((data.length + 2) / 3));
        assembly ("memory-safe") {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 0x20)
            let dataPtr := data
            let endPtr := add(data, mload(data))
            let afterPtr := add(endPtr, 0x20)
            let afterCache := mload(afterPtr)
            mstore(afterPtr, 0x00)
            for {} lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }
            mstore(afterPtr, afterCache)
            switch mod(mload(data), 3)
            case 1 {
                mstore8(sub(resultPtr, 1), 0x3d)
                mstore8(sub(resultPtr, 2), 0x3d)
            }
            case 2 {
                mstore8(sub(resultPtr, 1), 0x3d)
            }
        }
    }
}
