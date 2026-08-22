// Dependency-free JSON-RPC — just fetch. Node 22 has global fetch.

export const SHANNON_RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';

let _id = 0;

export async function rpc(method, params = [], url = SHANNON_RPC) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message} (${json.error.code})`);
  return json.result;
}

export const getCode = (addr, url) => rpc('eth_getCode', [addr, 'latest'], url);
export const blockNumber = async (url) => parseInt(await rpc('eth_blockNumber', [], url), 16);

/** eth_call with no `from` (msg.sender == 0), returns 0x-hex. */
export const ethCall = (to, data, url) => rpc('eth_call', [{ to, data }, 'latest'], url);

/** ABI-encode a bare selector call with a single address arg. */
export function encAddr(selector, addr) {
  return selector + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}
