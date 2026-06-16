/* ─────────────────────────────────────────────────────────────
   MAXIMUS PRO · Service Worker
   Strategy:
     • App shell (index.html, manifest, icons): cache-first, network-revalidate
     • Google Fonts (CSS + woff2): stale-while-revalidate, long-cached
     • pdf-lib CDN: cache-first, ~1yr lifetime
     • Same-origin JSON exports: network-first w/ cache fallback
     • Everything else: network-first w/ cache fallback
   Bump CACHE_VERSION to force a refresh on all clients.
   ───────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'scwp-v6-2026-06-08-121';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const FONT_CACHE    = `${CACHE_VERSION}-fonts`;
const CDN_CACHE     = `${CACHE_VERSION}-cdn`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL = [
  '/index.html',          // '/' is served from this via navigationHandler — no need to cache the ~650KB doc twice
  '/manifest.webmanifest',
  '/cover.pdf',           // contract cover page — lazily fetched by the app, precached here for offline use
];

// CDN dependencies we must precache for offline use
const CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
];

// Google Fonts CSS — precache so first offline boot has type
const FONT_CSS = [
  'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700;800&family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@300;400;500;600&family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@300;400&display=swap',
];

// ────────────────────────────────────────────────────────────────
// Install — precache shell + CDN + font CSS
// ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(APP_SHELL.map((u) => new Request(u, { cache: 'reload' })));

    const cdn = await caches.open(CDN_CACHE);
    await Promise.all(CDN_PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors', cache: 'reload' });
        if (res.ok || res.type === 'opaque') await cdn.put(url, res.clone());
      } catch (e) { /* offline-friendly: skip on first install if offline */ }
    }));

    const fontCache = await caches.open(FONT_CACHE);
    await Promise.all(FONT_CSS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors', cache: 'reload' });
        if (res.ok) await fontCache.put(url, res.clone());
      } catch (e) {}
    }));

    // NOTE: intentionally NOT calling skipWaiting() — a new version installs quietly in the
    // background and only takes control on the NEXT cold launch (not mid-session). This avoids
    // a controller swap during an active session, which on iOS can re-trigger the camera
    // permission prompt and is generally disruptive. Updates still apply on next app open.
  })());
});

// ────────────────────────────────────────────────────────────────
// Activate — purge old caches + claim clients
// ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (!k.startsWith(CACHE_VERSION)) return caches.delete(k);
      return null;
    }));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    // NOTE: intentionally NOT calling clients.claim() — pair with the no-skipWaiting above so the
    // updated SW never seizes a live page mid-session; it controls cleanly from the next launch.
  })());
});

// ────────────────────────────────────────────────────────────────
// Fetch routing
// ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ── License endpoints & admin: NEVER cache, NEVER intercept ──
  // POST to /.netlify/functions/* must reach the server every time.
  // GET /admin.html must always be served fresh (not from SPA fallback).
  if (url.pathname.startsWith('/.netlify/functions/') ||
      url.pathname === '/admin' ||
      url.pathname === '/admin.html') {
    return; // Let the browser handle it directly
  }

  if (req.method !== 'GET') return;

  // ── Navigation requests → app-shell (SPA fallback) ──
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(event));
    return;
  }

  // ── Google Fonts stylesheets ──
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // ── Google Fonts files (woff2) ──
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // ── pdf-lib + other CDNs ──
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // ── Same-origin static assets (manifest, icons, sw, etc.) ──
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // ── Everything else: network-first w/ runtime cache ──
  event.respondWith(networkFirst(req, RUNTIME_CACHE));
});

// ────────────────────────────────────────────────────────────────
// Strategies
// ────────────────────────────────────────────────────────────────

async function navigationHandler(event) {
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      // Only cache a SUCCESSFUL navigation as the shell — never poison the offline
      // fallback with a transient 404/500 error page from the server.
      if (preload.ok) {
        const shell = await caches.open(SHELL_CACHE);
        shell.put('/index.html', preload.clone()).catch(() => {});
      }
      return preload;
    }
    const fresh = await fetch(event.request);
    if (fresh && fresh.ok) {
      const shell = await caches.open(SHELL_CACHE);
      shell.put('/index.html', fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    const cached = await caches.match('/index.html', { ignoreSearch: true });
    if (cached) return cached;
    return new Response(offlineFallbackHTML(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached || Response.error());
  return cached || fetchPromise;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(req, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    // Last-resort match across any cache
    const any = await caches.match(req);
    if (any) return any;
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────
// Offline fallback page (only shown if /index.html not yet cached)
// ────────────────────────────────────────────────────────────────
function offlineFallbackHTML() {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MAXIMUS PRO · Offline</title>
<style>
  body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
       background:#0B0B0F;color:#F5F5F0;display:flex;align-items:center;justify-content:center;
       min-height:100vh;text-align:center;padding:24px;}
  .wrap{max-width:420px;}
  .mark{font-size:18px;font-weight:700;letter-spacing:.32em;margin-bottom:6px;}
  .sub{font-style:italic;color:#D4B47A;font-family:Georgia,serif;font-size:14px;margin-bottom:32px;}
  h1{font-family:Georgia,serif;font-weight:500;font-size:28px;letter-spacing:-.02em;margin:0 0 12px;}
  p{color:#9A9AA2;font-size:14px;line-height:1.5;margin:0 0 24px;}
  button{background:#D4B47A;color:#0B0B0F;border:none;padding:14px 26px;border-radius:14px;
         font-size:14px;font-weight:600;cursor:pointer;letter-spacing:-.005em;}
  button:active{transform:scale(.97);}
</style></head><body>
<div class="wrap">
  <div class="mark">MAXIMUS</div>
  <div class="sub">Project Designer</div>
  <h1>You're offline.</h1>
  <p>The app couldn't load. Reconnect to download it once — after that it works fully offline.</p>
  <button onclick="location.reload()">Try again</button>
</div>
</body></html>`;
}
