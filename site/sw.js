// rampart — service worker.
//
// Purpose: a judge who has opened this site once can still open it on a plane. It does
// NOT make a first visit work offline; nothing can. A cold browser with no network has
// no copy of anything.
//
// SAFETY, because a service worker on a judged surface is a way to serve stale work:
//
//   1. Navigations are NETWORK-FIRST. An online visitor always gets the deployed HTML;
//      the cache is only consulted when the network actually fails. A cache-first shell
//      would be faster and would risk showing a judge yesterday's page. Not a trade
//      worth making here.
//   2. Assets are stale-while-revalidate: served instantly, refreshed in the background,
//      so a redeploy self-heals on the next load without needing a version bump.
//   3. Only same-origin GET is touched. The viewer's eth_call POSTs to Somnia's RPC pass
//      straight through — caching a chain read would be a correctness bug, not a
//      performance win.
//   4. Bumping CACHE purges every older cache on activate, and skipWaiting +
//      clients.claim mean a new deploy takes over on the next load rather than waiting
//      for every tab to close.
//
// Kill switch: replacing this file's body with `self.registration.unregister()` removes
// it from every client on their next visit.

const CACHE = 'rampart-v1';

// The shell: enough to render each page offline. Everything else arrives via
// stale-while-revalidate on first visit.
const PRECACHE = [
  './',
  './index.html',
  './viewer/',
  './viewer/index.html',
  './pitch/',
  './pitch/index.html',
  './assets/icon.svg',
  './assets/icon-animated.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, not addAll: addAll rejects the whole install if ONE entry 404s,
    // which would leave the site with no worker at all over a single renamed file.
    await Promise.all(PRECACHE.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // RPC POSTs pass through
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // explorer, YouTube, shields.io

  // Navigations: network first, cache only as a fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match(req))
          || (await cache.match(new URL('./index.html', url).href))
          || (await cache.match('./'))
          || new Response('Offline, and this page was never cached.',
               { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  // Assets: serve the cached copy at once, refresh it behind the request.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return hit || (await network) || new Response('', { status: 504 });
  })());
});
