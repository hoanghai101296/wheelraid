// Compiles WheelRaid.sol alone with the release settings and writes the files needed to deploy and verify it.
const solc = require('solc'); const fs = require('fs');
const optimize = process.env.NOOPT !== '1';
const input = { language: 'Solidity', sources: { 'WheelRaid.sol': { content: fs.readFileSync('../contracts/WheelRaid.sol', 'utf8') } },
  settings: { optimizer: { enabled: optimize, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter(e => e.severity === 'error'); if (errs.length) { console.log(errs.map(e => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['WheelRaid.sol'].WheelRaid; const size = c.evm.deployedBytecode.object.length / 2;
console.log('solc', solc.version(), 'optimizer', optimize, 'runtime bytes', size, size <= 24576 ? 'OK' : 'TOO BIG');
if (!optimize) process.exit(0);
fs.mkdirSync('../release', { recursive: true });
fs.writeFileSync('../release/WheelRaid.abi.json', JSON.stringify(c.abi, null, 1));
fs.writeFileSync('../release/standard-input.json', JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } } }, null, 1));
fs.writeFileSync('../release/metadata.json', c.metadata);
fs.writeFileSync('../release/bytecode.txt', '0x' + c.evm.bytecode.object);
const ra = out.contracts['WheelRaid.sol'].RaidArt; fs.writeFileSync('../release/RaidArt.bytecode.txt', '0x' + ra.evm.bytecode.object); fs.writeFileSync('../release/RaidArt.abi.json', JSON.stringify(ra.abi, null, 1)); fs.writeFileSync('../release/RaidArt.metadata.json', ra.metadata);
console.log('RaidArt runtime bytes', ra.evm.deployedBytecode.object.length / 2);
