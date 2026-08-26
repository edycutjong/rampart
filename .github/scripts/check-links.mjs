// Verify every local asset a page references actually exists, relative to that page.
//
// A GitHub Pages artifact is a flat upload of one directory: a relative path that
// resolved on a laptop but escapes the published root renders as a broken image on
// the one surface judges look at. Nothing else in CI sees that.
//
// Usage: node .github/scripts/check-links.mjs <root>

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'site');
const ASSET = /\.(png|svg|jpe?g|webp|gif|css|js|mjs|ico|woff2?)$/i;
const REF = /(?:src|href)\s*=\s*"([^"]+)"/gi;

/** Every .html under root, recursively. */
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? pages(p) : e.name.endsWith('.html') ? [p] : [];
  });
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`::error::${root} is not a directory`);
  process.exit(1);
}

let checked = 0;
const bad = [];
const warn = [];

for (const page of pages(root)) {
  const html = readFileSync(page, 'utf8');
  for (const [, raw] of html.matchAll(REF)) {
    // Skip anchors, absolute URLs, protocol-relative, data: and mailto:.
    if (/^(#|[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    const path = raw.split(/[?#]/)[0];
    if (!path || !ASSET.test(path)) continue;

    checked++;
    const target = resolve(dirname(page), path);
    const rel = relative(root, page);

    if (path.startsWith('/')) {
      // Under the custom domain (site/CNAME → rampart.edycu.dev) the site serves at
      // the root, so a root-absolute path does resolve. It would break on the bare
      // github.io fallback, which serves under /<repo>/. Relative paths work on both,
      // so this is a portability warning rather than a failure.
      warn.push(`${rel} → "${raw}" is root-absolute; it breaks on the github.io fallback URL. Prefer a relative path.`);
    } else if (relative(root, target).startsWith('..' + sep)) {
      bad.push(`${rel} → "${raw}" escapes the published root and will not be uploaded`);
    } else if (!existsSync(target)) {
      bad.push(`${rel} → "${raw}" does not exist`);
    }
  }
}

for (const w of warn) console.log(`::warning::${w}`);

if (bad.length) {
  for (const b of bad) console.error(`::error::${b}`);
  console.error(`\n${bad.length} broken reference(s) of ${checked} checked`);
  process.exit(1);
}
console.log(`all ${checked} local asset references resolve under ${relative(process.cwd(), root) || '.'}`);
