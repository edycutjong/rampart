#!/usr/bin/env node
// DEV UTILITY — find a currently-active binary pool to point the live scripts at.
//
// Shannon markets expire on a fixed interval, so the pool address baked into
// firmness.mjs/bench.mjs goes cold within ~24h. This queries the Somnia markets
// subgraph for markets with real headroom and prints a CANDIDATE POOL to pass as
// `--pool`. Not part of the judged path; no assertions, no gate.
//
//   node script/find-pool.mjs

/** @param {string} query @returns {Promise<any>} the raw GraphQL envelope */
const q = async (query) => (await (await fetch("https://dev.smk.somnia.host/v1/graphql", {
  method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({query})})).json());
const e = await q(`{ __type(name:"markettype"){ enumValues { name } } }`);
console.log("marketType enum:", (e.data?.__type?.enumValues||[]).map(v=>v.name).join(" ") || "(introspect failed)");
const s = await q(`{ __type(name:"clobstatus"){ enumValues { name } } }`);
console.log("clobStatus enum:", (s.data?.__type?.enumValues||[]).map(v=>v.name).join(" ") || "(n/a)");
const r = await q(`{ Market(order_by:{expiry:desc}, limit:12)
 { marketId binaryPoolAddress asset intervalSec clobStatus expiry venueId tickSize lotSize minQuantity collateral quoteDecimals marketType } }`);
if (r.errors) { console.log("ERR", r.errors[0].message); process.exit(1); }
const now = Math.floor(Date.now()/1000);
const rows = r.data.Market.filter(m => m.binaryPoolAddress);
console.log("\n" + rows.length + " markets with a binary pool:\n");
for (const m of rows) {
  const raw = Number(m.expiry); const exp = raw > 1e12 ? Math.floor(raw/1e9) : raw;
  const left = exp - now;
  console.log([m.asset||"?", (m.intervalSec||"?")+"s", m.marketType, "status="+m.clobStatus,
               "headroom="+(left>0?left+"s":"EXPIRED"), m.binaryPoolAddress].join("  "));
}
const live = rows.filter(m => { const raw=Number(m.expiry); const x = raw>1e12?Math.floor(raw/1e9):raw; return x-now > 900; });
console.log("\n>15min headroom: " + live.length);
if (live[0]) { const m=live[0];
  console.log("CANDIDATE POOL:", m.binaryPoolAddress, "|", m.asset, m.intervalSec+"s",
              "| tick", m.tickSize, "| lot", m.lotSize, "| minQty", m.minQuantity,
              "| collateral", m.collateral, "dp", m.quoteDecimals); }
