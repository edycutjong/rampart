// Dependency-free JSON-RPC — just fetch. Node 20+ has global fetch.
//
// BLOCK PINNING. Every read below goes through a single block tag, `BLOCK`,
// which defaults to 'latest' but can be pinned to a historical block with
// RAMPART_BLOCK=<n> (or --block <n>, parsed by the callers). Pinning matters
// because Shannon is a testnet: pools cycle, books empty, and a demo that reads
// 'latest' rots. Against an archive node, a pinned block reproduces the exact
// state the README quotes.
//
// PINNING THE CLOCK TOO. Pinning the block alone is NOT enough to reproduce a
// FIRM classification. `FirmQuote.unlockAt` is an immutable, so reading it at a
// historical block returns the same (possibly lapsed) value — and the scripts
// compare it against the wall clock. `now()` below therefore returns the PINNED
// BLOCK'S timestamp when pinned, and `Date.now()` otherwise, so the lock-window
// clause is evaluated in the same time frame as the state it is judging.

/** @typedef {{ jsonrpc: string, id: number, result?: any, error?: { message: string, code: number } }} RpcResponse */

export const SHANNON_RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';

const TIMEOUT_MS = Number(process.env.RAMPART_RPC_TIMEOUT_MS || 15000);
const RETRIES = Number(process.env.RAMPART_RPC_RETRIES || 2);

/** The block tag every read uses. 'latest' unless pinned. */
export let BLOCK = 'latest';

/** Pin (or unpin, with null) the block tag used by every read in this process. */
export function setBlock(tag) {
  _pinnedTsP = null; // the cached block timestamp belongs to the OLD pin
  if (tag === null || tag === undefined || tag === 'latest') { BLOCK = 'latest'; return BLOCK; }
  const n = typeof tag === 'string' && tag.startsWith('0x') ? parseInt(tag, 16) : Number(tag);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid block pin: ${tag}`);
  BLOCK = '0x' + n.toString(16);
  return BLOCK;
}

export const isPinned = () => BLOCK !== 'latest';

/** Resolve a --block flag / RAMPART_BLOCK env into the module block tag. */
export function pinFromArgs(argv = process.argv) {
  const i = argv.indexOf('--block');
  const raw = i >= 0 ? argv[i + 1] : process.env.RAMPART_BLOCK;
  if (raw) setBlock(raw);
  return BLOCK;
}

let _id = 0;

export async function rpc(method, params = [], url = SHANNON_RPC) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
      const json = /** @type {RpcResponse} */ (await res.json());
      if (json.error) {
        // A JSON-RPC application error is deterministic — retrying cannot help.
        throw Object.assign(new Error(`${method}: ${json.error.message} (${json.error.code})`), { fatal: true });
      }
      return json.result;
    } catch (e) {
      lastErr = e;
      if (e && /** @type {any} */ (e).fatal) throw e;
      if (attempt === RETRIES) break;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  const reason = lastErr && /** @type {any} */ (lastErr).name === 'AbortError'
    ? `timed out after ${TIMEOUT_MS}ms`
    : String(lastErr && /** @type {any} */ (lastErr).message || lastErr);
  throw new Error(`${method}: RPC failed after ${RETRIES + 1} attempt(s) — ${reason}`);
}

export const getCode = (addr, url) => rpc('eth_getCode', [addr, BLOCK], url);
export const blockNumber = async (url) => parseInt(await rpc('eth_blockNumber', [], url), 16);

/** eth_call with no `from` (msg.sender == 0), returns 0x-hex. */
export const ethCall = (to, data, url) => rpc('eth_call', [{ to, data }, BLOCK], url);

/** The block actually being read (resolves 'latest' to a number). */
export async function currentBlock(url) {
  if (isPinned()) return parseInt(BLOCK, 16);
  return blockNumber(url);
}

/**
 * Cached as a PROMISE, not a value: `now()` is called once per owner inside a
 * loop, so a value-cache would race (read null → await → several concurrent
 * callers each fire the RPC). Caching the in-flight promise makes it exactly one
 * request per pinned run, and keeps the read-modify-write off the await boundary.
 * @type {Promise<number> | null}
 */
let _pinnedTsP = null;

/**
 * Seconds-since-epoch to evaluate lock windows against.
 *
 * Pinned  → the pinned block's own `timestamp` (one extra RPC per run).
 * Unpinned → wall clock.
 *
 * This is what makes `--block` actually restore a FIRM classification: without
 * it the lock clause would compare a historical `unlockAt` against today, and no
 * amount of block pinning would ever flip a lapsed quote back to FIRM.
 */
export function now(url) {
  if (!isPinned()) return Promise.resolve(Math.floor(Date.now() / 1000));
  if (!_pinnedTsP) {
    _pinnedTsP = (async () => {
      const blk = await rpc('eth_getBlockByNumber', [BLOCK, false], url);
      if (!blk || !blk.timestamp) throw new Error(`block ${BLOCK} not available (archive node required for pinning)`);
      return parseInt(blk.timestamp, 16);
    })();
  }
  return _pinnedTsP;
}

/**
 * Refuse to run pinned against a block where the target has no code.
 *
 * Unguarded this is the worst kind of failure: every contract owner reads as an
 * EOA, the corpus scores 1/8 or 2/8, and it looks like the CLASSIFIER is broken
 * when in fact the state never arrived. There are two distinct causes and the
 * message must not conflate them (an earlier version of this guard did, and
 * blamed a pruned node for what was really a too-early block):
 *
 *   a) the block PREDATES the contract's deployment — pin a later block;
 *   b) the node prunes historical state — use an archive RPC.
 *
 * We tell them apart with a reference contract that has existed far longer than
 * the target (the pool). If the reference has code and the target does not, the
 * node is archival and the block is simply too early.
 *
 * Somnia's public endpoint IS archival, verified 2026-08-26: `eth_getCode` at
 * block 468 184 998 returns real runtime bytecode.
 *
 * No-op when unpinned.
 */
export async function assertPinnedStateAvailable(knownContract, referenceContract, url) {
  if (!isPinned()) return;
  const code = await getCode(knownContract, url);
  if (code && code !== '0x') return;

  const n = parseInt(BLOCK, 16);
  let archival = null;
  if (referenceContract) {
    const ref = await getCode(referenceContract, url);
    archival = !!(ref && ref !== '0x');
  }

  if (archival === true) {
    throw new Error(
      `${knownContract} has no code at block ${n} — the block PREDATES its deployment.\n` +
      `  (The node is archival: the reference contract ${referenceContract} does have code there,\n` +
      `  so historical state is being served correctly.) Pin a LATER block.`,
    );
  }
  throw new Error(
    `${knownContract} has no code at block ${n}, and neither does the reference contract.\n` +
    `  Either the block predates the whole deployment, or this RPC prunes historical state.\n` +
    `  Point SOMNIA_TESTNET_RPC at an archive node, pin a later block, or drop --block.`,
  );
}

/** ABI-encode a bare selector call with a single address arg. */
export function encAddr(selector, addr) {
  return selector + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
