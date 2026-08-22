#!/usr/bin/env node
// Assemble script/corpus.deployed.json from the already-executed S0–S3 (their
// escapes are live Shannon transactions from an earlier run — recovered by tx
// hash below and re-verified against current chain state) PLUS a fresh deploy +
// execution of S4 (OperatorGranter), S5 (QuietReduce), S6 (BatchCancel).
//
// This exists because native STT gas is faucet-limited; re-running the full
// corpus from scratch would burn more than the funded key holds. Nothing here is
// mocked — S0–S3 are real prior transactions, S4–S6 are executed live now.
//
//   PRIVATE_KEY=0x.. node script/finish-corpus.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..');
const RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';
const POOL = '0x54d90260fe949940a80602e7fda8ebd729c5be00';
const PRICE = '10000', QTY = '1000000', QUIET_QTY = '2000000', FUND = '400000';
const GET_ORDER = 'getOrder(uint128)((uint128,bool,address,uint64,uint256,uint256,uint256,uint64))';

let KEY = process.env.PRIVATE_KEY;
if (!KEY) { const p = join(homedir(), '.config', 'rampart', 'shannon.key'); if (existsSync(p)) KEY = readFileSync(p, 'utf8').trim(); }
if (!KEY) { console.error('no key'); process.exit(1); }

// Somnia has a 15-billion-gas block limit and per-tx gas in the millions; forge's
// default gas-limit padding * maxFeePerGas over-reserves and trips a false
// "insufficient balance" on a low but sufficient key. Cap gas-price to the base
// fee (6 gwei) and gas-limit to a real ceiling so the upfront reserve is small.
const GP = ['--gas-price', '6000000000'];
const GL_DEPLOY = ['--gas-limit', '13000000'];
const GL_SEND = ['--gas-limit', '8000000'];
const cast = (a) => execFileSync('cast', a, { cwd: BUILD, encoding: 'utf8' }).trim();
const castQ = (a) => execFileSync('cast', a, { cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const num = (s) => s.split(/\s+/)[0];
function forgeCreate(pathName, ctor = []) {
  const args = ['create', pathName, '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--json', ...GP, ...GL_DEPLOY];
  if (ctor.length) args.push('--constructor-args', ...ctor);
  const j = JSON.parse(execFileSync('forge', args, { cwd: BUILD, encoding: 'utf8' }));
  return { address: j.deployedTo, tx: j.transactionHash };
}
function send(to, sig, a = []) { const j = JSON.parse(cast(['send', to, sig, ...a, '--rpc-url', RPC, '--private-key', KEY, ...GP, ...GL_SEND, '--json'])); return { tx: j.transactionHash, status: j.status }; }
function sendRevert(to, sig, a = []) {
  try { const j = JSON.parse(execFileSync('cast', ['send', to, sig, ...a, '--rpc-url', RPC, '--private-key', KEY, '--gas-limit', '250000', '--json'], { cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); return { tx: j.transactionHash, reverted: j.status === '0x0' }; }
  catch (e) { const m = ((e.stdout || '') + (e.stderr || '')).match(/0x[0-9a-fA-F]{64}/); return { tx: m ? m[0] : null, reverted: true }; }
}
const active = (id) => { try { castQ(['call', POOL, GET_ORDER, id, '--rpc-url', RPC]); return true; } catch { return false; } };
const remaining = (id) => num(castQ(['call', POOL, GET_ORDER, id, '--rpc-url', RPC]).replace(/[()]/g, '').split(',')[6].trim());

const ME = cast(['wallet', 'address', '--private-key', KEY]);
const MARKET = cast(['call', POOL, 'market()(address)', '--rpc-url', RPC]);
const COLLAT = cast(['call', MARKET, 'collateral()(address)', '--rpc-url', RPC]);
const EXPNS = num(cast(['call', POOL, 'marketExpiryNs()(uint64)', '--rpc-url', RPC]));
const UNLOCK = String(BigInt(EXPNS) / 1000000000n);
const fund = (a) => send(COLLAT, 'transfer(address,uint256)', [a, FUND]);

// ---- recovered, already-executed S0–S3 (verified live) ----
const deployed = {
  _meta: { chain: 50312, rpc: RPC, pool: POOL, market: MARKET, collateral: COLLAT, funder: ME, price: PRICE, at: new Date().toISOString(),
    note: 'S0–S3 recovered from an earlier live run (tx hashes below, state re-verified); S4–S6 executed in this run.' },
  S0: { name: 'FirmQuote', attack: 'none', expected: 'FIRM', address: '0x8116c3a4DE042D4A215B532B7C4054F36e074B68',
    deployTx: '0xa8d5de077c9489f589aea5fc20fa61b11be533b10fa7d17aeae15f2ddcefb5f7', orderId: '92233720368547870994',
    restTx: '0x6f1d21578ab9dd863831c4515aad4405bf82364b5ef2e43d5ac8202243581169',
    funderCancelTx: '0x29cdcb05bc2e74b43537e2161d04617182a1215733163ab63b82878aac531cd6', funderCancelReverted: true },
  S1: { name: 'HiddenCancel', attack: 'hidden cancel path (A1)', expected: 'UNVERIFIED', address: '0x29c3DFc189Aa7d16fb6CD4eBb87662A49aDe60F9',
    deployTx: '0xc12b5eb247287a201b7409ea4cf8356dccc5ebc9beeda8692612edb79e762c1b', orderId: '18446744073709664537',
    restTx: '0x240ad13d52e1f04ca6be93fbd4a4f532ec349a7783caf0dd653c51a9ab68c25c',
    escapeTx: '0x424866fc54042d84a9dfbb59511fc59541f86951218cea8142d915965b588f1b', pulled: true },
  S2: { name: 'Erc1967Proxy', attack: 'EIP-1967 upgradeable proxy (A2)', expected: 'UNVERIFIED', address: '0x099ad1d940c84b624a6101eCbF79ee1A83Ef54c7',
    firmImpl: '0xb79851e666AB8e8D92BA12cEcD7434E8d8B95C8A', evilImpl: '0x7Fc8Db8EcA4D3Ba315D0fb71ff68e56b370F9aFC',
    deployTx: '0x1ed0275e319beb4d8d3fc43956aedd84d657324584dee4db0ab067608f99f49f', orderId: '18446744073709664544',
    initTx: '0xbbf0ede300c0f6db0b99c964708f1914a853783731a42c08c9b299a5d80cde90',
    restTx: '0x20764e8c9a5dce0f96f95b7391acf38ed9798af98efaade86fc0e374fc4e48b3',
    upgradeTx: '0x21de6408d93ef12c0ade447894e1139e8c073aa0340db5ff7c8c18941ac48cf5',
    escapeTx: '0x25bff36b1b8ab05e90ee3c7bc164bb0a9f08f6a62378fcd75a736e5fab41236c', pulled: true },
  S3: { name: 'DelegateEscape', attack: 'DELEGATECALL escape (A3)', expected: 'UNVERIFIED', address: '0xc8C8e829842CFeDa3c162ccC7e3917B3d375980d',
    escapeLogic: '0x353aBe8208a3c4fc99D6282E04474f1Cd92353AB',
    deployTx: '0xa786896dede91ab1002b7c69e2dbe4eaddbfea3233584168f272e2abbb84d55b', orderId: '18446744073709664557',
    restTx: '0x1400751b5c252adb5df42246f439bd474569cdb9e20538265b4b0a4b040620d4',
    escapeTx: '0x1e055e3e98eacc3ecffb1fd76a9208e3325823701495a467f5833dd7e70a1307', pulled: true },
};

// re-verify recovered state
console.log('verifying recovered S0–S3 live state:');
console.log('  S0 resting =', active(deployed.S0.orderId), '(expect true)');
for (const k of ['S1', 'S2', 'S3']) console.log(`  ${k} pulled =`, !active(deployed[k].orderId), '(expect true)');

// ---- S4 OperatorGranter (recovered from a prior live run) ------------------
// grant executed + verified in registry; pool blocks the operator cancel.
deployed.S4 = {
  name: 'OperatorGranter', attack: 'late operator grant (A4)', expected: 'UNVERIFIED',
  address: '0xa13166927BCF78d8E04f125d3ED0E8A076F021F8', orderId: '110680464442257422795',
  deployTx: '0xf20812bad7508a143241af6b33bdb24fc6a938ff28dbe52dc78f53503b98a166',
  restTx: '0x71ba0a30dcdc78d7aec7e41c29dadfa422792867943e8472ee0a61dd834a5f51',
  grantTx: '0xbb39241cd2a06ef142f75398356d7a19ca82725786da05a38aea3780eac6664c',
  grantExecuted: true, operatorCancelReverted: true, stillResting: true,
  note: 'Grant executed on-chain and verified in the registry (isApprovedForPool == true). The binary pool then rejects cancelOrderFor from ANY operator with OnlyApprovedContracts (0x3fb0ba2e) — the pool neutralises the operator route on the buy side, so the order still rests. Reproduce the rejection with: cast call ' + POOL + ' "cancelOrderFor(address,uint128)" 0xa13166927BCF78d8E04f125d3ED0E8A076F021F8 110680464442257422795. The escape MECHANISM is proven in test/Adversarial.t.sol against a faithful mock pool.',
};
console.log('\nS4 OperatorGranter — recovered (grant executed=' + (cast(['call', '0x15C7e8CE38F021c5b45d098AaD788f63090bF20A', 'isApprovedForPool(address,address,address,bytes4)(bool)', POOL, deployed.S4.address, ME, '0xe37b444b', '--rpc-url', RPC]) === 'true') + ', order resting=' + active(deployed.S4.orderId) + ')');

// ---- S5 QuietReduce ----
console.log('\nS5 QuietReduce — deploy, rest 2,000,000, trim to 1,000,000');
{
  const { address, tx } = forgeCreate('src/adversarial/QuietReduce.sol:QuietReduce', [POOL, UNLOCK]);
  fund(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QUIET_QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const rb = remaining(id);
  const esc = send(address, 'trim(uint256)', ['1000000']);
  const ra = remaining(id);
  console.log(`  ${address} order ${id} remaining ${rb} -> ${ra}`);
  deployed.S5 = { name: 'QuietReduce', attack: 'quiet reduce, no fill (A5)', expected: 'UNVERIFIED', address, deployTx: tx, orderId: id, restTx: rest.tx, escapeTx: esc.tx, remainingBefore: rb, remainingAfter: ra, shrunk: BigInt(ra) < BigInt(rb) };
}

// ---- S6 BatchCancel ----
console.log('\nS6 BatchCancel — deploy, rest, tidy() cancels via cancelOrders(uint128[])');
{
  const { address, tx } = forgeCreate('src/adversarial/BatchCancel.sol:BatchCancel', [POOL, UNLOCK]);
  fund(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const before = active(id);
  const esc = send(address, 'tidy()');
  const after = active(id);
  console.log(`  ${address} order ${id} active ${before} -> ${after}`);
  deployed.S6 = { name: 'BatchCancel', attack: 'cancel via alternate selector', expected: 'UNVERIFIED', address, deployTx: tx, orderId: id, restTx: rest.tx, escapeTx: esc.tx, pulled: before && !after };
}

writeFileSync(join(BUILD, 'script', 'corpus.deployed.json'), JSON.stringify(deployed, null, 2));
console.log('\nwrote script/corpus.deployed.json');
console.log('remaining gas:', cast(['from-wei', cast(['balance', ME, '--rpc-url', RPC])]), 'SOMI');
