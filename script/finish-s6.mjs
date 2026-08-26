#!/usr/bin/env node
// Execute the S6 batch-cancel escape ON-CHAIN, for real.
//
//   node script/finish-s6.mjs [--pool 0x..] [--dry]
//
// WHY A SECOND DEPLOYMENT RATHER THAN REUSING S6.
//
// The original S6 (0xb3e6…af54) rested a real order on 2026-08-22 but its `tidy()` was
// never sent: the batch cancel needs ~3M gas and the funder key was down to 0.009 SOMI
// (native STT is browser-faucet only). By the time the key was funded, the testnet
// market behind that pool had reached status 4 — terminal — and the order had been
// swept. `getOrder` on it now reverts `IncorrectOrder()`.
//
// Sending `tidy()` to the original S6 today would SUCCEED and cancel NOTHING:
// `cancelOrders` is best-effort and silently skips ids it does not own. A green
// transaction hash proving nothing is worse than an honest gap, so that is not what
// this does.
//
// `QuoteBase.pool` is immutable, so the original S6 can never rest again. This deploys
// a fresh BatchCancel against a CURRENTLY TRADING pool and runs the full sequence —
// fund, rest, tidy — so the escape is executed rather than asserted. The original S6
// record is left exactly as it was: it is the historical truth of what happened.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');
const POOL = arg('--pool', '0xf50f7a2d4beaef6c875f6155a88a1348917c7f9f'); // ETH 24h, Trading

let KEY = process.env.PRIVATE_KEY;
if (!KEY) {
  const p = join(homedir(), '.config', 'rampart', 'shannon.key');
  if (existsSync(p)) KEY = readFileSync(p, 'utf8').trim();
}
if (!KEY) { console.error('PRIVATE_KEY unset and ~/.config/rampart/shannon.key not found'); process.exit(1); }

const GP = ['--gas-price', '6000000000'];
const GL_DEPLOY = ['--gas-limit', '13000000'];
const GL_SEND = ['--gas-limit', '6000000'];
const PRICE = '10000';   // 0.01 — far below the touch, so it CANNOT cross and must rest
const QTY = '1000000';   // minQuantity
const FUND = '500000';   // 0.5 tUSDC

const cast = (a) => execFileSync('cast', a, { cwd: BUILD, encoding: 'utf8' }).trim();
const forge = (a) => execFileSync('forge', a, { cwd: BUILD, encoding: 'utf8' }).trim();
const num = (s) => String(s).split(' ')[0].replace(/[^\d]/g, '');
const send = (to, sig, args = []) => {
  const j = JSON.parse(cast(['send', to, sig, ...args, '--rpc-url', RPC, '--private-key', KEY, '--json', ...GP, ...GL_SEND]));
  if (j.status !== '0x1') throw new Error(`tx reverted: ${sig} ${j.transactionHash}`);
  return j.transactionHash;
};
/** true when the pool still holds this order; getOrder reverts IncorrectOrder() once
 *  it is gone. stderr is muted because that revert is the EXPECTED outcome after the
 *  escape, and letting cast print it makes a successful run look like a failure. */
const orderActive = (id) => {
  try {
    execFileSync('cast', ['call', POOL, 'getOrder(uint128)', id, '--rpc-url', RPC],
                 { cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
};

const ME = cast(['wallet', 'address', '--private-key', KEY]);
const MARKET = cast(['call', POOL, 'market()(address)', '--rpc-url', RPC]);
const COLLAT = cast(['call', MARKET, 'collateral()(address)', '--rpc-url', RPC]);
const STATUS = num(cast(['call', MARKET, 'status()(uint8)', '--rpc-url', RPC]));
const EXPNS = num(cast(['call', POOL, 'marketExpiryNs()(uint64)', '--rpc-url', RPC]));
const UNLOCK = String(BigInt(EXPNS) / 1000000000n);
const headroom = Number(UNLOCK) - Math.floor(Date.now() / 1000);

console.log(`\n  funder    ${ME}`);
console.log(`  pool      ${POOL}`);
console.log(`  market    ${MARKET}   status ${STATUS}${STATUS === '1' ? ' (Trading)' : ' — NOT TRADING'}`);
console.log(`  headroom  ${headroom}s  (${(headroom / 3600).toFixed(1)}h)`);
console.log(`  balance   ${cast(['balance', ME, '--rpc-url', RPC, '--ether'])} SOMI · ${cast(['call', COLLAT, 'balanceOf(address)(uint256)', ME, '--rpc-url', RPC]).split(' ')[0]} tUSDC\n`);

// Refuse to run against a market that cannot host a resting order — that is exactly
// the situation that made the original attempt meaningless.
if (STATUS !== '1') { console.error(`  market status ${STATUS} is not Trading — a rested order would be swept. Pick another --pool.`); process.exit(1); }
if (headroom < 900) { console.error(`  only ${headroom}s of headroom — too close to expiry to prove anything.`); process.exit(1); }
if (DRY) { console.log('  --dry: nothing sent.\n'); process.exit(0); }

console.log('  1/4 deploying BatchCancel…');
const created = JSON.parse(forge(['create', 'src/adversarial/BatchCancel.sol:BatchCancel',
  '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--json', ...GP, ...GL_DEPLOY,
  '--constructor-args', POOL, UNLOCK]));
const addr = created.deployedTo;
console.log(`      ${addr}   tx ${created.transactionHash}`);

console.log('  2/4 funding with 0.5 tUSDC…');
const fundTx = send(COLLAT, 'transfer(address,uint256)', [addr, FUND]);
console.log(`      tx ${fundTx}`);

console.log('  3/4 resting a BUY_YES at 0.01 (far below touch — cannot cross)…');
const restTx = send(addr, 'rest(uint8,uint256,uint256,uint64)', ['0', PRICE, QTY, EXPNS]);
const id = num(cast(['call', addr, 'orders(uint256)(uint128)', '0', '--rpc-url', RPC]));
const activeBefore = orderActive(id);
const ownerBefore = cast(['call', POOL, 'getOrder(uint128)', id, '--rpc-url', RPC]);
console.log(`      order ${id}   active=${activeBefore}   tx ${restTx}`);

console.log('  4/4 tidy() — cancelOrders(uint128[]) via the ALTERNATE selector…');
const escapeTx = send(addr, 'tidy()');
const activeAfter = orderActive(id);
console.log(`      active=${activeBefore} -> ${activeAfter}   tx ${escapeTx}`);

const pulled = activeBefore && !activeAfter;
console.log(`\n  ESCAPE ${pulled ? 'EXECUTED — depth vanished with no fill' : 'DID NOT EXECUTE'}\n`);

const out = join(BUILD, 'script', 's6.executed.json');
writeFileSync(out, JSON.stringify({
  _meta: {
    chain: 50312, rpc: RPC, explorer: 'https://shannon-explorer.somnia.network',
    note: 'SECOND BatchCancel deployment, on a live pool, executing the escape the original S6 '
        + '(0xb3e609021C6839dF5A407d62D26Add74a2C8af54) never got to run. The original was rested on '
        + '2026-08-22 but its tidy() was gas-blocked, and by 2026-08-26 that pool\'s market had reached '
        + 'status 4 (terminal) and the order was swept — getOrder reverts IncorrectOrder(). Sending tidy() '
        + 'there now would succeed while cancelling nothing, because cancelOrders is best-effort. '
        + 'QuoteBase.pool is immutable, so a fresh deployment on a Trading pool is the only honest way to '
        + 'execute it. The original record is unchanged.',
  },
  contract: 'BatchCancel', attack: 'cancel via alternate selector cancelOrders(uint128[])',
  address: addr, pool: POOL, market: MARKET, collateral: COLLAT,
  deployTx: created.transactionHash, fundTx, restTx, escapeTx,
  orderId: id, activeBefore, activeAfter, pulled,
  orderBeforeEscape: ownerBefore,
  supersedes: { original: '0xb3e609021C6839dF5A407d62D26Add74a2C8af54', reason: 'pool market terminal (status 4), order swept' },
}, null, 2) + '\n');
console.log(`  wrote script/s6.executed.json\n`);
