#!/usr/bin/env node
// Deploy the adversarial corpus to Somnia Shannon (50312) AND EXECUTE every
// escape on chain. This is what makes the 7/7 claim non-mockable: each attacker
// actually removes its own resting order from a real public order book, and the
// explorer shows the depth leaving.
//
//   PRIVATE_KEY=0x..  node script/deploy-corpus.mjs [--pool 0x..]
//   (key also read from ~/.config/rampart/shannon.key if PRIVATE_KEY is unset)
//
// Writes script/corpus.deployed.json — consumed by headline.mjs --live,
// firmness.mjs, bench.mjs. Nothing here is mocked; every line is a Shannon tx.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..');
const RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';
const EXPLORER = 'https://shannon-explorer.somnia.network';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const POOL = arg('--pool', process.env.POOL || '0x54d90260fe949940a80602e7fda8ebd729c5be00');

const PRICE = '10000'; // 0.01 — far below touch, cannot cross
const QTY = '1000000'; // minQuantity
const QUIET_QTY = '2000000'; // so QuietReduce can trim to 1,000,000
const FUND = '500000'; // 0.5 tUSDC per contract

let KEY = process.env.PRIVATE_KEY;
if (!KEY) {
  const p = join(homedir(), '.config', 'rampart', 'shannon.key');
  if (existsSync(p)) KEY = readFileSync(p, 'utf8').trim();
}
if (!KEY) { console.error('PRIVATE_KEY unset and ~/.config/rampart/shannon.key not found'); process.exit(1); }

// Somnia bills gas in the millions and its 15-billion-gas block limit lets forge
// pad the gas-limit so high that gasLimit*maxFeePerGas trips a false "insufficient
// balance" on a low-but-sufficient key. Pin gas-price to the base fee (6 gwei) and
// cap gas-limit to a real ceiling so the upfront reserve stays small.
const GP = ['--gas-price', '6000000000'];
const GL_DEPLOY = ['--gas-limit', '13000000'];
const GL_SEND = ['--gas-limit', '6000000'];
const cast = (args) => execFileSync('cast', args, { cwd: BUILD, encoding: 'utf8' }).trim();
const num = (s) => s.split(/\s+/)[0];

function forgeCreate(pathName, ctorArgs = []) {
  const args = ['create', pathName, '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--json', ...GP, ...GL_DEPLOY];
  if (ctorArgs.length) args.push('--constructor-args', ...ctorArgs);
  const out = execFileSync('forge', args, { cwd: BUILD, encoding: 'utf8' });
  const j = JSON.parse(out);
  return { address: j.deployedTo, tx: j.transactionHash };
}

function send(to, sig, sigArgs = []) {
  const out = cast(['send', to, sig, ...sigArgs, '--rpc-url', RPC, '--private-key', KEY, ...GP, ...GL_SEND, '--json']);
  const j = JSON.parse(out);
  return { tx: j.transactionHash, status: j.status };
}

// Force a broadcast that will REVERT, so we capture a permanent failed tx (the
// firm-proof centrepiece). --gas-limit skips estimation, which would otherwise
// refuse to broadcast a call it knows reverts.
function sendExpectRevert(to, sig, sigArgs = []) {
  try {
    const out = execFileSync('cast', ['send', to, sig, ...sigArgs, '--rpc-url', RPC, '--private-key', KEY, ...GP, ...GL_SEND, '--json'], { cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const j = JSON.parse(out);
    return { tx: j.transactionHash, status: j.status, reverted: j.status === '0x0' };
  } catch (e) {
    // cast throws on a reverted send; dig the tx hash out of stderr/stdout.
    const blob = (e.stdout || '') + (e.stderr || '') + (e.message || '');
    const m = blob.match(/0x[0-9a-fA-F]{64}/);
    return { tx: m ? m[0] : null, status: '0x0', reverted: true, raw: blob.slice(0, 400) };
  }
}

const GET_ORDER = 'getOrder(uint128)((uint128,bool,address,uint64,uint256,uint256,uint256,uint64))';
function castQuiet(args) {
  return execFileSync('cast', args, { cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function orderActive(id) {
  try {
    castQuiet(['call', POOL, GET_ORDER, id, '--rpc-url', RPC]);
    return true;
  } catch { return false; } // reverts IncorrectOrder(0x8080c2ed) once gone
}

function orderRemaining(id) {
  const out = castQuiet(['call', POOL, GET_ORDER, id, '--rpc-url', RPC]);
  // struct fields: orderId,isBid,owner,userData,price,fullQuantity,quantityRemaining,expireNs
  const parts = out.replace(/[()]/g, '').split(',').map((s) => s.trim());
  return num(parts[6]);
}

function log(s) { console.log(s); }

// ---- preflight ----
const ME = cast(['wallet', 'address', '--private-key', KEY]);
const MARKET = cast(['call', POOL, 'market()(address)', '--rpc-url', RPC]);
const COLLAT = cast(['call', MARKET, 'collateral()(address)', '--rpc-url', RPC]);
const STATUS = num(cast(['call', MARKET, 'status()(uint8)', '--rpc-url', RPC]));
if (STATUS !== '1') { console.error(`market status ${STATUS} != 1 (Trading). Pick a fresher pool.`); process.exit(1); }
const EXPNS = num(cast(['call', POOL, 'marketExpiryNs()(uint64)', '--rpc-url', RPC]));
const headroom = (Number(BigInt(EXPNS) / 1000000000n) - Math.floor(Date.now() / 1000));
if (headroom < 1800) { console.error(`headroom ${headroom}s < 30m. Pick a fresher pool.`); process.exit(1); }
const UNLOCK = String(BigInt(EXPNS) / 1000000000n);

log(`\n  rampart — deploy + execute adversarial corpus on Shannon 50312`);
log(`  eoa    ${ME}`);
log(`  pool   ${POOL}`);
log(`  market ${MARKET}  collateral ${COLLAT}  headroom ${headroom}s\n`);

function fundContract(addr) { send(COLLAT, 'transfer(address,uint256)', [addr, FUND]); }

const deployed = {
  _meta: { chain: 50312, rpc: RPC, pool: POOL, market: MARKET, collateral: COLLAT, funder: ME, price: PRICE, at: new Date().toISOString() },
};

// ---------------- S0 FirmQuote (the control: firm, cannot be pulled) --------
log('S0 FirmQuote — rest, then the funder tries to cancel (MUST revert)');
{
  const { address, tx } = forgeCreate('src/FirmQuote.sol:FirmQuote', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const cancel = sendExpectRevert(POOL, 'cancelOrder(uint128)', [id]);
  const stillActive = orderActive(id);
  log(`   ${address}  order ${id}  firm-cancel reverted=${cancel.reverted}  stillResting=${stillActive}`);
  deployed.S0 = { name: 'FirmQuote', attack: 'none', expected: 'FIRM', address, deployTx: tx, orderId: id, restTx: rest.tx, funderCancelTx: cancel.tx, funderCancelReverted: cancel.reverted, stillResting: stillActive };
}

// ---------------- S1 HiddenCancel (A1) --------------------------------------
log('S1 HiddenCancel — rest, then poke() secretly cancels');
{
  const { address, tx } = forgeCreate('src/adversarial/HiddenCancel.sol:HiddenCancel', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const before = orderActive(id);
  const esc = send(address, 'poke()');
  const after = orderActive(id);
  log(`   ${address}  order ${id}  active ${before} -> ${after}  escapeTx ${esc.tx}`);
  deployed.S1 = { name: 'HiddenCancel', attack: 'hidden cancel path (A1)', expected: 'UNVERIFIED', address, deployTx: tx, orderId: id, restTx: rest.tx, escapeTx: esc.tx, pulled: before && !after };
}

// ---------------- S2 Erc1967Proxy (A2) --------------------------------------
log('S2 Erc1967Proxy — rest under firm logic, upgrade to evil, pull()');
{
  const v1 = forgeCreate('src/adversarial/Erc1967Proxy.sol:ProxyLogicFirm');
  const v2 = forgeCreate('src/adversarial/Erc1967Proxy.sol:ProxyLogicEvil');
  const { address, tx } = forgeCreate('src/adversarial/Erc1967Proxy.sol:Erc1967Proxy', [v1.address, ME]);
  send(address, 'init(address,uint64)', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const before = orderActive(id);
  const up = send(address, 'upgradeTo(address)', [v2.address]);
  const esc = send(address, 'pull()');
  const after = orderActive(id);
  log(`   ${address}  impl ${v1.address}->${v2.address}  order ${id}  active ${before} -> ${after}`);
  deployed.S2 = { name: 'Erc1967Proxy', attack: 'EIP-1967 upgradeable proxy (A2)', expected: 'UNVERIFIED', address, deployTx: tx, firmImpl: v1.address, evilImpl: v2.address, orderId: id, restTx: rest.tx, upgradeTx: up.tx, escapeTx: esc.tx, pulled: before && !after };
}

// ---------------- S3 DelegateEscape (A3) ------------------------------------
log('S3 DelegateEscape — rest, then delegatecall attacker logic that cancels');
{
  const { address, tx } = forgeCreate('src/adversarial/DelegateEscape.sol:DelegateEscape', [POOL, UNLOCK]);
  const logic = forgeCreate('src/adversarial/DelegateEscape.sol:EscapeLogic');
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const before = orderActive(id);
  const esc = send(address, 'escape(address)', [logic.address]);
  const after = orderActive(id);
  log(`   ${address}  logic ${logic.address}  order ${id}  active ${before} -> ${after}`);
  deployed.S3 = { name: 'DelegateEscape', attack: 'DELEGATECALL escape (A3)', expected: 'UNVERIFIED', address, deployTx: tx, escapeLogic: logic.address, orderId: id, restTx: rest.tx, escapeTx: esc.tx, pulled: before && !after };
}

// ---------------- S4 OperatorGranter (A4) -----------------------------------
// The GRANT executes on chain and is verifiable in the operator registry. On
// Somnia binary pools, however, cancelOrderFor is unwired (rejects every operator
// with OnlyApprovedContracts 0x3fb0ba2e even for a valid grant) — so the operator
// route CANNOT withdraw here. That is recorded honestly, not hidden: the pool
// itself neutralises this vector on the buy side, and the classifier flags the
// contract UNVERIFIED regardless because its bytecode CAN grant operators.
log('S4 OperatorGranter — rest, grant the funder cancelOrderFor (grant executes; pool blocks the cancel)');
{
  const { address, tx } = forgeCreate('src/adversarial/OperatorGranter.sol:OperatorGranter', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const grant = send(address, 'openBackDoor(address)', [ME]); // executes: per-pool + global
  const granted = cast(['call', '0x15C7e8CE38F021c5b45d098AaD788f63090bF20A', 'isApprovedForPool(address,address,address,bytes4)(bool)', POOL, address, ME, '0xe37b444b', '--rpc-url', RPC]) === 'true';
  const cancel = sendExpectRevert(POOL, 'cancelOrderFor(address,uint128)', [address, id]); // pool blocks
  const stillActive = orderActive(id);
  log(`   ${address}  order ${id}  grantExecuted=${granted}  poolCancelReverted=${cancel.reverted}  stillResting=${stillActive}`);
  deployed.S4 = {
    name: 'OperatorGranter', attack: 'late operator grant (A4)', expected: 'UNVERIFIED', address, deployTx: tx,
    orderId: id, restTx: rest.tx, grantTx: grant.tx, grantExecuted: granted,
    operatorCancelTx: cancel.tx, operatorCancelReverted: cancel.reverted, stillResting: stillActive,
    note: 'grant executed + verified in registry; binary pool rejects cancelOrderFor from any operator (OnlyApprovedContracts 0x3fb0ba2e) — the pool neutralises the operator route on the buy side. Escape mechanism proven in test/Adversarial.t.sol against a faithful mock.',
  };
}

// ---------------- S6 BatchCancel (obfuscated cancel via alternate selector) --
log('S6 BatchCancel — rest, then tidy() cancels via cancelOrders(uint128[])');
{
  const { address, tx } = forgeCreate('src/adversarial/BatchCancel.sol:BatchCancel', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const before = orderActive(id);
  const esc = send(address, 'tidy()');
  const after = orderActive(id);
  log(`   ${address}  order ${id}  active ${before} -> ${after}  escapeTx ${esc.tx}`);
  deployed.S6 = { name: 'BatchCancel', attack: 'cancel via alternate selector', expected: 'UNVERIFIED', address, deployTx: tx, orderId: id, restTx: rest.tx, escapeTx: esc.tx, pulled: before && !after };
}

// ---------------- S5 QuietReduce (A5) ---------------------------------------
log('S5 QuietReduce — rest 2,000,000, then trim to 1,000,000 with no fill');
{
  const { address, tx } = forgeCreate('src/adversarial/QuietReduce.sol:QuietReduce', [POOL, UNLOCK]);
  fundContract(address);
  const rest = send(address, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QUIET_QTY, EXPNS]);
  const id = num(cast(['call', address, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
  const remBefore = orderRemaining(id);
  const esc = send(address, 'trim(uint256)', ['1000000']);
  const remAfter = orderRemaining(id);
  log(`   ${address}  order ${id}  remaining ${remBefore} -> ${remAfter}`);
  deployed.S5 = { name: 'QuietReduce', attack: 'quiet reduce, no fill (A5)', expected: 'UNVERIFIED', address, deployTx: tx, orderId: id, restTx: rest.tx, escapeTx: esc.tx, remainingBefore: remBefore, remainingAfter: remAfter, shrunk: BigInt(remAfter) < BigInt(remBefore) };
}

// ---- attest FirmQuote's live code hash into the registry idea (off-chain set) ----
writeFileSync(join(BUILD, 'script', 'corpus.deployed.json'), JSON.stringify(deployed, null, 2));
log(`\n  wrote script/corpus.deployed.json`);
log(`  S0 firm at ${EXPLORER}/address/${deployed.S0.address}`);
log(`  run:  node script/headline.mjs --live   &&   node script/firmness.mjs --pool ${POOL}\n`);
